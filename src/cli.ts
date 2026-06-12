#!/usr/bin/env node

import { realpathSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { attributeUsageToCommits } from './attribution-engine.js';
import { renderPrComment, type RenderAuthorInput } from './comment-renderer.js';
import { defaultCommandRunner, resolvePullRequest } from './git-resolver.js';
import { ensureGhReady, upsertPrComment } from './github-poster.js';
import { priceAttributionResult, type PricedAttributionBucket, type PricedAttributionResult } from './pricing.js';
import { readClaudeTranscripts, type TranscriptDiagnostics } from './transcript-reader.js';

export interface CliDeps {
  cwd: string;
  stdout(message: string): void;
  stderr(message: string): void;
  readClaudeTranscripts: typeof readClaudeTranscripts;
  resolvePullRequest: typeof resolvePullRequest;
  ensureGhReady: typeof ensureGhReady;
  upsertPrComment: typeof upsertPrComment;
}

interface CliFlags {
  dryRun: boolean;
  json: boolean;
  verbose: boolean;
  prNumber?: number;
}

const noTranscriptsMessage = 'No Claude Code transcripts found for this repo.';
const ghSetupMessage = 'Install GitHub CLI and run gh auth login.';

export async function runCli(argv: string[], deps: Partial<CliDeps> = {}): Promise<number> {
  const cliDeps = withDefaultDeps(deps);
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

  const transcripts = await cliDeps.readClaudeTranscripts({ repoRoot: cliDeps.cwd });
  if (flags.verbose) {
    printDiagnostics(transcripts.diagnostics, cliDeps.stderr);
  }

  if (transcripts.events.length === 0) {
    cliDeps.stdout(noTranscriptsMessage);
    return 0;
  }

  const attribution = attributeUsageToCommits({
    events: transcripts.events,
    commits: resolvedPr.commits,
    branch: resolvedPr.branch,
  });
  const priced = priceAttributionResult(attribution);
  const markdown = renderPrComment({ currentAuthor: toRenderAuthorInput(priced, resolvedPr.pr.authorLogin) });

  if (flags.dryRun) {
    cliDeps.stdout(markdown);
    return 0;
  }

  if (flags.json) {
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
        diagnostics: transcripts.diagnostics,
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
    markdown,
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
  return {
    cwd: deps.cwd ?? process.cwd(),
    stdout: deps.stdout ?? ((message) => console.log(message)),
    stderr: deps.stderr ?? ((message) => console.error(message)),
    readClaudeTranscripts: deps.readClaudeTranscripts ?? readClaudeTranscripts,
    resolvePullRequest: deps.resolvePullRequest ?? resolvePullRequest,
    ensureGhReady: deps.ensureGhReady ?? ensureGhReady,
    upsertPrComment: deps.upsertPrComment ?? upsertPrComment,
  };
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

function printDiagnostics(diagnostics: TranscriptDiagnostics, stderr: (message: string) => void): void {
  stderr(`malformed-line-count: ${diagnostics.malformedLineCount}`);
  stderr(`skipped-line-count: ${diagnostics.skippedLineCount}`);
  stderr(`dedupe-count: ${diagnostics.dedupedEventCount}`);
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

function toRenderAuthorInput(priced: PricedAttributionResult, authorLogin: string): RenderAuthorInput {
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
    attributedPercent: priced.coverage.attributedPercent,
    lowConfidencePercent: priced.coverage.lowConfidencePercent,
    rows,
  };
}

function allPricedBuckets(priced: PricedAttributionResult): PricedAttributionBucket[] {
  return priced.uncommittedTail === undefined ? priced.buckets : [...priced.buckets, priced.uncommittedTail];
}
