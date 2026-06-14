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

    const remoteHead = await options.readRemoteHead(job);
    if (remoteHead !== undefined && remoteHead !== job.headSha) {
      jobs.push({ ...job, status: 'failed', lastAttemptAt: options.now.toISOString(), lastResult: 'branch moved before PR appeared' });
      continue;
    }

    const result = await options.post(job);
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
