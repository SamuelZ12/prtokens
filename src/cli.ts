#!/usr/bin/env node

import { realpathSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { attributeUsageToCommits } from './attribution-engine.js';
import { renderPrComment, type RenderAuthorInput } from './comment-renderer.js';
import { defaultCommandRunner, resolvePullRequest } from './git-resolver.js';
import { ensureGhReady, upsertPrComment } from './github-poster.js';
import {
  createDefaultHookInstallerDeps,
  installGlobalPrePushHook,
  runPreflight,
  type CoreHooksPathAction,
  type HookAction,
  type InstallOptions,
  type InstallResult,
  type PreflightCheck,
  type PreflightResult,
} from './hook-installer.js';
import { priceAttributionResult, type PricedAttributionBucket, type PricedAttributionResult } from './pricing.js';
import { readAllUsage, type UsageDiagnostics } from './usage-readers.js';
import type { AgentName, CommitRecord, UsageEvent } from './types.js';

type AgentSummary = NonNullable<RenderAuthorInput['agents']>[number];

export interface CliDeps {
  cwd: string;
  stdout(message: string): void;
  stderr(message: string): void;
  readAllUsage: typeof readAllUsage;
  resolvePullRequest: typeof resolvePullRequest;
  ensureGhReady: typeof ensureGhReady;
  upsertPrComment: typeof upsertPrComment;
  runPreflight: () => PreflightResult;
  installGlobalPrePushHook: (options?: InstallOptions) => InstallResult;
}

interface CliFlags {
  dryRun: boolean;
  json: boolean;
  verbose: boolean;
  prNumber?: number;
}

const noUsageMessage = 'No coding-agent usage found for this repo (checked Claude Code, Codex, OpenCode).';
const ghSetupMessage = 'Install GitHub CLI and run gh auth login.';

export async function runCli(argv: string[], deps: Partial<CliDeps> = {}): Promise<number> {
  const cliDeps = withDefaultDeps(deps);
  if (argv[0] === 'init') {
    return runInit(argv.slice(1), cliDeps);
  }

  const flags = parseCliFlags(argv, cliDeps.stderr);
  if (flags === undefined) {
    return 1;
  }

  let resolvedPr;
  try {
    resolvedPr = await cliDeps.resolvePullRequest({
      cwd: cliDeps.cwd,
      ...(flags.prNumber === undefined ? {} : { prNumber: flags.prNumber }),
    });
  } catch (error) {
    if (isGhSetupError(error)) {
      cliDeps.stderr(ghSetupMessage);
      return 1;
    }

    throw error;
  }
  if (resolvedPr.kind === 'no-pr') {
    cliDeps.stdout(resolvedPr.message);
    return 0;
  }

  const usage = await cliDeps.readAllUsage({ repoRoot: cliDeps.cwd });
  if (flags.verbose) {
    printDiagnostics(usage.diagnostics, cliDeps.stderr);
  }

  if (usage.events.length === 0) {
    cliDeps.stdout(noUsageMessage);
    return 0;
  }

  const attribution = attributeUsageToCommits({
    events: usage.events,
    commits: resolvedPr.commits,
    branch: resolvedPr.branch,
  });
  const priced = priceAttributionResult(attribution);
  const agentTotals = toAgentSummaries(usage.events, resolvedPr.commits, resolvedPr.branch);
  const currentAuthor = toRenderAuthorInput(priced, resolvedPr.pr.currentUserLogin ?? resolvedPr.pr.authorLogin, agentTotals);
  const renderMarkdown = (existingBody?: string) => renderPrComment({ existingBody, currentAuthor });

  if (flags.dryRun) {
    const markdown = renderMarkdown();
    cliDeps.stdout(markdown);
    return 0;
  }

  if (flags.json) {
    const markdown = renderMarkdown();
    cliDeps.stdout(
      JSON.stringify({
        pr: resolvedPr.pr,
        attribution,
        pricing: {
          totalCostUsd: priced.totalCostUsd,
          warnings: priced.warnings ?? [],
          buckets: priced.buckets,
          uncommittedTail: priced.uncommittedTail,
        },
        agentTotals,
        diagnostics: usage.diagnostics,
        markdown,
      }),
    );
    return 0;
  }

  const ghReady = await cliDeps.ensureGhReady(defaultCommandRunner);
  if (!ghReady.ok) {
    cliDeps.stderr(ghReady.message);
    return 1;
  }

  const postResult = await cliDeps.upsertPrComment({
    runner: defaultCommandRunner,
    repository: resolvedPr.pr.repository,
    prNumber: resolvedPr.pr.number,
    renderMarkdown,
  });
  if (!postResult.ok) {
    cliDeps.stdout(postResult.renderedMarkdown);
  }

  return 0;
}

export async function main(): Promise<number> {
  return runCli(process.argv.slice(2));
}

export function isEntrypoint(moduleUrl: string, entrypointPath: string | undefined): boolean {
  return entrypointPath !== undefined && realpathSync(fileURLToPath(moduleUrl)) === realpathSync(entrypointPath);
}

if (isEntrypoint(import.meta.url, process.argv[1])) {
  main()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error: unknown) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    });
}

