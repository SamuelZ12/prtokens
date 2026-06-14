import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { enqueuePendingPr, formatQueueStatus, mergePendingQueue, readPendingQueue, scrubPendingQueue, updatePendingPrJob, withPendingQueueProcessLock, writePendingQueue, type PendingPrJob } from '../src/pending-pr-queue.js';

let tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  tempDirs = [];
});

function tempQueuePath() {
  const dir = mkdtempSync(join(tmpdir(), 'prtokens-queue-'));
  tempDirs.push(dir);
  mkdirSync(dir, { recursive: true });
  return join(dir, 'pending-prs.json');
}

function job(overrides: Partial<PendingPrJob> = {}): PendingPrJob {
  return {
    id: 'repo-feature-abcdef1',
    repoRoot: '/repo',
    repository: 'acme/prtokens',
    remoteName: 'origin',
    localBranch: 'feature/prtokens',
    remoteBranch: 'feature/prtokens',
    headSha: 'abcdef1234567890',
    queuedAt: '2026-06-14T00:00:00.000Z',
    lastAttemptAt: undefined,
    attempts: 0,
    status: 'pending',
    lastResult: 'waiting for PR',
    ...overrides,
  };
}

function jobWithForbiddenFields(overrides: Record<string, unknown> = {}): PendingPrJob {
  return {
    ...job(),
    inputTokens: 123,
    outputTokens: 456,
    transcript: 'conversation transcript',
    prompt: 'raw prompt',
    completion: 'raw completion',
    rawUsageEvents: [{ inputTokens: 123, outputTokens: 456 }],
    tokenDetails: { cacheRead: 12 },
    renderedMarkdown: '## PR comment',
    ...overrides,
  } as unknown as PendingPrJob;
}

function expectMetadataOnly(raw: string) {
  expect(raw).not.toContain('inputTokens');
  expect(raw).not.toContain('outputTokens');
  expect(raw).not.toContain('transcript');
  expect(raw).not.toContain('prompt');
  expect(raw).not.toContain('completion');
  expect(raw).not.toContain('rawUsageEvents');
  expect(raw).not.toContain('tokenDetails');
  expect(raw).not.toContain('renderedMarkdown');
  expect(raw).not.toContain('remoteUrl');
  expect(raw).not.toContain('git@github.com:acme/prtokens.git');
}

