import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';

export type PendingPrStatus = 'pending' | 'blocked' | 'completed' | 'failed';

export interface PendingPrJob {
  id: string;
  repoRoot: string;
  repository?: string;
  remoteName: string;
  remoteUrl?: string;
  localBranch: string;
  remoteBranch: string;
  headSha: string;
  queuedAt: string;
  lastAttemptAt?: string;
  attempts: number;
  status: PendingPrStatus;
  lastResult: string;
}

export interface PendingPrQueue {
  version: 1;
  jobs: PendingPrJob[];
}

export function defaultQueuePath(env: NodeJS.ProcessEnv = process.env): string {
  const base = env.XDG_STATE_HOME ?? join(homedir(), '.local', 'state');
  return join(base, 'prtokens', 'pending-prs.json');
}

export function makePendingPrJobId(input: { repoRoot: string; remoteBranch: string; headSha: string }): string {
  return `${sanitizeId(input.repoRoot)}-${sanitizeId(input.remoteBranch)}-${input.headSha.slice(0, 12)}`;
}

export function readPendingQueue(queuePath: string): PendingPrQueue {
  if (!existsSync(queuePath)) {
    return { version: 1, jobs: [] };
  }

  const parsed = JSON.parse(readFileSync(queuePath, 'utf8')) as Partial<PendingPrQueue>;
  return { version: 1, jobs: Array.isArray(parsed.jobs) ? parsed.jobs.map((job) => sanitizePendingPrJob(job as PendingPrJob)) : [] };
}

export function writePendingQueue(queuePath: string, queue: PendingPrQueue): void {
  mkdirSync(dirname(queuePath), { recursive: true });
  const tempPath = `${queuePath}.${process.pid}.tmp`;
  writeFileSync(tempPath, `${JSON.stringify({ version: 1, jobs: queue.jobs.map(sanitizePendingPrJob) }, null, 2)}\n`);
  renameSync(tempPath, queuePath);
}

export function enqueuePendingPr(queuePath: string, job: PendingPrJob): PendingPrJob {
  const queue = readPendingQueue(queuePath);
  const sanitizedJob = sanitizePendingPrJob(job);
  const existingIndex = queue.jobs.findIndex((entry) => entry.id === sanitizedJob.id);
  if (existingIndex === -1) {
    queue.jobs.push(sanitizedJob);
  } else {
    queue.jobs[existingIndex] = sanitizePendingPrJob({ ...queue.jobs[existingIndex], ...sanitizedJob, attempts: queue.jobs[existingIndex].attempts });
  }
  writePendingQueue(queuePath, queue);
  return existingIndex === -1 ? sanitizedJob : queue.jobs[existingIndex];
}

export function updatePendingPrJob(queuePath: string, id: string, patch: Partial<PendingPrJob>): PendingPrJob | undefined {
  const queue = readPendingQueue(queuePath);
  const index = queue.jobs.findIndex((job) => job.id === id);
  if (index === -1) return undefined;

  const updated = sanitizePendingPrJob({ ...queue.jobs[index], ...patch } as PendingPrJob);
  queue.jobs[index] = updated;
  writePendingQueue(queuePath, queue);
  return updated;
}

export function pruneQueue(queue: PendingPrQueue, now: Date, retentionMs: number): PendingPrQueue {
  return {
    version: 1,
    jobs: queue.jobs.filter((job) => now.getTime() - Date.parse(job.queuedAt) <= retentionMs),
  };
}

export function formatQueueStatus(queue: PendingPrQueue, now: Date = new Date()): string {
  if (queue.jobs.length === 0) return 'No pending PR posts.';

  const sections: string[] = [];
  for (const status of ['pending', 'blocked', 'failed', 'completed'] as const) {
    const jobs = queue.jobs.filter((job) => job.status === status);
    if (jobs.length === 0) continue;

    sections.push(sectionTitle(status));
    for (const job of jobs) {
      sections.push(`- ${job.localBranch} ${job.headSha.slice(0, 7)} · ${ageLabel(job.queuedAt, now)} old · ${job.attempts} attempts · ${job.lastResult}`);
    }
  }

  return sections.join('\n');
}

function sectionTitle(status: PendingPrStatus): string {
  switch (status) {
    case 'pending':
      return 'Pending PR posts';
    case 'blocked':
      return 'Blocked';
    case 'failed':
      return 'Failed';
    case 'completed':
      return 'Completed';
  }
}

function ageLabel(iso: string, now: Date): string {
  const minutes = Math.max(0, Math.floor((now.getTime() - Date.parse(iso)) / 60_000));
  if (minutes < 60) return `${minutes}m`;
  return `${Math.floor(minutes / 60)}h`;
}

function sanitizeId(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(-80) || 'repo';
}

function sanitizePendingPrJob(job: PendingPrJob): PendingPrJob {
  const sanitized: PendingPrJob = {
    id: job.id,
    repoRoot: job.repoRoot,
    remoteName: job.remoteName,
    localBranch: job.localBranch,
    remoteBranch: job.remoteBranch,
    headSha: job.headSha,
    queuedAt: job.queuedAt,
    attempts: job.attempts,
    status: job.status,
    lastResult: job.lastResult,
  };

  if (job.repository !== undefined) sanitized.repository = job.repository;
  if (job.remoteUrl !== undefined) sanitized.remoteUrl = job.remoteUrl;
  if (job.lastAttemptAt !== undefined) sanitized.lastAttemptAt = job.lastAttemptAt;

  return sanitized;
}