function withDefaultDeps(deps: Partial<CliDeps>): CliDeps {
  const hookInstallerDeps = createDefaultHookInstallerDeps(resolvePrtokensBinPath());
  return {
    cwd: deps.cwd ?? process.cwd(),
    stdout: deps.stdout ?? ((message) => console.log(message)),
    stderr: deps.stderr ?? ((message) => console.error(message)),
    readAllUsage: deps.readAllUsage ?? readAllUsage,
    resolvePullRequest: deps.resolvePullRequest ?? resolvePullRequest,
    ensureGhReady: deps.ensureGhReady ?? ensureGhReady,
    upsertPrComment: deps.upsertPrComment ?? upsertPrComment,
    runPreflight: deps.runPreflight ?? (() => runPreflight(hookInstallerDeps)),
    installGlobalPrePushHook: deps.installGlobalPrePushHook ?? ((options) => installGlobalPrePushHook(hookInstallerDeps, options)),
  };
}

function resolvePrtokensBinPath(): string {
  const entrypointPath = process.argv[1] ?? 'prtokens';
  try {
    return realpathSync(entrypointPath);
  } catch {
    return entrypointPath;
  }
}

function runInit(argv: string[], deps: CliDeps): number {
  const flags = parseInitFlags(argv, deps.stderr);
  if (flags === undefined) {
    return 1;
  }

  const install = deps.installGlobalPrePushHook({ dryRun: flags.dryRun });
  const preflight = deps.runPreflight();
  if (!install.ok) {
    deps.stderr(`Failed to install pre-push hook at ${install.hookPath}: ${install.error ?? 'unknown error'}`);
    return 1;
  }

  deps.stdout(formatInitResult(install, preflight));
  return 0;
}

function parseInitFlags(argv: string[], stderr: (message: string) => void): { dryRun: boolean } | undefined {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: false,
      strict: true,
      options: {
        'dry-run': { type: 'boolean' },
      },
    });
  } catch (error) {
    stderr(error instanceof Error ? error.message : String(error));
    return undefined;
  }

  return { dryRun: parsed.values['dry-run'] === true };
}

function formatInitResult(install: InstallResult, preflight: PreflightResult): string {
  const lines = [
    install.dryRun ? 'prtokens init dry run' : 'prtokens init complete',
    formatHookAction(install.hookAction, install.hookPath, install.dryRun),
    formatCoreHooksPathAction(install.coreHooksPathAction, install.hooksDir),
    'Prerequisites:',
    ...preflight.checks.map(formatPreflightCheck),
    'Push a branch that has an open PR and prtokens will comment.',
  ];

  if (install.dryRun) {
    lines.push('Hook body:', install.hookBody);
  }

  return lines.join('\n');
}

function formatHookAction(action: HookAction, hookPath: string, dryRun: boolean): string {
  const verb = formatHookActionVerb(action, dryRun);
  return dryRun ? `${verb} hook at ${hookPath}` : `Hook: ${verb} at ${hookPath}`;
}

function formatHookActionVerb(action: HookAction, dryRun: boolean): string {
  switch (action) {
    case 'installed':
      return dryRun ? 'Would install' : 'installed';
    case 'updated-existing-block':
      return dryRun ? 'Would update existing prtokens block in' : 'updated existing prtokens block in';
    case 'appended-to-existing-hook':
      return dryRun ? 'Would append prtokens block to existing' : 'appended prtokens block to existing';
    case 'already-up-to-date':
      return dryRun ? 'Would leave up-to-date' : 'already up to date';
  }
}

function formatCoreHooksPathAction(action: CoreHooksPathAction, hooksDir: string): string {
  switch (action) {
    case 'set':
      return `core.hooksPath: set to ${hooksDir}`;
    case 'respected':
      return `core.hooksPath: respected existing ${hooksDir}`;
    case 'would-set':
      return `core.hooksPath: would set to ${hooksDir}`;
    case 'would-respect':
      return `core.hooksPath: would respect existing ${hooksDir}`;
  }
}

