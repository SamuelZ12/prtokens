#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { resolvePullRequest } from './git-resolver.js';
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
import { defaultQueuePath, enqueuePendingPr, formatQueueStatus, makePendingPrJobId, mergePendingQueue, readPendingQueue, scrubPendingQueue, withPendingQueueProcessLock, writePendingQueue, type PendingPrJob, type PendingPrQueue } from './pending-pr-queue.js';
import { processPendingPrJobs, remoteHeadNotReachedResult } from './pending-pr-worker.js';
import { ghSetupMessage, postPrtokensForCurrentRepo, printPostResult } from './pr-posting.js';
import { readAllUsage } from './usage-readers.js';

const queueRetryWindowMs = 30 * 60_000;
const queueRetentionMs = 24 * 60 * 60_000;
const defaultQueueRetryDelayMs = 30_000;
const staleRemoteHeadQueueRetryDelayMs = 1_000;
const defaultQueueProcessMaxPasses = Math.ceil(queueRetryWindowMs / Math.min(defaultQueueRetryDelayMs, staleRemoteHeadQueueRetryDelayMs));

export interface CliDeps {
  cwd: string;
  stdout(message: string): void;
  stderr(message: string): void;
  readAllUsage: typeof readAllUsage;
  resolvePullRequest: typeof resolvePullRequest;
  ensureGhReady: typeof ensureGhReady;
  upsertPrComment: typeof upsertPrComment;
  runGhPrCreate(args: string[]): Promise<number>;
  runGitLsRemote(cwd: string, remoteName: string, remoteRef: string): Promise<string | undefined>;
  runPreflight: () => PreflightResult;
  installGlobalPrePushHook: (options?: InstallOptions) => InstallResult;
  queuePath: string;
  readPendingQueue: typeof readPendingQueue;
  scrubPendingQueue: typeof scrubPendingQueue;
  writePendingQueue: typeof writePendingQueue;
  mergePendingQueue: typeof mergePendingQueue;
  enqueuePendingPr: typeof enqueuePendingPr;
  processPendingPrJobs: typeof processPendingPrJobs;
  withPendingQueueProcessLock: typeof withPendingQueueProcessLock;
  now(): Date;
  sleep(ms: number): Promise<void>;
  queueRetryDelayMs: number;
  queueProcessMaxPasses: number;
}

interface CliFlags {
  dryRun: boolean;
  json: boolean;
  verbose: boolean;
  prNumber?: number;
}

export async function runCli(argv: string[], deps: Partial<CliDeps> = {}): Promise<number> {
  const cliDeps = withDefaultDeps(deps);
  if (argv[0] === 'init') {
    return runInit(argv.slice(1), cliDeps);
  }

  if (argv[0] === 'pr' && argv[1] === 'create') {
    return runPrCreate(argv.slice(2), cliDeps);
  }

  if (argv[0] === 'status') {
    const queue = cliDeps.scrubPendingQueue(cliDeps.queuePath);
    cliDeps.stdout(formatQueueStatus(queue, cliDeps.now()));
    return 0;
  }

  if (argv[0] === '__hook-pushed-ref') {
    return runHookPushedRef(argv.slice(1), cliDeps);
  }

  if (argv[0] === '__process-queue') {
    return runProcessQueue(cliDeps);
  }

  const flags = parseCliFlags(argv, cliDeps.stderr);
  if (flags === undefined) {
    return 1;
  }

  try {
    const result = await postPrtokensForCurrentRepo({
      cwd: cliDeps.cwd,
      dryRun: flags.dryRun,
      json: flags.json,
      verbose: flags.verbose,
      ...(flags.prNumber === undefined ? {} : { prNumber: flags.prNumber }),
      stdout: cliDeps.stdout,
      stderr: cliDeps.stderr,
      readAllUsage: cliDeps.readAllUsage,
      resolvePullRequest: cliDeps.resolvePullRequest,
      ensureGhReady: cliDeps.ensureGhReady,
      upsertPrComment: cliDeps.upsertPrComment,
    });
    return printPostResult(result, cliDeps.stdout, cliDeps.stderr);
  } catch (error) {
    if (isGhSetupError(error)) {
      cliDeps.stderr(ghSetupMessage);
      return 1;
    }

    throw error;
  }
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
    runGhPrCreate: deps.runGhPrCreate ?? runGhPrCreate,
    runGitLsRemote: deps.runGitLsRemote ?? runGitLsRemote,
    runPreflight: deps.runPreflight ?? (() => runPreflight(hookInstallerDeps)),
    installGlobalPrePushHook: deps.installGlobalPrePushHook ?? ((options) => installGlobalPrePushHook(hookInstallerDeps, options)),
    queuePath: deps.queuePath ?? defaultQueuePath(process.env),
    readPendingQueue: deps.readPendingQueue ?? readPendingQueue,
    scrubPendingQueue: deps.scrubPendingQueue ?? scrubPendingQueue,
    writePendingQueue: deps.writePendingQueue ?? writePendingQueue,
    mergePendingQueue: deps.mergePendingQueue ?? mergePendingQueue,
    enqueuePendingPr: deps.enqueuePendingPr ?? enqueuePendingPr,
    processPendingPrJobs: deps.processPendingPrJobs ?? processPendingPrJobs,
    withPendingQueueProcessLock: deps.withPendingQueueProcessLock ?? withPendingQueueProcessLock,
    now: deps.now ?? (() => new Date()),
    sleep: deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms))),
    queueRetryDelayMs: deps.queueRetryDelayMs ?? defaultQueueRetryDelayMs,
    queueProcessMaxPasses: deps.queueProcessMaxPasses ?? defaultQueueProcessMaxPasses,
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

