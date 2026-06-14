import { describe, expect, it, vi } from 'vitest';
import { processPendingPrJobs } from '../src/pending-pr-worker.js';
import type { PendingPrJob, PendingPrQueue } from '../src/pending-pr-queue.js';

function job(overrides: Partial<PendingPrJob> = {}): PendingPrJob {
  return {
    id: 'job-1',
    repoRoot: '/repo',
    repository: 'acme/prtokens',
    remoteName: 'origin',
    remoteUrl: 'git@github.com:acme/prtokens.git',
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

  it('marks stale moved branches failed without posting', async () => {
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
      jobs: [expect.objectContaining({ status: 'failed', lastResult: 'branch moved before PR appeared' })],
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
});