function formatPreflightCheck(check: PreflightCheck): string {
  return `- ${check.name}: ${check.status} - ${check.message}${check.hint === undefined ? '' : ` ${check.hint}`}`;
}

function parseCliFlags(argv: string[], stderr: (message: string) => void): CliFlags | undefined {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: false,
      strict: true,
      options: {
        'dry-run': { type: 'boolean' },
        json: { type: 'boolean' },
        verbose: { type: 'boolean' },
        pr: { type: 'string' },
      },
    });
  } catch (error) {
    stderr(error instanceof Error ? error.message : String(error));
    return undefined;
  }

  const prValue = parsed.values.pr;
  if (prValue !== undefined) {
    const prNumber = Number(prValue);
    if (!Number.isInteger(prNumber) || prNumber <= 0) {
      stderr('--pr must be a positive integer.');
      return undefined;
    }
    return {
      dryRun: parsed.values['dry-run'] === true,
      json: parsed.values.json === true,
      verbose: parsed.values.verbose === true,
      prNumber,
    };
  }

  return {
    dryRun: parsed.values['dry-run'] === true,
    json: parsed.values.json === true,
    verbose: parsed.values.verbose === true,
  };
}

function printDiagnostics(diagnostics: UsageDiagnostics, stderr: (message: string) => void): void {
  const agents = ['claude-code', 'codex', 'opencode'] satisfies AgentName[];

  for (const agent of agents) {
    const source = diagnostics[agent];
    stderr(`${agent}: scanned-file-count: ${source.scannedFileCount}`);
    stderr(`${agent}: malformed-line-count: ${source.malformedLineCount}`);
    stderr(`${agent}: skipped-line-count: ${source.skippedLineCount}`);
    stderr(`${agent}: dedupe-count: ${source.dedupedEventCount}`);
    for (const warning of source.warningMessages) {
      stderr(`${agent}: ${warning}`);
    }
  }
}

function isGhSetupError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : '';
  const stderr = typeof error === 'object' && error !== null && 'stderr' in error ? String(error.stderr) : '';
  const detail = `${message}\n${stderr}`.toLowerCase();

  return (
    detail.includes('spawn gh enoent') ||
    detail.includes('gh: command not found') ||
    detail.includes('gh auth login') ||
    detail.includes('authentication required')
  );
}

function toRenderAuthorInput(
  priced: PricedAttributionResult,
  authorLogin: string,
  agents?: RenderAuthorInput['agents'],
): RenderAuthorInput {
  const rows = allPricedBuckets(priced).map((bucket) => ({
    sha: bucket.commitSha ?? 'uncommitted',
    message: bucket.message ?? bucket.label ?? '',
    inputTokens: bucket.inputTokens,
    outputTokens: bucket.outputTokens,
    costUsd: bucket.costUsd,
    sessionCount: bucket.sessionCount,
  }));

  return {
    login: authorLogin,
    totalCostUsd: priced.totalCostUsd,
    inputTokens: priced.totals.inputTokens,
    outputTokens: priced.totals.outputTokens,
    cacheWriteTokens: priced.totals.cacheWriteTokens,
    cacheReadTokens: priced.totals.cacheReadTokens,
    sessionCount: priced.totals.sessionCount,
    models: [...new Set(allPricedBuckets(priced).flatMap((bucket) => bucket.models))],
    ...(agents === undefined ? {} : { agents }),
    attributedPercent: priced.coverage.attributedPercent,
    lowConfidencePercent: priced.coverage.lowConfidencePercent,
    rows,
  };
}

function toAgentSummaries(events: UsageEvent[], commits: CommitRecord[], branch: string): AgentSummary[] {
  const agents = ['claude-code', 'codex', 'opencode'] satisfies AgentName[];
  const summaries: AgentSummary[] = [];

  for (const agent of agents) {
    const agentEvents = events.filter((event) => event.agent === agent);
    if (agentEvents.length === 0) continue;

    const attribution = attributeUsageToCommits({ events: agentEvents, commits, branch });
    const priced = priceAttributionResult(attribution);
    if (priced.totals.attributedEventCount === 0) continue;

    summaries.push({
      agent,
      costUsd: priced.totalCostUsd,
      inputTokens: priced.totals.inputTokens,
      outputTokens: priced.totals.outputTokens,
      sessionCount: priced.totals.sessionCount,
    });
  }

  return summaries.sort((left, right) => right.costUsd - left.costUsd);
}

function allPricedBuckets(priced: PricedAttributionResult): PricedAttributionBucket[] {
  return priced.uncommittedTail === undefined ? priced.buckets : [...priced.buckets, priced.uncommittedTail];
}
