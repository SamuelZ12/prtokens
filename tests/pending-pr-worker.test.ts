import { describe, expect, it, vi } from 'vitest';
import { processPendingPrJobs } from '../src/pending-pr-worker.js';
import type { PendingPrJob, PendingPrQueue } from '../src/pending-pr-queue.js';

function job(overrides: Partial<PendingPrJob> = {}): PendingPrJob {
  return {
    id: 'job-1',
    repoRoot: '/repo',
    repository: 'acme/prtokens',
    remoteName: 'origin',
    localBranch: 'feature/prtokens',
    remoteBranch: 'feature/prtokens',
    headSha: 'abcdef1234567890',
    queuedAt: '2026-06-14T00:00:00.000Z',
    attempts: 0,
    status: 'pending',
    lastResult: 'waiting for PR',
    ...overrides,
  };
}

describe('processPendingPrJobs', () => {
  it('marks a job completed when posting succeeds', async () => {
    const queue: PendingPrQueue = { version: 1, jobs: [job()] };
    const writeQueue = vi.fn();

    await processPendingPrJobs({
      queue,
      now: new Date('2026-06-14T00:05:00.000Z'),
      retryWindowMs: 30 * 60_000,
      retentionMs: 24 * 60 * 60_000,
      readRemoteHead: vi.fn().mockResolvedValue('abcdef1234567890'),
      post: vi.fn().mockResolvedValue({ kind: 'posted', prNumber: 42, repository: 'acme/prtokens' }),
      writeQueue,
    });

    expect(writeQueue).toHaveBeenCalledWith(expect.objectContaining({
      jobs: [expect.objectContaining({ status: 'completed', attempts: 1, lastResult: 'posted PR #42' })],
    }));
  });

  it('keeps a job pending when no PR exists inside the retry window', async () => {
    const queue: PendingPrQueue = { version: 1, jobs: [job()] };
    const writeQueue = vi.fn();

    await processPendingPrJobs({
      queue,
      now: new Date('2026-06-14T00:10:00.000Z'),
      retryWindowMs: 30 * 60_000,
      retentionMs: 24 * 60 * 60_000,
      readRemoteHead: vi.fn().mockResolvedValue('abcdef1234567890'),
      post: vi.fn().mockResolvedValue({ kind: 'no-pr', branch: 'feature/prtokens', message: 'No pull request found for current branch.' }),
      writeQueue,
    });

    expect(writeQueue).toHaveBeenCalledWith(expect.objectContaining({
      jobs: [expect.objectContaining({ status: 'pending', attempts: 1, lastResult: 'No pull request found for current branch.' })],
    }));
  });

  it('keeps a job pending when the remote has not reached the pushed head yet', async () => {
    const post = vi.fn();
    const queue: PendingPrQueue = { version: 1, jobs: [job()] };
    const writeQueue = vi.fn();

    await processPendingPrJobs({
      queue,
      now: new Date('2026-06-14T00:10:00.000Z'),
      retryWindowMs: 30 * 60_000,
      retentionMs: 24 * 60 * 60_000,
      readRemoteHead: vi.fn().mockResolvedValue('ffffffffffffffff'),
      post,
      writeQueue,
    });

    expect(post).not.toHaveBeenCalled();
    expect(writeQueue).toHaveBeenCalledWith(expect.objectContaining({
      jobs: [expect.objectContaining({ status: 'pending', attempts: 1, lastResult: 'remote has not reached pushed head yet' })],
    }));
  });

  it('marks gh setup failures blocked and no usage completed', async () => {
    const queue: PendingPrQueue = { version: 1, jobs: [job({ id: 'blocked' }), job({ id: 'no-usage' })] };
    const writeQueue = vi.fn();
    const post = vi
      .fn()
      .mockResolvedValueOnce({ kind: 'gh-not-ready', message: 'Install GitHub CLI and run gh auth login.' })
      .mockResolvedValueOnce({ kind: 'no-usage', message: 'No coding-agent usage found for this repo (checked Claude Code, Codex, OpenCode).' });

    await processPendingPrJobs({
      queue,
      now: new Date('2026-06-14T00:05:00.000Z'),
      retryWindowMs: 30 * 60_000,
      retentionMs: 24 * 60 * 60_000,
      readRemoteHead: vi.fn().mockResolvedValue('abcdef1234567890'),
      post,
      writeQueue,
    });

    expect(writeQueue).toHaveBeenCalledWith(expect.objectContaining({
      jobs: [
        expect.objectContaining({ id: 'blocked', status: 'blocked', lastResult: 'Install GitHub CLI and run gh auth login.' }),
        expect.objectContaining({ id: 'no-usage', status: 'completed', lastResult: 'no usage found' }),
      ],
    }));
  });

  it('records remote head check failures and continues processing later jobs', async () => {
    const queue: PendingPrQueue = { version: 1, jobs: [job({ id: 'remote-fails' }), job({ id: 'later' })] };
    const writeQueue = vi.fn();
    const readRemoteHead = vi.fn().mockRejectedValueOnce(new Error('network unavailable')).mockResolvedValueOnce('abcdef1234567890');

    await processPendingPrJobs({
      queue,
      now: new Date('2026-06-14T00:05:00.000Z'),
      retryWindowMs: 30 * 60_000,
      retentionMs: 24 * 60 * 60_000,
      readRemoteHead,
      post: vi.fn().mockResolvedValue({ kind: 'posted', prNumber: 43, repository: 'acme/prtokens' }),
      writeQueue,
    });

    expect(writeQueue).toHaveBeenCalledWith(expect.objectContaining({
      jobs: [
        expect.objectContaining({ id: 'remote-fails', status: 'failed', lastResult: 'remote head check failed: network unavailable' }),
        expect.objectContaining({ id: 'later', status: 'completed', attempts: 1, lastResult: 'posted PR #43' }),
      ],
    }));
  });

  it('records posting failures and continues processing later jobs', async () => {
    const queue: PendingPrQueue = { version: 1, jobs: [job({ id: 'post-fails' }), job({ id: 'later' })] };
    const writeQueue = vi.fn();
    const post = vi.fn().mockRejectedValueOnce(new Error('gh api timeout')).mockResolvedValueOnce({ kind: 'posted', prNumber: 44, repository: 'acme/prtokens' });

    await processPendingPrJobs({
      queue,
      now: new Date('2026-06-14T00:05:00.000Z'),
      retryWindowMs: 30 * 60_000,
      retentionMs: 24 * 60 * 60_000,
      readRemoteHead: vi.fn().mockResolvedValue('abcdef1234567890'),
      post,
      writeQueue,
    });

    expect(writeQueue).toHaveBeenCalledWith(expect.objectContaining({
      jobs: [
        expect.objectContaining({ id: 'post-fails', status: 'failed', attempts: 1, lastResult: 'posting failed: gh api timeout' }),
        expect.objectContaining({ id: 'later', status: 'completed', attempts: 1, lastResult: 'posted PR #44' }),
      ],
    }));
  });

  it('expires old pending jobs and preserves non-pending jobs', async () => {
    const completed = job({ id: 'completed', status: 'completed', attempts: 2, lastResult: 'posted PR #42' });
    const queue: PendingPrQueue = { version: 1, jobs: [job({ id: 'expired' }), completed] };
    const writeQueue = vi.fn();
    const post = vi.fn();

    await processPendingPrJobs({
      queue,
      now: new Date('2026-06-14T00:31:00.000Z'),
      retryWindowMs: 30 * 60_000,
      retentionMs: 24 * 60 * 60_000,
      readRemoteHead: vi.fn().mockResolvedValue('abcdef1234567890'),
      post,
      writeQueue,
    });

    expect(post).not.toHaveBeenCalled();
    expect(writeQueue).toHaveBeenCalledWith(expect.objectContaining({
      jobs: [
        expect.objectContaining({ id: 'expired', status: 'failed', lastResult: 'retry window expired' }),
        completed,
      ],
    }));
  });
});
