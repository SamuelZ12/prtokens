import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';

export type PendingPrStatus = 'pending' | 'blocked' | 'completed' | 'failed';

export interface PendingPrJob {
  id: string;
  repoRoot: string;
  repository?: string;
  remoteName: string;
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
const queueLockWaitMs = 5_000;
const staleQueueLockMs = 30_000;

export function defaultQueuePath(env: NodeJS.ProcessEnv = process.env): string {
  const base = env.XDG_STATE_HOME ?? join(homedir(), '.local', 'state');
  return join(base, 'prtokens', 'pending-prs.json');
}

export function makePendingPrJobId(input: { repoRoot: string; remoteBranch: string; headSha: string }): string {
  return `${sanitizeId(input.repoRoot)}-${sanitizeId(input.remoteBranch)}-${input.headSha.slice(0, 12)}`;
}

export function readPendingQueue(queuePath: string): PendingPrQueue {
  return readPendingQueueUnlocked(queuePath);
}

export function writePendingQueue(queuePath: string, queue: PendingPrQueue): void {
  withQueueLock(queuePath, () => {
    writePendingQueueUnlocked(queuePath, queue);
  });
}

export function scrubPendingQueue(queuePath: string): PendingPrQueue {
  if (!existsSync(queuePath)) return { version: 1, jobs: [] };

  return withQueueLock(queuePath, () => {
    if (!existsSync(queuePath)) return { version: 1, jobs: [] };
    const queue = readPendingQueueUnlocked(queuePath);
    writePendingQueueUnlocked(queuePath, queue);
    return queue;
  });
}

export function mergePendingQueue(queuePath: string, mergeFn: (queue: PendingPrQueue) => PendingPrQueue): PendingPrQueue {
  return withQueueLock(queuePath, () => {
    const merged = sanitizePendingQueue(mergeFn(readPendingQueueUnlocked(queuePath)));
    writePendingQueueUnlocked(queuePath, merged);
    return merged;
  });
}

export function enqueuePendingPr(queuePath: string, job: PendingPrJob): PendingPrJob {
  const sanitizedJob = sanitizePendingPrJob(job);
  if (!sanitizedJob) throw new Error('Invalid pending PR job');

  let writtenJob: PendingPrJob | undefined;
  mergePendingQueue(queuePath, (queue) => {
    const existingIndex = queue.jobs.findIndex((entry) => entry.id === sanitizedJob.id);
    if (existingIndex === -1) {
      queue.jobs.push(sanitizedJob);
      writtenJob = sanitizedJob;
      return queue;
    }

    const updated = sanitizePendingPrJob({ ...queue.jobs[existingIndex], ...sanitizedJob, attempts: queue.jobs[existingIndex].attempts });
    if (!updated) throw new Error('Invalid pending PR job');
    queue.jobs[existingIndex] = updated;
    writtenJob = updated;
    return queue;
  });

  if (!writtenJob) throw new Error('Invalid pending PR job');
  return writtenJob;
}

export function updatePendingPrJob(queuePath: string, id: string, patch: Partial<PendingPrJob>): PendingPrJob | undefined {
  let writtenJob: PendingPrJob | undefined;
  mergePendingQueue(queuePath, (queue) => {
    const index = queue.jobs.findIndex((job) => job.id === id);
    if (index === -1) return queue;

    const updated = sanitizePendingPrJob({ ...queue.jobs[index], ...patch });
    if (!updated) return queue;
    queue.jobs[index] = updated;
    writtenJob = updated;
    return queue;
  });
  return writtenJob;
}

export async function withPendingQueueProcessLock<T>(queuePath: string, fn: () => Promise<T>): Promise<T | undefined> {
  mkdirSync(dirname(queuePath), { recursive: true });
  const lockPath = `${queuePath}.process.lock`;
  if (!tryAcquireProcessLock(lockPath)) return undefined;

  try {
    return await fn();
  } finally {
    rmSync(lockPath, { recursive: true, force: true });
  }
}

function readPendingQueueUnlocked(queuePath: string): PendingPrQueue {
  if (!existsSync(queuePath)) {
    return { version: 1, jobs: [] };
  }

  const parsed = JSON.parse(readFileSync(queuePath, 'utf8')) as Partial<PendingPrQueue>;
  return { version: 1, jobs: Array.isArray(parsed.jobs) ? sanitizePendingPrJobs(parsed.jobs) : [] };
}

function writePendingQueueUnlocked(queuePath: string, queue: PendingPrQueue): void {
  mkdirSync(dirname(queuePath), { recursive: true });
  const tempPath = `${queuePath}.${process.pid}.tmp`;
  writeFileSync(tempPath, `${JSON.stringify(sanitizePendingQueue(queue), null, 2)}\n`);
  renameSync(tempPath, queuePath);
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

function sanitizePendingQueue(queue: PendingPrQueue): PendingPrQueue {
  return { version: 1, jobs: sanitizePendingPrJobs(queue.jobs) };
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
  if (!isValidDateString(job.queuedAt)) return undefined;
  if (!isValidAttempts(job.attempts)) return undefined;
  if (!isPendingPrStatus(job.status)) return undefined;
  if (!isString(job.lastResult)) return undefined;
  if (job.lastAttemptAt !== undefined && !isValidDateString(job.lastAttemptAt)) return undefined;

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
  if (job.lastAttemptAt !== undefined) sanitized.lastAttemptAt = job.lastAttemptAt;

  return sanitized;
}

function withQueueLock<T>(queuePath: string, fn: () => T): T {
  mkdirSync(dirname(queuePath), { recursive: true });
  const lockPath = `${queuePath}.lock`;
  acquireQueueLock(lockPath);
  try {
    return fn();
  } finally {
    rmSync(lockPath, { recursive: true, force: true });
  }
}

function acquireQueueLock(lockPath: string): void {
  const deadline = Date.now() + queueLockWaitMs;
  while (true) {
    try {
      mkdirSync(lockPath);
      return;
    } catch (error) {
      if (!isErrnoException(error) || error.code !== 'EEXIST') throw error;
      if (isStaleQueueLock(lockPath)) {
        rmSync(lockPath, { recursive: true, force: true });
        continue;
      }
      if (Date.now() >= deadline) throw new Error(`Timed out waiting for pending PR queue lock at ${lockPath}`);
      waitForQueueLock();
    }
  }
}

function tryAcquireProcessLock(lockPath: string): boolean {
  while (true) {
    try {
      mkdirSync(lockPath);
      writeFileSync(join(lockPath, 'pid'), String(process.pid));
      return true;
    } catch (error) {
      if (!isErrnoException(error) || error.code !== 'EEXIST') throw error;
      if (quarantineStaleProcessLock(lockPath)) {
        continue;
      }
      return false;
    }
  }
}

function quarantineStaleProcessLock(lockPath: string): boolean {
  if (isLiveProcessLock(lockPath) || !isStaleQueueLock(lockPath)) return false;

  const stalePath = `${lockPath}.stale.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}`;
  try {
    renameSync(lockPath, stalePath);
  } catch (error) {
    if (isErrnoException(error) && error.code === 'ENOENT') return true;
    throw error;
  }

  if (!isLiveProcessLock(stalePath) && isStaleQueueLock(stalePath)) {
    rmSync(stalePath, { recursive: true, force: true });
    return true;
  }

  try {
    renameSync(stalePath, lockPath);
  } catch (error) {
    if (isErrnoException(error) && error.code === 'EEXIST') return false;
    throw error;
  }
  return false;
}

function isLiveProcessLock(lockPath: string): boolean {
  try {
    const pid = Number(readFileSync(join(lockPath, 'pid'), 'utf8'));
    if (!Number.isInteger(pid) || pid <= 0) return false;
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (isErrnoException(error) && error.code === 'ESRCH') return false;
    if (isErrnoException(error) && error.code === 'ENOENT') return false;
    if (isErrnoException(error) && error.code === 'EPERM') return true;
    throw error;
  }
}

function isStaleQueueLock(lockPath: string): boolean {
  try {
    return Date.now() - statSync(lockPath).mtimeMs > staleQueueLockMs;
  } catch (error) {
    if (isErrnoException(error) && error.code === 'ENOENT') return false;
    throw error;
  }
}

function waitForQueueLock(): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
}

function isErrnoException(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
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

function isValidAttempts(value: unknown): value is number {
  return isNumber(value) && Number.isInteger(value) && value >= 0;
}

function isValidDateString(value: unknown): value is string {
  return isString(value) && Number.isFinite(Date.parse(value));
}

function isPendingPrStatus(value: unknown): value is PendingPrStatus {
  return value === 'pending' || value === 'blocked' || value === 'completed' || value === 'failed';
}