function runGhPrCreate(args: string[]): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn('gh', ['pr', 'create', ...args], { stdio: 'inherit' });
    child.on('error', reject);
    child.on('close', (code) => resolve(code ?? 1));
  });
}

function runGitLsRemote(cwd: string, remoteName: string, remoteRef: string): Promise<string | undefined> {
  return new Promise((resolve, reject) => {
    const child = spawn('git', ['ls-remote', '--exit-code', remoteName, remoteRef], { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => { stdout += chunk; });
    child.stderr.on('data', (chunk: string) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) {
        const details = stderr.trim();
        reject(new Error(`git ls-remote failed for ${remoteRef} on ${remoteName}${details.length > 0 ? `: ${details}` : ` with exit code ${code ?? 'unknown'}`}`));
        return;
      }
      const sha = stdout.trim().split(/\s+/)[0];
      if (!sha) {
        reject(new Error(`git ls-remote returned no SHA for ${remoteRef} on ${remoteName}`));
        return;
      }
      resolve(sha);
    });
  });
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

async function runPrCreate(argv: string[], deps: CliDeps): Promise<number> {
  const ghArgs = argv[0] === '--' ? argv.slice(1) : argv;
  let createExitCode;
  try {
    createExitCode = await deps.runGhPrCreate(ghArgs);
  } catch (error) {
    deps.stderr(isGhSetupError(error) ? ghSetupMessage : `gh pr create failed: ${formatErrorMessage(error)}`);
    return 1;
  }
  if (createExitCode !== 0) return createExitCode;

  try {
    const result = await postPrtokensForCurrentRepo({
      cwd: deps.cwd,
      dryRun: false,
      json: false,
      verbose: false,
      stdout: deps.stdout,
      stderr: deps.stderr,
      readAllUsage: deps.readAllUsage,
      resolvePullRequest: deps.resolvePullRequest,
      ensureGhReady: deps.ensureGhReady,
      upsertPrComment: deps.upsertPrComment,
    });

    if (result.kind === 'post-failed') {
      deps.stderr(`prtokens could not post the PR comment: ${result.error}`);
      return 0;
    }
    if (result.kind === 'gh-not-ready') {
      deps.stderr(result.message);
      return 0;
    }

    printPostResult(result, deps.stdout, deps.stderr);
    return 0;
  } catch (error) {
    deps.stderr(`prtokens could not post the PR comment: ${formatErrorMessage(error)}`);
    return 0;
  }
}

interface HookPushedRefFlags {
  remoteName: string;
  localBranch: string;
  remoteBranch: string;
  headSha: string;
}

async function runHookPushedRef(argv: string[], deps: CliDeps): Promise<number> {
  const flags = parseHookPushedRefFlags(argv, deps.stderr);
  if (flags === undefined) return 0;

  try {
    const queuedAt = deps.now().toISOString();
    deps.enqueuePendingPr(deps.queuePath, {
      id: makePendingPrJobId({ repoRoot: deps.cwd, remoteBranch: flags.remoteBranch, headSha: flags.headSha }),
      repoRoot: deps.cwd,
      remoteName: flags.remoteName,
      localBranch: flags.localBranch,
      remoteBranch: flags.remoteBranch,
      headSha: flags.headSha,
      queuedAt,
      attempts: 0,
      status: 'pending',
      lastResult: 'queued from pre-push hook',
    });
    await scheduleProcessQueue(deps);
    return 0;
  } catch (error) {
    deps.stderr(error instanceof Error ? error.message : String(error));
    return 0;
  }
}

async function runProcessQueue(deps: CliDeps): Promise<number> {
  await deps.withPendingQueueProcessLock(deps.queuePath, async () => {
    const maxPasses = Math.max(1, deps.queueProcessMaxPasses);
    for (let pass = 0; pass < maxPasses; pass += 1) {
      const now = deps.now();
      const originalQueue = deps.readPendingQueue(deps.queuePath);
      const originalJobIds = new Set(originalQueue.jobs.map((job) => job.id));
      let queueAfterPass: PendingPrQueue | undefined;

      await deps.processPendingPrJobs({
        queue: originalQueue,
        now,
        retryWindowMs: queueRetryWindowMs,
        retentionMs: queueRetentionMs,
        readRemoteHead: (job) => deps.runGitLsRemote(job.repoRoot, job.remoteName, `refs/heads/${job.remoteBranch}`),
        post: (job) => postPrtokensForCurrentRepo({
          cwd: job.repoRoot,
          dryRun: false,
          json: false,
          verbose: false,
          branch: job.remoteBranch,
          headSha: job.headSha,
          stdout: deps.stdout,
          stderr: deps.stderr,
          readAllUsage: deps.readAllUsage,
          resolvePullRequest: deps.resolvePullRequest,
          ensureGhReady: deps.ensureGhReady,
          upsertPrComment: deps.upsertPrComment,
        }),
        writeQueue: (queue) => {
          queueAfterPass = deps.mergePendingQueue(deps.queuePath, (latestQueue) => mergeProcessedQueue(originalJobIds, queue, latestQueue));
        },
      });

      const latestQueue = queueAfterPass ?? originalQueue;
      if (pass === maxPasses - 1 || !hasRetryablePendingJobs(latestQueue, now)) {
        break;
      }
      await deps.sleep(queueRetryDelayMsFor(latestQueue, now, deps.queueRetryDelayMs));
    }
  });
  return 0;
}

