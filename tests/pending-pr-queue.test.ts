import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { enqueuePendingPr, formatQueueStatus, readPendingQueue, updatePendingPrJob, writePendingQueue, type PendingPrJob } from '../src/pending-pr-queue.js';

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
    remoteUrl: 'git@github.com:acme/prtokens.git',
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
            lastAttemptAt: false,
            transcript: 'conversation transcript',
          },
          job({
            id: 'valid-with-optionals',
            repository: 'acme/prtokens',
            remoteUrl: 'git@github.com:acme/prtokens.git',
            lastAttemptAt: '2026-06-14T00:03:00.000Z',
          }),
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
      remoteUrl: 'git@github.com:acme/prtokens.git',
      lastAttemptAt: '2026-06-14T00:03:00.000Z',
    });

    expect(() => formatQueueStatus(queue)).not.toThrow();
  });

  it('returns an empty queue when persisted jobs is not an array', () => {
    const queuePath = tempQueuePath();
    writeFileSync(queuePath, JSON.stringify({ version: 1, jobs: { id: 'not-an-array' } }));

    expect(readPendingQueue(queuePath)).toEqual({ version: 1, jobs: [] });
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
