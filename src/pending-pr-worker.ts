import type { PostPrtokensResult } from './pr-posting.js';
import { pruneQueue, type PendingPrJob, type PendingPrQueue } from './pending-pr-queue.js';

export interface ProcessPendingPrJobsOptions {
  queue: PendingPrQueue;
  now: Date;
  retryWindowMs: number;
  retentionMs: number;
  readRemoteHead(job: PendingPrJob): Promise<string | undefined>;
  post(job: PendingPrJob): Promise<PostPrtokensResult>;
  writeQueue(queue: PendingPrQueue): void;
}

export async function processPendingPrJobs(options: ProcessPendingPrJobsOptions): Promise<void> {
  const queue = pruneQueue(options.queue, options.now, options.retentionMs);
  const jobs: PendingPrJob[] = [];

  for (const job of queue.jobs) {
    if (job.status !== 'pending') {
      jobs.push(job);
      continue;
    }

    const ageMs = options.now.getTime() - Date.parse(job.queuedAt);
    if (ageMs > options.retryWindowMs) {
      jobs.push({ ...job, status: 'failed', lastAttemptAt: options.now.toISOString(), lastResult: 'retry window expired' });
      continue;
    }

    let remoteHead: string | undefined;
    try {
      remoteHead = await options.readRemoteHead(job);
    } catch (error) {
      jobs.push({ ...job, status: 'failed', lastAttemptAt: options.now.toISOString(), lastResult: `remote head check failed: ${errorMessage(error)}` });
      continue;
    }

    if (remoteHead !== undefined && remoteHead !== job.headSha) {
      jobs.push({
        ...job,
        attempts: job.attempts + 1,
        status: 'pending',
        lastAttemptAt: options.now.toISOString(),
        lastResult: 'remote has not reached pushed head yet',
      });
      continue;
    }

    let result: PostPrtokensResult;
    try {
      result = await options.post(job);
    } catch (error) {
      jobs.push({ ...job, attempts: job.attempts + 1, status: 'failed', lastAttemptAt: options.now.toISOString(), lastResult: `posting failed: ${errorMessage(error)}` });
      continue;
    }

    jobs.push(applyPostResult(job, result, options.now));
  }

  options.writeQueue({ version: 1, jobs });
}

function applyPostResult(job: PendingPrJob, result: PostPrtokensResult, now: Date): PendingPrJob {
  const base = { ...job, attempts: job.attempts + 1, lastAttemptAt: now.toISOString() };
  switch (result.kind) {
    case 'posted':
      return { ...base, status: 'completed', lastResult: `posted PR #${result.prNumber}` };
    case 'no-pr':
      return { ...base, status: 'pending', lastResult: result.message };
    case 'no-usage':
      return { ...base, status: 'completed', lastResult: 'no usage found' };
    case 'gh-not-ready':
      return { ...base, status: 'blocked', lastResult: result.message };
    case 'post-failed':
      return { ...base, status: 'failed', lastResult: result.error };
    case 'dry-run':
    case 'json':
      return { ...base, status: 'failed', lastResult: `unexpected ${result.kind} result` };
  }
}

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message.length > 0) return error.message;
  const message = String(error);
  return message.length > 0 ? message : 'unknown error';
}
