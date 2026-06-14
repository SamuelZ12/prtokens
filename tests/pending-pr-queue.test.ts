import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { enqueuePendingPr, formatQueueStatus, readPendingQueue, updatePendingPrJob, type PendingPrJob } from '../src/pending-pr-queue.js';

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

describe('pending PR queue', () => {
  it('stores metadata only and upserts by repo branch and head sha', () => {
    const queuePath = tempQueuePath();

    enqueuePendingPr(queuePath, job());
    enqueuePendingPr(queuePath, job({ lastResult: 'second enqueue' }));

    const raw = readFileSync(queuePath, 'utf8');
    expect(raw).not.toContain('inputTokens');
    expect(raw).not.toContain('outputTokens');
    expect(raw).not.toContain('transcript');
    expect(raw).not.toContain('renderedMarkdown');

    const queue = readPendingQueue(queuePath);
    expect(queue.jobs).toHaveLength(1);
    expect(queue.jobs[0]).toMatchObject({ status: 'pending', attempts: 0, lastResult: 'second enqueue' });
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