describe('pending PR queue', () => {
  it('stores metadata only and upserts by repo branch and head sha', () => {
    const queuePath = tempQueuePath();

    enqueuePendingPr(queuePath, jobWithForbiddenFields());
    enqueuePendingPr(queuePath, jobWithForbiddenFields({ lastResult: 'second enqueue' }));

    let raw = readFileSync(queuePath, 'utf8');
    expectMetadataOnly(raw);

    let queue = readPendingQueue(queuePath);
    expect(queue.jobs).toHaveLength(1);
    expect(queue.jobs[0]).toMatchObject({ status: 'pending', attempts: 0, lastResult: 'second enqueue' });

    updatePendingPrJob(queuePath, 'repo-feature-abcdef1', {
      lastResult: 'updated with forbidden fields',
      transcript: 'patch transcript',
      renderedMarkdown: 'patch markdown',
    } as unknown as Partial<PendingPrJob>);

    raw = readFileSync(queuePath, 'utf8');
    expectMetadataOnly(raw);

    queue = readPendingQueue(queuePath);
    expect(queue.jobs).toHaveLength(1);
    expect(queue.jobs[0]).toMatchObject({ status: 'pending', attempts: 0, lastResult: 'updated with forbidden fields' });

    writePendingQueue(queuePath, { version: 1, jobs: [jobWithForbiddenFields({ id: 'direct-write' })] });

    raw = readFileSync(queuePath, 'utf8');
    expectMetadataOnly(raw);

    queue = readPendingQueue(queuePath);
    expect(queue.jobs).toHaveLength(1);
    expect(queue.jobs[0]).toMatchObject({ id: 'direct-write', status: 'pending', attempts: 0 });
  });

  it('updates existing queue jobs by id', () => {
    const queuePath = tempQueuePath();
    enqueuePendingPr(queuePath, job());

    updatePendingPrJob(queuePath, 'repo-feature-abcdef1', {
      status: 'completed',
      attempts: 2,
      lastAttemptAt: '2026-06-14T00:03:00.000Z',
      lastResult: 'posted PR #42',
    });

    expect(readPendingQueue(queuePath).jobs[0]).toMatchObject({
      status: 'completed',
      attempts: 2,
      lastResult: 'posted PR #42',
    });
  });

  it('skips malformed persisted jobs and preserves valid string optional fields', () => {
    const queuePath = tempQueuePath();
    writeFileSync(
      queuePath,
      JSON.stringify({
        version: 1,
        jobs: [
          null,
          {},
          { id: 'missing-fields', repoRoot: '/repo' },
          { ...job({ id: 'wrong-required-types' }), attempts: '0' },
          {
            ...job({ id: 'valid-with-invalid-optionals' }),
            repository: 42,
            remoteUrl: { url: 'git@github.com:acme/prtokens.git' },
            transcript: 'conversation transcript',
          },
          {
            ...job({
              id: 'valid-with-optionals',
              repository: 'acme/prtokens',
              lastAttemptAt: '2026-06-14T00:03:00.000Z',
            }),
            remoteUrl: 'git@github.com:acme/prtokens.git',
          },
        ],
      }),
    );

    const queue = readPendingQueue(queuePath);
    expect(queue.jobs).toHaveLength(2);
    expect(queue.jobs[0]).toMatchObject({ id: 'valid-with-invalid-optionals', status: 'pending' });
    expect(queue.jobs[0]).not.toHaveProperty('repository');
    expect(queue.jobs[0]).not.toHaveProperty('remoteUrl');
    expect(queue.jobs[0]).not.toHaveProperty('lastAttemptAt');
    expect(queue.jobs[0]).not.toHaveProperty('transcript');
    expect(queue.jobs[1]).toMatchObject({
      id: 'valid-with-optionals',
      repository: 'acme/prtokens',
      lastAttemptAt: '2026-06-14T00:03:00.000Z',
    });
    expect(queue.jobs[1]).not.toHaveProperty('remoteUrl');

    expect(() => formatQueueStatus(queue)).not.toThrow();
  });

  it('returns an empty queue when persisted jobs is not an array', () => {
    const queuePath = tempQueuePath();
    writeFileSync(queuePath, JSON.stringify({ version: 1, jobs: { id: 'not-an-array' } }));

    expect(readPendingQueue(queuePath)).toEqual({ version: 1, jobs: [] });
  });

  it('merges queue changes against latest persisted jobs', () => {
    const queuePath = tempQueuePath();
    const latestJob = job({ id: 'latest-job', localBranch: 'feature/latest', remoteBranch: 'feature/latest' });
    const updatedJob = { ...job(), status: 'completed' as const, attempts: 1, lastResult: 'posted PR #42' };

    writePendingQueue(queuePath, {
      version: 1,
      jobs: [
        job({ remoteUrl: 'https://user:token@github.com/acme/prtokens.git' } as unknown as Partial<PendingPrJob>),
        latestJob,
      ],
    });

    const written = mergePendingQueue(queuePath, (latestQueue) => ({
      version: 1,
      jobs: [updatedJob, ...latestQueue.jobs.filter((entry) => entry.id !== updatedJob.id)],
    }));

    expect(written.jobs.map((entry) => entry.id)).toEqual(['repo-feature-abcdef1', 'latest-job']);
    expect(written.jobs[0]).toMatchObject({ status: 'completed', attempts: 1, lastResult: 'posted PR #42' });
    expect(written.jobs[1]).toMatchObject({ id: 'latest-job', status: 'pending' });
    expect(readFileSync(queuePath, 'utf8')).not.toContain('remoteUrl');
    expect(readPendingQueue(queuePath)).toEqual(written);
  });

  it('scrubs legacy remote URLs without creating missing queue files', () => {
    const queuePath = tempQueuePath();
    const missingQueuePath = join(queuePath, 'missing', 'pending-prs.json');

    expect(scrubPendingQueue(missingQueuePath)).toEqual({ version: 1, jobs: [] });
    expect(existsSync(missingQueuePath)).toBe(false);

    writeFileSync(
      queuePath,
      JSON.stringify({
        version: 1,
        jobs: [{ ...job(), remoteUrl: 'https://user:token@github.com/acme/prtokens.git' }],
      }),
    );

    const queue = scrubPendingQueue(queuePath);

    expect(queue.jobs).toHaveLength(1);
    expect(queue.jobs[0]).not.toHaveProperty('remoteUrl');
    expect(readFileSync(queuePath, 'utf8')).not.toContain('remoteUrl');
    expect(readFileSync(queuePath, 'utf8')).not.toContain('user:token');
  });

  it('does not run two process-lock callbacks at the same time', async () => {
    const queuePath = tempQueuePath();
    const calls: string[] = [];

    const firstResult = await withPendingQueueProcessLock(queuePath, async () => {
      const secondResult = await withPendingQueueProcessLock(queuePath, async () => {
        calls.push('second');
        return 'second';
      });
      calls.push('first');
      expect(secondResult).toBeUndefined();
      return 'first';
    });

    expect(firstResult).toBe('first');
    expect(calls).toEqual(['first']);
    expect(existsSync(`${queuePath}.process.lock`)).toBe(false);
  });

  it('does not delete a fresh process lock during stale cleanup', async () => {
    vi.resetModules();
    const actualFs = await vi.importActual<typeof import('node:fs')>('node:fs');
    const queuePath = tempQueuePath();
    const processLockPath = `${queuePath}.process.lock`;
    mkdirSync(processLockPath);
    writeFileSync(join(processLockPath, 'pid'), '999999');
    const staleTime = new Date(Date.now() - 60_000);
    utimesSync(processLockPath, staleTime, staleTime);
    const directProcessLockDeletes: string[] = [];

    vi.doMock('node:fs', () => ({
      ...actualFs,
      renameSync: vi.fn((oldPath: string, newPath: string) => {
        actualFs.renameSync(oldPath, newPath);
        if (oldPath === processLockPath) {
          actualFs.mkdirSync(processLockPath);
          actualFs.writeFileSync(join(processLockPath, 'pid'), String(process.pid));
        }
      }),
      rmSync: vi.fn((path: string, options?: Parameters<typeof rmSync>[1]) => {
        if (path === processLockPath) {
          directProcessLockDeletes.push(path);
          throw new Error('deleted active process lock');
        }
        return actualFs.rmSync(path, options);
      }),
    }));

    try {
      const { withPendingQueueProcessLock: withMockedProcessLock } = await import('../src/pending-pr-queue.js');
      const callback = vi.fn().mockResolvedValue('processed');

      await expect(withMockedProcessLock(queuePath, callback)).resolves.toBeUndefined();

      expect(callback).not.toHaveBeenCalled();
      expect(directProcessLockDeletes).toEqual([]);
      expect(readFileSync(join(processLockPath, 'pid'), 'utf8')).toBe(String(process.pid));
    } finally {
      vi.doUnmock('node:fs');
      vi.resetModules();
    }
  });

  it('skips persisted jobs with invalid dates or attempts', () => {
    const queuePath = tempQueuePath();
    writeFileSync(
      queuePath,
      JSON.stringify({
        version: 1,
        jobs: [
          job({ id: 'invalid-queued-at', queuedAt: 'not-a-date' }),
          job({ id: 'negative-attempts', attempts: -1 }),
          job({ id: 'fractional-attempts', attempts: 1.5 }),
          job({ id: 'invalid-last-attempt', lastAttemptAt: 'not-a-date' }),
          job({ id: 'valid-with-missing-last-attempt', lastAttemptAt: undefined }),
          job({ id: 'valid-with-valid-last-attempt', lastAttemptAt: '2026-06-14T00:03:00.000Z' }),
        ],
      }),
    );

    const queue = readPendingQueue(queuePath);
    expect(queue.jobs.map((entry) => entry.id)).toEqual(['valid-with-missing-last-attempt', 'valid-with-valid-last-attempt']);
    expect(queue.jobs[0]).not.toHaveProperty('lastAttemptAt');
    expect(queue.jobs[1]).toMatchObject({ lastAttemptAt: '2026-06-14T00:03:00.000Z' });
  });

  it('formats empty and populated status output', () => {
    const now = new Date('2026-06-14T00:10:00.000Z');

    expect(formatQueueStatus({ jobs: [] }, now)).toBe('No pending PR posts.');

    const output = formatQueueStatus(
      {
        jobs: [
          job(),
          job({ id: 'blocked', status: 'blocked', localBranch: 'blocked-branch', lastResult: 'Install GitHub CLI and run gh auth login.' }),
          job({ id: 'done', status: 'completed', localBranch: 'done-branch', lastResult: 'no usage found' }),
        ],
      },
      now,
    );

    expect(output).toContain('Pending PR posts');
    expect(output).toContain('feature/prtokens');
    expect(output).toContain('abcdef1');
    expect(output).toContain('Blocked');
    expect(output).toContain('blocked-branch');
    expect(output).toContain('Completed');
    expect(output).toContain('done-branch');
  });
});
