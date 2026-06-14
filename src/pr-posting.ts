import { attributeUsageToCommits } from './attribution-engine.js';
import { renderPrComment, type RenderAuthorInput } from './comment-renderer.js';
import { defaultCommandRunner, resolvePullRequest, type CommandRunner } from './git-resolver.js';
import { ensureGhReady, upsertPrComment } from './github-poster.js';
import { priceAttributionResult, type PricedAttributionBucket, type PricedAttributionResult } from './pricing.js';
import { readAllUsage, type UsageDiagnostics } from './usage-readers.js';
import type { AgentName, CommitRecord, UsageEvent } from './types.js';

type AgentSummary = NonNullable<RenderAuthorInput['agents']>[number];

export const noUsageMessage = 'No coding-agent usage found for this repo (checked Claude Code, Codex, OpenCode).';
export const ghSetupMessage = 'Install GitHub CLI and run gh auth login.';

export type PostPrtokensResult =
  | { kind: 'posted'; prNumber: number; repository: string; commentUrl?: string }
  | { kind: 'dry-run'; markdown: string }
  | { kind: 'json'; payload: string }
  | { kind: 'no-pr'; branch: string; message: string }
  | { kind: 'no-usage'; message: string }
  | { kind: 'gh-not-ready'; message: string }
  | { kind: 'post-failed'; renderedMarkdown: string; error: string };

export interface PostPrtokensOptions {
  cwd: string;
  dryRun: boolean;
  json: boolean;
  verbose: boolean;
  prNumber?: number;
  stdout(message: string): void;
  stderr(message: string): void;
  readAllUsage: typeof readAllUsage;
  resolvePullRequest: typeof resolvePullRequest;
  ensureGhReady: typeof ensureGhReady;
  upsertPrComment: typeof upsertPrComment;
  runner?: CommandRunner;
}

export async function postPrtokensForCurrentRepo(options: PostPrtokensOptions): Promise<PostPrtokensResult> {
  const runner = options.runner ?? defaultCommandRunner;
  let resolvedPr;
  try {
    resolvedPr = await options.resolvePullRequest({
      cwd: options.cwd,
      ...(options.prNumber === undefined ? {} : { prNumber: options.prNumber }),
      ...(options.runner === undefined ? {} : { runner }),
    });
  } catch (error) {
    if (isGhSetupError(error)) {
      return { kind: 'gh-not-ready', message: ghSetupMessage };
    }

    throw error;
  }

  if (resolvedPr.kind === 'no-pr') {
    return { kind: 'no-pr', branch: resolvedPr.branch, message: resolvedPr.message };
  }

  const usage = await options.readAllUsage({
    repoRoot: resolvedPr.repoRoot,
    repoRootAliases: resolvedPr.worktreeRoots,
  });
  if (options.verbose) {
    printDiagnostics(usage.diagnostics, options.stderr);
  }

  if (usage.events.length === 0) {
    return { kind: 'no-usage', message: noUsageMessage };
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

  if (options.dryRun) {
    return { kind: 'dry-run', markdown: renderMarkdown() };
  }

  if (options.json) {
    return {
      kind: 'json',
      payload: JSON.stringify({
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
        markdown: renderMarkdown(),
      }),
    };
  }

  const ghReady = await options.ensureGhReady(runner);
  if (!ghReady.ok) {
    return { kind: 'gh-not-ready', message: ghReady.message };
  }

  const postResult = await options.upsertPrComment({
    runner,
    repository: resolvedPr.pr.repository,
    prNumber: resolvedPr.pr.number,
    renderMarkdown,
  });
  if (!postResult.ok) {
    return { kind: 'post-failed', renderedMarkdown: postResult.renderedMarkdown, error: postResult.error };
  }

  return {
    kind: 'posted',
    prNumber: resolvedPr.pr.number,
    repository: resolvedPr.pr.repository,
    ...(postResult.commentUrl === undefined ? {} : { commentUrl: postResult.commentUrl }),
  };
}

export function printPostResult(result: PostPrtokensResult, stdout: (message: string) => void, stderr: (message: string) => void): number {
  switch (result.kind) {
    case 'posted':
      return 0;
    case 'dry-run':
      stdout(result.markdown);
      return 0;
    case 'json':
      stdout(result.payload);
      return 0;
    case 'no-pr':
      stdout(result.message);
      return 0;
    case 'no-usage':
      stdout(result.message);
      return 0;
    case 'gh-not-ready':
      stderr(result.message);
      return 1;
    case 'post-failed':
      stdout(result.renderedMarkdown);
      return 0;
  }
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

function toRenderAuthorInput(
  priced: PricedAttributionResult,
  authorLogin: string,
  agents?: RenderAuthorInput['agents'],
): RenderAuthorInput {
  const rows = allPricedBuckets(priced).map((bucket) => ({
    sha: bucket.commitSha ?? bucket.label ?? 'uncommitted',
    message: bucket.message ?? bucket.label ?? '',
    inputTokens: bucket.inputTokens,
    outputTokens: bucket.outputTokens,
    cacheWriteTokens: bucket.cacheWriteTokens,
    cacheReadTokens: bucket.cacheReadTokens,
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
  return priced.buckets;
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
