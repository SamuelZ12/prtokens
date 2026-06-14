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

type UnknownRecord = Record<string, unknown>;

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
  return { version: 1, jobs: Array.isArray(parsed.jobs) ? sanitizePendingPrJobs(parsed.jobs) : [] };
}

export function writePendingQueue(queuePath: string, queue: PendingPrQueue): void {
  mkdirSync(dirname(queuePath), { recursive: true });
  const tempPath = `${queuePath}.${process.pid}.tmp`;
  writeFileSync(tempPath, `${JSON.stringify({ version: 1, jobs: sanitizePendingPrJobs(queue.jobs) }, null, 2)}\n`);
  renameSync(tempPath, queuePath);
}

export function enqueuePendingPr(queuePath: string, job: PendingPrJob): PendingPrJob {
  const queue = readPendingQueue(queuePath);
  const sanitizedJob = sanitizePendingPrJob(job);
  if (!sanitizedJob) throw new Error('Invalid pending PR job');
  const existingIndex = queue.jobs.findIndex((entry) => entry.id === sanitizedJob.id);
  if (existingIndex === -1) {
    queue.jobs.push(sanitizedJob);
  } else {
    const updated = sanitizePendingPrJob({ ...queue.jobs[existingIndex], ...sanitizedJob, attempts: queue.jobs[existingIndex].attempts });
    if (!updated) throw new Error('Invalid pending PR job');
    queue.jobs[existingIndex] = updated;
  }
  writePendingQueue(queuePath, queue);
  return existingIndex === -1 ? sanitizedJob : queue.jobs[existingIndex];
}

export function updatePendingPrJob(queuePath: string, id: string, patch: Partial<PendingPrJob>): PendingPrJob | undefined {
  const queue = readPendingQueue(queuePath);
  const index = queue.jobs.findIndex((job) => job.id === id);
  if (index === -1) return undefined;

  const updated = sanitizePendingPrJob({ ...queue.jobs[index], ...patch });
  if (!updated) return undefined;
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

function sanitizePendingPrJobs(jobs: unknown[]): PendingPrJob[] {
  return jobs.flatMap((job) => {
    const sanitized = sanitizePendingPrJob(job);
    return sanitized ? [sanitized] : [];
  });
}

function sanitizePendingPrJob(job: unknown): PendingPrJob | undefined {
  if (!isRecord(job)) return undefined;
  if (!isString(job.id)) return undefined;
  if (!isString(job.repoRoot)) return undefined;
  if (!isString(job.remoteName)) return undefined;
  if (!isString(job.localBranch)) return undefined;
  if (!isString(job.remoteBranch)) return undefined;
  if (!isString(job.headSha)) return undefined;
  if (!isString(job.queuedAt)) return undefined;
  if (!isNumber(job.attempts)) return undefined;
  if (!isPendingPrStatus(job.status)) return undefined;
  if (!isString(job.lastResult)) return undefined;

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

  if (isString(job.repository)) sanitized.repository = job.repository;
  if (isString(job.remoteUrl)) sanitized.remoteUrl = job.remoteUrl;
  if (isString(job.lastAttemptAt)) sanitized.lastAttemptAt = job.lastAttemptAt;

  return sanitized;
}

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isString(value: unknown): value is string {
  return typeof value === 'string';
}

function isNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isPendingPrStatus(value: unknown): value is PendingPrStatus {
  return value === 'pending' || value === 'blocked' || value === 'completed' || value === 'failed';
}