function mergeProcessedQueue(originalJobIds: Set<string>, processedQueue: PendingPrQueue, latestQueue: PendingPrQueue): PendingPrQueue {
  const latestById = new Map(latestQueue.jobs.map((job) => [job.id, job]));
  return {
    version: 1,
    jobs: [
      ...processedQueue.jobs
        .filter((job) => originalJobIds.has(job.id))
        .map((job) => chooseMergedJob(job, latestById.get(job.id))),
      ...latestQueue.jobs.filter((job) => !originalJobIds.has(job.id)),
    ],
  };
}

function hasRetryablePendingJobs(queue: PendingPrQueue, now: Date): boolean {
  return queue.jobs.some((job) => job.status === 'pending' && now.getTime() - Date.parse(job.queuedAt) <= queueRetryWindowMs);
}

function queueRetryDelayMsFor(queue: PendingPrQueue, now: Date, normalRetryDelayMs: number): number {
  const hasStaleRemoteHeadJob = queue.jobs.some((job) => (
    job.status === 'pending'
    && job.lastResult === remoteHeadNotReachedResult
    && now.getTime() - Date.parse(job.queuedAt) <= queueRetryWindowMs
  ));
  return hasStaleRemoteHeadJob ? Math.min(staleRemoteHeadQueueRetryDelayMs, normalRetryDelayMs) : normalRetryDelayMs;
}

function chooseMergedJob(processedJob: PendingPrJob, latestJob: PendingPrJob | undefined): PendingPrJob {
  if (latestJob === undefined) return processedJob;
  return isMoreAdvancedJob(latestJob, processedJob) ? latestJob : processedJob;
}

function isMoreAdvancedJob(candidate: PendingPrJob, baseline: PendingPrJob): boolean {
  if (isTerminalStatus(baseline.status) && candidate.status === 'pending') return false;
  if (isTerminalStatus(candidate.status) && baseline.status === 'pending') return true;
  if (candidate.attempts !== baseline.attempts) return candidate.attempts > baseline.attempts;

  const candidateAttemptAt = parseTime(candidate.lastAttemptAt);
  const baselineAttemptAt = parseTime(baseline.lastAttemptAt);
  return candidateAttemptAt !== undefined && (baselineAttemptAt === undefined || candidateAttemptAt > baselineAttemptAt);
}

function isTerminalStatus(status: PendingPrJob['status']): boolean {
  return status === 'completed' || status === 'blocked' || status === 'failed';
}

function parseTime(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const time = Date.parse(value);
  return Number.isFinite(time) ? time : undefined;
}

function parseHookPushedRefFlags(argv: string[], stderr: (message: string) => void): HookPushedRefFlags | undefined {
  try {
    const parsed = parseArgs({
      args: argv,
      allowPositionals: false,
      strict: true,
      options: {
        'remote-name': { type: 'string' },
        'remote-url': { type: 'string' },
        'local-branch': { type: 'string' },
        'remote-branch': { type: 'string' },
        'head-sha': { type: 'string' },
      },
    });
    const values = parsed.values;
    if (values['remote-name'] && values['local-branch'] && values['remote-branch'] && values['head-sha']) {
      return {
        remoteName: values['remote-name'],
        localBranch: values['local-branch'],
        remoteBranch: values['remote-branch'],
        headSha: values['head-sha'],
      };
    }
    stderr('Missing required hook pushed-ref metadata.');
    return undefined;
  } catch (error) {
    stderr(error instanceof Error ? error.message : String(error));
    return undefined;
  }
}

async function scheduleProcessQueue(deps: CliDeps): Promise<void> {
  try {
    await runProcessQueue({ ...deps, queueProcessMaxPasses: 1 });
    if (hasRetryablePendingJobs(deps.readPendingQueue(deps.queuePath), deps.now())) {
      spawnDetachedProcessQueue();
    }
  } catch (error) {
    deps.stderr(error instanceof Error ? error.message : String(error));
  }
}

function spawnDetachedProcessQueue(): void {
  const child = spawn(process.execPath, [resolvePrtokensBinPath(), '__process-queue'], {
    detached: true,
    stdio: 'ignore',
  });
  child.unref();
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

function formatErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
