import { mkdtempSync, realpathSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { isEntrypoint, runCli } from '../src/cli.js';
import { renderPrComment } from '../src/comment-renderer.js';
import { ghSetupMessage, postPrtokensForCurrentRepo } from '../src/pr-posting.js';

function usageEvent(overrides = {}) {
  return {
    id: 'event-1',
    agent: 'claude-code',
    timestamp: '2024-01-01T00:00:00.000Z',
    model: 'claude-3-5-sonnet-20241022',
    inputTokens: 1_000,
    outputTokens: 500,
    cacheWriteTokens: 100,
    cacheReadTokens: 50,
    sessionId: 'session-1',
    gitBranch: 'feature/prtokens',
    ...overrides,
  };
}

function commit(overrides = {}) {
  return {
    sha: 'abcdef1234567890',
    patchId: 'patch-1',
    message: 'Add CLI wiring',
    authorLogin: 'octocat',
    authoredAt: '2024-01-01T00:05:00.000Z',
    ...overrides,
  };
}

function okPr(overrides = {}) {
  return {
    kind: 'ok',
    branch: 'feature/prtokens',
    pr: {
      number: 42,
      url: 'https://github.com/acme/prtokens/pull/42',
      headRefName: 'feature/prtokens',
      authorLogin: 'octocat',
      repository: 'acme/prtokens',
    },
    commits: [commit()],
    ...overrides,
  };
}

function diagnostics(overrides = {}) {
  return {
    scannedFileCount: 0,
    malformedLineCount: 0,
    dedupedEventCount: 0,
    skippedLineCount: 0,
    warningMessages: [],
    ...overrides,
  };
}

function allUsage(overrides = {}) {
  return {
    events: [usageEvent()],
    diagnostics: {
      'claude-code': diagnostics({ scannedFileCount: 1 }),
      codex: diagnostics(),
      opencode: diagnostics(),
    },
    ...overrides,
  };
}

function createDeps(overrides = {}) {
  return {
    readAllUsage: vi.fn().mockResolvedValue(allUsage()),
    resolvePullRequest: vi.fn().mockResolvedValue(okPr()),
    ensureGhReady: vi.fn().mockResolvedValue({ ok: true }),
    upsertPrComment: vi.fn().mockResolvedValue({ ok: true }),
    runPreflight: vi.fn().mockReturnValue({
      checks: [
        { name: 'Node.js', status: 'ok', message: 'Node.js 22.13.0 satisfies >=22.13.0.' },
        { name: 'GitHub CLI', status: 'ok', message: 'GitHub CLI is installed.' },
        { name: 'GitHub auth', status: 'ok', message: 'GitHub CLI is authenticated.' },
      ],
    }),
    installGlobalPrePushHook: vi.fn().mockReturnValue({
      ok: true,
      dryRun: false,
      hooksDir: '/home/alice/.config/git/hooks',
      hookPath: '/home/alice/.config/git/hooks/pre-push',
      hookBody: '# >>> prtokens >>>\nbody\n# <<< prtokens <<<',
      hookAction: 'installed',
      coreHooksPathAction: 'set',
    }),
    queuePath: '/state/prtokens/pending-prs.json',
    readPendingQueue: vi.fn().mockReturnValue({ version: 1, jobs: [] }),
    writePendingQueue: vi.fn(),
    enqueuePendingPr: vi.fn(),
    processPendingPrJobs: vi.fn().mockResolvedValue(undefined),
    now: vi.fn(() => new Date('2026-06-14T00:00:00.000Z')),
    sleep: vi.fn().mockResolvedValue(undefined),
    queueRetryDelayMs: 1,
    queueProcessMaxPasses: 3,
    cwd: '/repo',
    stdout: vi.fn(),
    stderr: vi.fn(),
    ...overrides,
  };
}

beforeEach(() => {
  vi.restoreAllMocks();
});

describe('runCli', () => {
  it('routes init to the hook installer and prints a setup summary', async () => {
    const deps = createDeps();

    await expect(runCli(['init'], deps)).resolves.toBe(0);

    expect(deps.installGlobalPrePushHook).toHaveBeenCalledWith({ dryRun: false });
    expect(deps.runPreflight).toHaveBeenCalledTimes(1);
    expect(deps.resolvePullRequest).not.toHaveBeenCalled();
    const output = (deps.stdout as Mock).mock.calls.map(([message]) => message).join('\n');
    expect(output).toContain('prtokens init complete');
    expect(output).toContain('Hook: installed at /home/alice/.config/git/hooks/pre-push');
    expect(output).toContain('core.hooksPath: set to /home/alice/.config/git/hooks');
    expect(output).toContain('Prerequisites:');
    expect(output).toContain('Push a branch that has an open PR and prtokens will comment.');
  });

  it('prints the init dry-run plan and hook body without installing', async () => {
    const deps = createDeps({
      installGlobalPrePushHook: vi.fn().mockReturnValue({
        ok: true,
        dryRun: true,
        hooksDir: '/home/alice/.config/git/hooks',
        hookPath: '/home/alice/.config/git/hooks/pre-push',
        hookBody: '# >>> prtokens >>>\nbody\n# <<< prtokens <<<',
        hookAction: 'installed',
        coreHooksPathAction: 'would-set',
      }),
    });

    await expect(runCli(['init', '--dry-run'], deps)).resolves.toBe(0);

    expect(deps.installGlobalPrePushHook).toHaveBeenCalledWith({ dryRun: true });
    const output = (deps.stdout as Mock).mock.calls.map(([message]) => message).join('\n');
    expect(output).toContain('prtokens init dry run');
    expect(output).toContain('Would install hook at /home/alice/.config/git/hooks/pre-push');
    expect(output).toContain('# >>> prtokens >>>\nbody\n# <<< prtokens <<<');
  });

  it('returns failure when init hook installation fails', async () => {
    const deps = createDeps({
      installGlobalPrePushHook: vi.fn().mockReturnValue({
        ok: false,
        dryRun: false,
        hooksDir: '/home/alice/.config/git/hooks',
        hookPath: '/home/alice/.config/git/hooks/pre-push',
        hookBody: '# >>> prtokens >>>\nbody\n# <<< prtokens <<<',
        hookAction: 'installed',
        coreHooksPathAction: 'set',
        error: 'permission denied',
      }),
    });

    await expect(runCli(['init'], deps)).resolves.toBe(1);

    expect(deps.stderr).toHaveBeenCalledWith('Failed to install pre-push hook at /home/alice/.config/git/hooks/pre-push: permission denied');
  });

  it('rejects unknown init flags without running report mode', async () => {
    const deps = createDeps();

    await expect(runCli(['init', '--json'], deps)).resolves.toBe(1);

    expect(deps.installGlobalPrePushHook).not.toHaveBeenCalled();
    expect(deps.resolvePullRequest).not.toHaveBeenCalled();
    expect(deps.stderr).toHaveBeenCalledWith(expect.stringContaining("Unknown option '--json'"));
  });

  it('keeps bare report mode unchanged', async () => {
    const deps = createDeps();

    await expect(runCli(['--dry-run'], deps)).resolves.toBe(0);

    expect(deps.installGlobalPrePushHook).not.toHaveBeenCalled();
    expect(deps.resolvePullRequest).toHaveBeenCalledWith({ cwd: '/repo' });
  });

  it('prints queue status', async () => {
    const deps = createDeps({
      readPendingQueue: vi.fn().mockReturnValue({
        version: 1,
        jobs: [{
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
        }],
      }),
    });

    await expect(runCli(['status'], deps)).resolves.toBe(0);

    expect(deps.readPendingQueue).toHaveBeenCalledWith('/state/prtokens/pending-prs.json');
    expect(deps.stdout).toHaveBeenCalledWith(expect.stringContaining('Pending PR posts'));
  });

  it('enqueues metadata when hook mode finds no PR', async () => {
    const deps = createDeps({
      resolvePullRequest: vi.fn().mockResolvedValue({ kind: 'no-pr', branch: 'feature/prtokens', message: 'No pull request found for current branch.' }),
    });

    await expect(runCli([
      '__hook-pushed-ref',
      '--remote-name', 'origin',
      '--remote-url', 'git@github.com:acme/prtokens.git',
      '--local-branch', 'feature/prtokens',
      '--remote-branch', 'feature/prtokens',
      '--head-sha', 'abcdef1234567890',
    ], deps)).resolves.toBe(0);

    expect(deps.enqueuePendingPr).toHaveBeenCalledWith('/state/prtokens/pending-prs.json', expect.objectContaining({
      repoRoot: '/repo',
      remoteName: 'origin',
      localBranch: 'feature/prtokens',
      remoteBranch: 'feature/prtokens',
      headSha: 'abcdef1234567890',
      status: 'pending',
    }));
    expect(deps.processPendingPrJobs).toHaveBeenCalledTimes(1);
  });

  it('does not fail pushes when hook metadata parsing fails', async () => {
    const deps = createDeps();

    await expect(runCli(['__hook-pushed-ref', '--remote-name', 'origin'], deps)).resolves.toBe(0);

    expect(deps.stderr).toHaveBeenCalledWith('Missing required hook pushed-ref metadata.');
    expect(deps.resolvePullRequest).not.toHaveBeenCalled();
    expect(deps.enqueuePendingPr).not.toHaveBeenCalled();
  });

  it('swallows hook enqueue errors so pushes can continue', async () => {
    const deps = createDeps({
      resolvePullRequest: vi.fn().mockResolvedValue({ kind: 'no-pr', branch: 'feature/prtokens', message: 'No pull request found for current branch.' }),
      enqueuePendingPr: vi.fn(() => {
        throw new Error('state path unavailable');
      }),
    });

    await expect(runCli([
      '__hook-pushed-ref',
      '--remote-name', 'origin',
      '--remote-url', 'git@github.com:acme/prtokens.git',
      '--local-branch', 'feature/prtokens',
      '--remote-branch', 'feature/prtokens',
      '--head-sha', 'abcdef1234567890',
    ], deps)).resolves.toBe(0);

    expect(deps.stderr).toHaveBeenCalledWith('state path unavailable');
    expect(deps.processPendingPrJobs).not.toHaveBeenCalled();
  });

  it('does not persist raw remote URLs from hook metadata', async () => {
    const deps = createDeps({
      resolvePullRequest: vi.fn().mockResolvedValue({ kind: 'no-pr', branch: 'feature/prtokens', message: 'No pull request found for current branch.' }),
    });

    await expect(runCli([
      '__hook-pushed-ref',
      '--remote-name', 'origin',
      '--remote-url', 'https://user:token@github.com/acme/prtokens.git',
      '--local-branch', 'feature/prtokens',
      '--remote-branch', 'feature/prtokens',
      '--head-sha', 'abcdef1234567890',
    ], deps)).resolves.toBe(0);

    expect(deps.enqueuePendingPr).toHaveBeenCalledTimes(1);
    expect(deps.enqueuePendingPr.mock.calls[0]?.[1]).not.toHaveProperty('remoteUrl');
  });

  it('enqueues hook metadata when remote URL is omitted', async () => {
    const deps = createDeps({
      resolvePullRequest: vi.fn().mockResolvedValue({ kind: 'no-pr', branch: 'feature/prtokens', message: 'No pull request found for current branch.' }),
    });

    await expect(runCli([
      '__hook-pushed-ref',
      '--remote-name', 'origin',
      '--local-branch', 'feature/prtokens',
      '--remote-branch', 'feature/prtokens',
      '--head-sha', 'abcdef1234567890',
    ], deps)).resolves.toBe(0);

    expect(deps.enqueuePendingPr).toHaveBeenCalledWith('/state/prtokens/pending-prs.json', expect.objectContaining({
      repoRoot: '/repo',
      remoteName: 'origin',
      localBranch: 'feature/prtokens',
      remoteBranch: 'feature/prtokens',
      headSha: 'abcdef1234567890',
      status: 'pending',
    }));
    expect(deps.enqueuePendingPr.mock.calls[0]?.[1]).not.toHaveProperty('remoteUrl');
  });

  it('merges process-queue writes with concurrently enqueued jobs', async () => {
    const originalJob = {
      id: 'job-original',
      repoRoot: '/repo',
      remoteName: 'origin',
      localBranch: 'feature/prtokens',
      remoteBranch: 'feature/prtokens',
      headSha: 'abcdef1234567890',
      queuedAt: '2026-06-14T00:00:00.000Z',
      attempts: 0,
      status: 'pending',
      lastResult: 'waiting for PR',
    };
    const concurrentJob = {
      id: 'job-concurrent',
      repoRoot: '/repo',
      remoteName: 'origin',
      localBranch: 'feature/other',
      remoteBranch: 'feature/other',
      headSha: '1234567890abcdef',
      queuedAt: '2026-06-14T00:01:00.000Z',
      attempts: 0,
      status: 'pending',
      lastResult: 'waiting for PR',
    };
    const processedJob = {
      ...originalJob,
      attempts: 1,
      status: 'completed',
      lastResult: 'posted PR #42',
    };
    const deps = createDeps({
      readPendingQueue: vi.fn()
        .mockReturnValueOnce({ version: 1, jobs: [originalJob] })
        .mockReturnValueOnce({ version: 1, jobs: [concurrentJob] }),
      processPendingPrJobs: vi.fn(async (options) => {
        options.writeQueue({ version: 1, jobs: [processedJob] });
      }),
    });

    await expect(runCli(['__process-queue'], deps)).resolves.toBe(0);

    expect(deps.processPendingPrJobs).toHaveBeenCalledTimes(1);
    expect(deps.writePendingQueue).toHaveBeenCalledWith('/state/prtokens/pending-prs.json', {
      version: 1,
      jobs: [processedJob, concurrentJob],
    });
  });

  it('retries pending process-queue jobs with a bounded delay', async () => {
    const originalJob = {
      id: 'job-original',
      repoRoot: '/repo',
      remoteName: 'origin',
      localBranch: 'feature/prtokens',
      remoteBranch: 'feature/prtokens',
      headSha: 'abcdef1234567890',
      queuedAt: '2026-06-14T00:00:00.000Z',
      attempts: 0,
      status: 'pending',
      lastResult: 'waiting for PR',
    };
    const pendingAfterFirstPass = {
      ...originalJob,
      attempts: 1,
      lastAttemptAt: '2026-06-14T00:00:00.000Z',
      lastResult: 'No pull request found for current branch.',
    };
    const completedAfterSecondPass = {
      ...pendingAfterFirstPass,
      attempts: 2,
      status: 'completed',
      lastResult: 'posted PR #42',
    };
    const deps = createDeps({
      queueRetryDelayMs: 10,
      queueProcessMaxPasses: 3,
      readPendingQueue: vi.fn()
        .mockReturnValueOnce({ version: 1, jobs: [originalJob] })
        .mockReturnValueOnce({ version: 1, jobs: [originalJob] })
        .mockReturnValueOnce({ version: 1, jobs: [pendingAfterFirstPass] })
        .mockReturnValueOnce({ version: 1, jobs: [pendingAfterFirstPass] }),
      processPendingPrJobs: vi.fn(async (options) => {
        if (options.queue.jobs[0]?.attempts === 0) {
          options.writeQueue({ version: 1, jobs: [pendingAfterFirstPass] });
          return;
        }
        options.writeQueue({ version: 1, jobs: [completedAfterSecondPass] });
      }),
    });

    await expect(runCli(['__process-queue'], deps)).resolves.toBe(0);

    expect(deps.processPendingPrJobs).toHaveBeenCalledTimes(2);
    expect(deps.sleep).toHaveBeenCalledWith(10);
    expect(deps.writePendingQueue).toHaveBeenLastCalledWith('/state/prtokens/pending-prs.json', {
      version: 1,
      jobs: [completedAfterSecondPass],
    });
  });

  it('keeps a more advanced concurrent same-ID queue update', async () => {
    const originalJob = {
      id: 'job-original',
      repoRoot: '/repo',
      remoteName: 'origin',
      localBranch: 'feature/prtokens',
      remoteBranch: 'feature/prtokens',
      headSha: 'abcdef1234567890',
      queuedAt: '2026-06-14T00:00:00.000Z',
      attempts: 0,
      status: 'pending',
      lastResult: 'waiting for PR',
    };
    const processedJob = {
      ...originalJob,
      attempts: 1,
      lastAttemptAt: '2026-06-14T00:00:10.000Z',
      lastResult: 'No pull request found for current branch.',
    };
    const concurrentlyAdvancedJob = {
      ...originalJob,
      attempts: 2,
      status: 'completed',
      lastAttemptAt: '2026-06-14T00:00:20.000Z',
      lastResult: 'posted PR #42',
    };
    const deps = createDeps({
      readPendingQueue: vi.fn()
        .mockReturnValueOnce({ version: 1, jobs: [originalJob] })
        .mockReturnValueOnce({ version: 1, jobs: [concurrentlyAdvancedJob] }),
      processPendingPrJobs: vi.fn(async (options) => {
        options.writeQueue({ version: 1, jobs: [processedJob] });
      }),
    });

    await expect(runCli(['__process-queue'], deps)).resolves.toBe(0);

    expect(deps.writePendingQueue).toHaveBeenCalledWith('/state/prtokens/pending-prs.json', {
      version: 1,
      jobs: [concurrentlyAdvancedJob],
    });
  });

  it('keeps terminal processed jobs over pending same-ID queue updates', async () => {
    const originalJob = {
      id: 'job-original',
      repoRoot: '/repo',
      remoteName: 'origin',
      localBranch: 'feature/prtokens',
      remoteBranch: 'feature/prtokens',
      headSha: 'abcdef1234567890',
      queuedAt: '2026-06-14T00:00:00.000Z',
      attempts: 0,
      status: 'pending',
      lastResult: 'waiting for PR',
    };
    const processedCompletedJob = {
      ...originalJob,
      attempts: 1,
      status: 'completed',
      lastAttemptAt: '2026-06-14T00:00:10.000Z',
      lastResult: 'posted PR #42',
    };
    const concurrentPendingJob = {
      ...originalJob,
      attempts: 2,
      lastAttemptAt: '2026-06-14T00:00:20.000Z',
      lastResult: 'No pull request found for current branch.',
    };
    const deps = createDeps({
      queueProcessMaxPasses: 1,
      readPendingQueue: vi.fn()
        .mockReturnValueOnce({ version: 1, jobs: [originalJob] })
        .mockReturnValueOnce({ version: 1, jobs: [concurrentPendingJob] }),
      processPendingPrJobs: vi.fn(async (options) => {
        options.writeQueue({ version: 1, jobs: [processedCompletedJob] });
      }),
    });

    await expect(runCli(['__process-queue'], deps)).resolves.toBe(0);

    expect(deps.writePendingQueue).toHaveBeenCalledWith('/state/prtokens/pending-prs.json', {
      version: 1,
      jobs: [processedCompletedJob],
    });
  });

  it('uses the shared posting flow for default report mode', async () => {
    const deps = createDeps();

    await expect(runCli([], deps)).resolves.toBe(0);

    expect(deps.resolvePullRequest).toHaveBeenCalledWith({ cwd: '/repo' });
    expect(deps.readAllUsage).toHaveBeenCalledTimes(1);
    expect(deps.ensureGhReady).toHaveBeenCalledTimes(1);
    expect(deps.upsertPrComment).toHaveBeenCalledTimes(1);
  });

  it('passes resolved worktree roots to usage readers', async () => {
    const deps = createDeps({
      cwd: '/repo/.worktrees/feature',
      resolvePullRequest: vi.fn().mockResolvedValue(
        okPr({
          repoRoot: '/repo/.worktrees/feature',
          worktreeRoots: ['/repo', '/repo/.worktrees/feature'],
        }),
      ),
    });

    await expect(runCli(['--dry-run'], deps)).resolves.toBe(0);

    expect(deps.readAllUsage).toHaveBeenCalledWith({
      repoRoot: '/repo/.worktrees/feature',
      repoRootAliases: ['/repo', '/repo/.worktrees/feature'],
    });
  });

  it('--dry-run prints markdown and does not check gh or post', async () => {
    const deps = createDeps();

    await expect(runCli(['--dry-run'], deps)).resolves.toBe(0);

    expect(deps.stdout).toHaveBeenCalledTimes(1);
    const markdown = deps.stdout.mock.calls[0]?.[0];
    expect(markdown).toContain('<!-- prtokens:v1 -->');
    expect(markdown).toContain('### 🪙 This PR cost ~$0.00 in tokens');
    expect(markdown).not.toContain('### @octocat');
    expect(markdown).toContain('| Commit | Message | In | Out | Cost | Sessions |');
    expect(markdown).not.toContain('Cache Write');
    expect(markdown).not.toContain('Cache Read');
    expect(markdown).not.toContain('Cost includes prompt-cache write/read tokens when reported by the coding agent.');
    expect(markdown).toContain('*generated by prtokens*');
    expect(markdown).not.toContain('uses agent-reported costs when available');
    expect(deps.ensureGhReady).not.toHaveBeenCalled();
    expect(deps.upsertPrComment).not.toHaveBeenCalled();
  });

  it('uses the authenticated GitHub user login for the current author section', async () => {
    const deps = createDeps({
      resolvePullRequest: vi.fn().mockResolvedValue(
        okPr({
          pr: {
            number: 42,
            url: 'https://github.com/acme/prtokens/pull/42',
            headRefName: 'feature/prtokens',
            authorLogin: 'pr-author',
            currentUserLogin: 'runner-user',
            repository: 'acme/prtokens',
          },
          commits: [commit({ authorLogin: 'pr-author' })],
        }),
      ),
    });

    await expect(runCli(['--dry-run'], deps)).resolves.toBe(0);

    const markdown = deps.stdout.mock.calls[0]?.[0];
    expect(markdown).toContain('<!-- prtokens:author:runner-user ');
    expect(markdown).not.toContain('### @runner-user');
    expect(markdown).not.toContain('<!-- prtokens:author:pr-author ');
    expect(markdown).not.toContain('### @pr-author');
  });

  it('--json prints machine-readable payload with per-agent totals and markdown', async () => {
    const deps = createDeps({
      readAllUsage: vi.fn().mockResolvedValue(allUsage({
        events: [
          usageEvent({ model: 'vercel_ai_gateway/anthropic/claude-3-5-sonnet-20241022' }),
          usageEvent({
            id: 'event-2',
            agent: 'codex',
            model: 'codex-mini-latest',
            inputTokens: 0,
            outputTokens: 0,
            cacheWriteTokens: 0,
            cacheReadTokens: 0,
            sessionId: 'session-2',
          }),
        ],
        diagnostics: {
          'claude-code': diagnostics({ scannedFileCount: 1 }),
          codex: diagnostics({ scannedFileCount: 1 }),
          opencode: diagnostics(),
        },
      })),
    });

    await expect(runCli(['--json'], deps)).resolves.toBe(0);

    expect(deps.stdout).toHaveBeenCalledTimes(1);
    const payload = JSON.parse(deps.stdout.mock.calls[0]?.[0]);
    expect(Object.keys(payload).sort()).toEqual(['agentTotals', 'attribution', 'diagnostics', 'markdown', 'pr', 'pricing'].sort());
    expect(payload.pr.number).toBe(42);
    expect(payload.agentTotals.map((agent) => agent.agent)).toEqual(['claude-code', 'codex']);
    expect(payload.diagnostics.codex.scannedFileCount).toBe(1);
    expect(payload.markdown).toContain('<!-- prtokens:v1 -->');
    expect(payload.markdown).toContain('Agents:');
    expect(payload.attribution.preFirstCommit).toBeUndefined();
    expect(payload.attribution.buckets[0]).toMatchObject({ cacheWriteTokens: 100, cacheReadTokens: 50 });
    expect(deps.ensureGhReady).not.toHaveBeenCalled();
    expect(deps.upsertPrComment).not.toHaveBeenCalled();
  });

  it('prints resolver message and exits successfully when no open PR exists', async () => {
    const deps = createDeps({
      resolvePullRequest: vi.fn().mockResolvedValue({
        kind: 'no-pr',
        branch: 'feature/prtokens',
        message: 'No pull request found for current branch.',
      }),
    });

    await expect(runCli([], deps)).resolves.toBe(0);

    expect(deps.stdout).toHaveBeenCalledWith('No pull request found for current branch.');
    expect(deps.readAllUsage).not.toHaveBeenCalled();
    expect(deps.ensureGhReady).not.toHaveBeenCalled();
    expect(deps.upsertPrComment).not.toHaveBeenCalled();
  });

  it('prints gh setup guidance when PR resolution fails because gh is missing', async () => {
    const deps = createDeps({
      resolvePullRequest: vi.fn().mockRejectedValue(new Error('spawn gh ENOENT')),
    });

    await expect(runCli([], deps)).resolves.toBe(1);

    expect(deps.stderr).toHaveBeenCalledWith('Install GitHub CLI and run gh auth login.');
    expect(deps.readAllUsage).not.toHaveBeenCalled();
    expect(deps.ensureGhReady).not.toHaveBeenCalled();
    expect(deps.upsertPrComment).not.toHaveBeenCalled();
  });

  it('prints gh setup guidance when PR resolution fails because gh is unauthenticated', async () => {
    const deps = createDeps({
      resolvePullRequest: vi.fn().mockRejectedValue(Object.assign(new Error('gh failed'), { stderr: 'authentication required' })),
    });

    await expect(runCli([], deps)).resolves.toBe(1);

    expect(deps.stderr).toHaveBeenCalledWith('Install GitHub CLI and run gh auth login.');
    expect(deps.readAllUsage).not.toHaveBeenCalled();
    expect(deps.ensureGhReady).not.toHaveBeenCalled();
    expect(deps.upsertPrComment).not.toHaveBeenCalled();
  });

  it('does not convert unrelated PR resolution errors to gh setup guidance', async () => {
    const deps = createDeps({
      resolvePullRequest: vi.fn().mockRejectedValue(new Error('git failed unexpectedly')),
    });

    await expect(runCli([], deps)).rejects.toThrow('git failed unexpectedly');

    expect(deps.stderr).not.toHaveBeenCalledWith('Install GitHub CLI and run gh auth login.');
    expect(deps.readAllUsage).not.toHaveBeenCalled();
    expect(deps.ensureGhReady).not.toHaveBeenCalled();
    expect(deps.upsertPrComment).not.toHaveBeenCalled();
  });

  it('prints friendly message and exits successfully when no usage exists', async () => {
    const deps = createDeps({
      readAllUsage: vi.fn().mockResolvedValue(allUsage({ events: [] })),
    });

    await expect(runCli([], deps)).resolves.toBe(0);

    expect(deps.stdout).toHaveBeenCalledWith('No coding-agent usage found for this repo (checked Claude Code, Codex, OpenCode).');
    expect(deps.ensureGhReady).not.toHaveBeenCalled();
    expect(deps.upsertPrComment).not.toHaveBeenCalled();
  });

  it('--verbose prints diagnostics when no usage exists', async () => {
    const deps = createDeps({
      readAllUsage: vi.fn().mockResolvedValue(allUsage({
        events: [],
        diagnostics: {
          'claude-code': diagnostics({ scannedFileCount: 7, malformedLineCount: 2, dedupedEventCount: 4, skippedLineCount: 3 }),
          codex: diagnostics(),
          opencode: diagnostics(),
        },
      })),
    });

    await expect(runCli(['--verbose'], deps)).resolves.toBe(0);

    expect(deps.stdout).toHaveBeenCalledWith('No coding-agent usage found for this repo (checked Claude Code, Codex, OpenCode).');
    const stderr = deps.stderr.mock.calls.map(([message]) => message).join('\n');
    expect(stderr).toContain('claude-code: malformed-line-count: 2');
    expect(stderr).toContain('claude-code: skipped-line-count: 3');
    expect(stderr).toContain('claude-code: dedupe-count: 4');
  });

  it('prints gh setup guidance and returns failure when gh is unavailable', async () => {
    const deps = createDeps({
      ensureGhReady: vi.fn().mockResolvedValue({ ok: false, message: 'Install GitHub CLI and run gh auth login.' }),
    });

    await expect(runCli([], deps)).resolves.toBe(1);

    expect(deps.stderr).toHaveBeenCalledWith('Install GitHub CLI and run gh auth login.');
    expect(deps.upsertPrComment).not.toHaveBeenCalled();
  });

  it('prints rendered markdown and exits successfully when posting fails', async () => {
    const deps = createDeps({
      upsertPrComment: vi.fn().mockResolvedValue({ ok: false, renderedMarkdown: 'rendered fallback', error: 'boom' }),
    });

    await expect(runCli([], deps)).resolves.toBe(0);

    expect(deps.stdout).toHaveBeenCalledWith('rendered fallback');
  });

  it('passes existing comment body into post-mode rendering before patching', async () => {
    const existingBody = renderPrComment({
      currentAuthor: {
        login: 'other-author',
        totalCostUsd: 1,
        inputTokens: 100_000,
        outputTokens: 10_000,
        cacheWriteTokens: 0,
        cacheReadTokens: 0,
        sessionCount: 1,
        models: ['claude-sonnet-4-6'],
        attributedPercent: 100,
        lowConfidencePercent: 0,
        rows: [
          {
            sha: 'abc9999',
            message: 'other author work',
            inputTokens: 100_000,
            outputTokens: 10_000,
            cacheWriteTokens: 0,
            cacheReadTokens: 0,
            costUsd: 1,
            sessionCount: 1,
          },
        ],
      },
    });
    const deps = createDeps({
      resolvePullRequest: vi.fn().mockResolvedValue(
        okPr({
          pr: {
            number: 42,
            url: 'https://github.com/acme/prtokens/pull/42',
            headRefName: 'feature/prtokens',
            authorLogin: 'pr-author',
            currentUserLogin: 'runner-user',
            repository: 'acme/prtokens',
          },
        }),
      ),
      upsertPrComment: vi.fn().mockImplementation(async (input) => {
        const markdown = input.renderMarkdown(existingBody);
        expect(markdown).toContain('<!-- prtokens:author:other-author ');
        expect(markdown).toContain('**@other-author** · ~$1.00');
        expect(markdown).toContain('<!-- prtokens:author:runner-user ');
        expect(markdown).toContain('**@runner-user** · ~$0.00');
        return { ok: true };
      }),
    });

    await expect(runCli([], deps)).resolves.toBe(0);

    expect(deps.upsertPrComment).toHaveBeenCalledTimes(1);
    expect(deps.upsertPrComment.mock.calls[0]?.[0]).toMatchObject({
      repository: 'acme/prtokens',
      prNumber: 42,
    });
    expect(deps.upsertPrComment.mock.calls[0]?.[0].renderMarkdown).toEqual(expect.any(Function));
  });

  it('--verbose includes per-source diagnostics on stderr', async () => {
    const deps = createDeps({
      readAllUsage: vi.fn().mockResolvedValue(allUsage({
        events: [usageEvent()],
        diagnostics: {
          'claude-code': diagnostics({ scannedFileCount: 5 }),
          codex: diagnostics({ scannedFileCount: 1, malformedLineCount: 1 }),
          opencode: diagnostics({ warningMessages: ['OpenCode skipped: node:sqlite unavailable'] }),
        },
      })),
    });

    await expect(runCli(['--verbose', '--dry-run'], deps)).resolves.toBe(0);

    const stderr = deps.stderr.mock.calls.map(([message]) => message).join('\n');
    expect(stderr).toContain('claude-code: scanned-file-count: 5');
    expect(stderr).toContain('codex: malformed-line-count: 1');
    expect(stderr).toContain('opencode: OpenCode skipped: node:sqlite unavailable');
  });

  it('--pr passes the PR number to the resolver', async () => {
    const deps = createDeps();

    await expect(runCli(['--pr', '123', '--dry-run'], deps)).resolves.toBe(0);

    expect(deps.resolvePullRequest).toHaveBeenCalledWith({ cwd: '/repo', prNumber: 123 });
  });

  it('excludes branch-unknown pre-first-commit usage from rendered PR totals', async () => {
    const deps = createDeps({
      readAllUsage: vi.fn().mockResolvedValue(allUsage({
        events: [
          usageEvent({
            gitBranch: undefined,
            timestamp: '2024-01-01T00:00:00.000Z',
            inputTokens: 100,
            outputTokens: 10,
            cacheWriteTokens: 0,
            cacheReadTokens: 50,
          }),
        ],
      })),
      resolvePullRequest: vi.fn().mockResolvedValue(okPr({
        commits: [commit({ authoredAt: '2024-01-01T00:05:00.000Z' })],
      })),
    });

    await expect(runCli(['--dry-run'], deps)).resolves.toBe(0);

    const markdown = deps.stdout.mock.calls[0]?.[0];
    expect(markdown).toContain('### 🪙 This PR cost ~$0.00 in tokens');
    expect(markdown).not.toContain('pre-first-commit work');
    expect(markdown).toContain('| `abcdef1` | Add CLI wiring | 0 | 0 | ~$0.00 | 0 |');
    expect(markdown).not.toContain('Cache Write');
    expect(markdown).not.toContain('Cache Read');
  });

  it('excludes uncommitted tail usage from rendered PR totals while keeping JSON diagnostics', async () => {
    const deps = createDeps({
      readAllUsage: vi.fn().mockResolvedValue(allUsage({
        events: [
          usageEvent({
            id: 'committed-event',
            timestamp: '2024-01-01T00:04:00.000Z',
            inputTokens: 100,
            outputTokens: 10,
            cacheWriteTokens: 0,
            cacheReadTokens: 0,
            sourceCostUsd: 1,
          }),
          usageEvent({
            id: 'tail-event',
            timestamp: '2024-01-01T00:10:00.000Z',
            inputTokens: 300,
            outputTokens: 30,
            cacheWriteTokens: 0,
            cacheReadTokens: 0,
            sessionId: 'session-tail',
            sourceCostUsd: 3,
          }),
        ],
      })),
    });

    await expect(runCli(['--json'], deps)).resolves.toBe(0);

    const payload = JSON.parse(deps.stdout.mock.calls[0]?.[0]);
    expect(payload.pricing.totalCostUsd).toBe(1);
    expect(payload.pricing.uncommittedTail.costUsd).toBe(3);
    expect(payload.agentTotals).toEqual([
      expect.objectContaining({ agent: 'claude-code', costUsd: 1, inputTokens: 100, outputTokens: 10, sessionCount: 1 }),
    ]);
    expect(payload.markdown).toContain('### 🪙 This PR cost ~$1.00 in tokens');
    expect(payload.markdown).toContain('| `abcdef1` | Add CLI wiring | 100 | 10 | ~$1.00 | 1 |');
    expect(payload.markdown).not.toContain('uncommitted tail');
    expect(payload.markdown).not.toContain('~$3.00');
  });
});

describe('postPrtokensForCurrentRepo', () => {
  it('passes the provided runner to PR resolution', async () => {
    const deps = createDeps();
    const runner = { run: vi.fn() };

    await expect(postPrtokensForCurrentRepo({
      cwd: '/repo',
      dryRun: true,
      json: false,
      verbose: false,
      stdout: deps.stdout,
      stderr: deps.stderr,
      readAllUsage: deps.readAllUsage,
      resolvePullRequest: deps.resolvePullRequest,
      ensureGhReady: deps.ensureGhReady,
      upsertPrComment: deps.upsertPrComment,
      runner,
    })).resolves.toMatchObject({ kind: 'dry-run' });

    expect(deps.resolvePullRequest).toHaveBeenCalledWith({ cwd: '/repo', runner });
  });

  it('normalizes gh setup failures from PR resolution', async () => {
    const deps = createDeps({
      resolvePullRequest: vi.fn().mockRejectedValue(new Error('spawn gh ENOENT')),
    });

    await expect(postPrtokensForCurrentRepo({
      cwd: '/repo',
      dryRun: false,
      json: false,
      verbose: false,
      stdout: deps.stdout,
      stderr: deps.stderr,
      readAllUsage: deps.readAllUsage,
      resolvePullRequest: deps.resolvePullRequest,
      ensureGhReady: deps.ensureGhReady,
      upsertPrComment: deps.upsertPrComment,
    })).resolves.toEqual({ kind: 'gh-not-ready', message: ghSetupMessage });

    expect(deps.readAllUsage).not.toHaveBeenCalled();
    expect(deps.ensureGhReady).not.toHaveBeenCalled();
    expect(deps.upsertPrComment).not.toHaveBeenCalled();
  });
});

describe('isEntrypoint', () => {
  it('matches npm bin symlinks that resolve to the CLI module', () => {
    const cliPath = realpathSync(fileURLToPath(new URL('../src/cli.ts', import.meta.url)));
    const binDirectory = mkdtempSync(join(tmpdir(), 'prtokens-bin-'));
    const binPath = join(binDirectory, 'prtokens');
    symlinkSync(cliPath, binPath);

    expect(isEntrypoint(pathToFileURL(cliPath).href, binPath)).toBe(true);
  });
});
