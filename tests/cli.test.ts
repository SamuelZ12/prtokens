import { mkdtempSync, realpathSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { isEntrypoint, runCli } from '../src/cli.js';

function usageEvent(overrides = {}) {
  return {
    id: 'event-1',
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

function createDeps(overrides = {}) {
  return {
    readClaudeTranscripts: vi.fn().mockResolvedValue({
      events: [usageEvent()],
      diagnostics: {
        scannedFileCount: 1,
        malformedLineCount: 0,
        dedupedEventCount: 0,
        skippedLineCount: 0,
      },
    }),
    resolvePullRequest: vi.fn().mockResolvedValue(okPr()),
    ensureGhReady: vi.fn().mockResolvedValue({ ok: true }),
    upsertPrComment: vi.fn().mockResolvedValue({ ok: true }),
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
  it('--dry-run prints markdown and does not check gh or post', async () => {
    const deps = createDeps();

    await expect(runCli(['--dry-run'], deps)).resolves.toBe(0);

    expect(deps.stdout).toHaveBeenCalledTimes(1);
    expect(deps.stdout.mock.calls[0]?.[0]).toContain('<!-- prtokens:v1 -->');
    expect(deps.stdout.mock.calls[0]?.[0]).toContain('@octocat');
    expect(deps.ensureGhReady).not.toHaveBeenCalled();
    expect(deps.upsertPrComment).not.toHaveBeenCalled();
  });

  it('--json prints machine-readable payload and does not check gh or post', async () => {
    const deps = createDeps();

    await expect(runCli(['--json'], deps)).resolves.toBe(0);

    expect(deps.stdout).toHaveBeenCalledTimes(1);
    const payload = JSON.parse(deps.stdout.mock.calls[0]?.[0]);
    expect(Object.keys(payload).sort()).toEqual(['attribution', 'diagnostics', 'markdown', 'pr', 'pricing'].sort());
    expect(payload.pr.number).toBe(42);
    expect(payload.markdown).toContain('<!-- prtokens:v1 -->');
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
    expect(deps.readClaudeTranscripts).not.toHaveBeenCalled();
    expect(deps.ensureGhReady).not.toHaveBeenCalled();
    expect(deps.upsertPrComment).not.toHaveBeenCalled();
  });

  it('prints gh setup guidance when PR resolution fails because gh is missing', async () => {
    const deps = createDeps({
      resolvePullRequest: vi.fn().mockRejectedValue(new Error('spawn gh ENOENT')),
    });

    await expect(runCli([], deps)).resolves.toBe(1);

    expect(deps.stderr).toHaveBeenCalledWith('Install GitHub CLI and run gh auth login.');
    expect(deps.readClaudeTranscripts).not.toHaveBeenCalled();
    expect(deps.ensureGhReady).not.toHaveBeenCalled();
    expect(deps.upsertPrComment).not.toHaveBeenCalled();
  });

  it('prints gh setup guidance when PR resolution fails because gh is unauthenticated', async () => {
    const deps = createDeps({
      resolvePullRequest: vi.fn().mockRejectedValue(Object.assign(new Error('gh failed'), { stderr: 'authentication required' })),
    });

    await expect(runCli([], deps)).resolves.toBe(1);

    expect(deps.stderr).toHaveBeenCalledWith('Install GitHub CLI and run gh auth login.');
    expect(deps.readClaudeTranscripts).not.toHaveBeenCalled();
    expect(deps.ensureGhReady).not.toHaveBeenCalled();
    expect(deps.upsertPrComment).not.toHaveBeenCalled();
  });

  it('does not convert unrelated PR resolution errors to gh setup guidance', async () => {
    const deps = createDeps({
      resolvePullRequest: vi.fn().mockRejectedValue(new Error('git failed unexpectedly')),
    });

    await expect(runCli([], deps)).rejects.toThrow('git failed unexpectedly');

    expect(deps.stderr).not.toHaveBeenCalledWith('Install GitHub CLI and run gh auth login.');
    expect(deps.readClaudeTranscripts).not.toHaveBeenCalled();
    expect(deps.ensureGhReady).not.toHaveBeenCalled();
    expect(deps.upsertPrComment).not.toHaveBeenCalled();
  });

  it('prints friendly message and exits successfully when no transcripts exist', async () => {
    const deps = createDeps({
      readClaudeTranscripts: vi.fn().mockResolvedValue({
        events: [],
        diagnostics: {
          scannedFileCount: 0,
          malformedLineCount: 0,
          dedupedEventCount: 0,
          skippedLineCount: 0,
        },
      }),
    });

    await expect(runCli([], deps)).resolves.toBe(0);

    expect(deps.stdout).toHaveBeenCalledWith('No Claude Code transcripts found for this repo.');
    expect(deps.ensureGhReady).not.toHaveBeenCalled();
    expect(deps.upsertPrComment).not.toHaveBeenCalled();
  });

  it('--verbose prints diagnostics when no transcripts exist', async () => {
    const deps = createDeps({
      readClaudeTranscripts: vi.fn().mockResolvedValue({
        events: [],
        diagnostics: {
          scannedFileCount: 7,
          malformedLineCount: 2,
          dedupedEventCount: 4,
          skippedLineCount: 3,
        },
      }),
    });

    await expect(runCli(['--verbose'], deps)).resolves.toBe(0);

    expect(deps.stdout).toHaveBeenCalledWith('No Claude Code transcripts found for this repo.');
    const stderr = deps.stderr.mock.calls.map(([message]) => message).join('\n');
    expect(stderr).toContain('malformed-line-count: 2');
    expect(stderr).toContain('skipped-line-count: 3');
    expect(stderr).toContain('dedupe-count: 4');
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

  it('--verbose includes transcript diagnostics on stderr', async () => {
    const deps = createDeps({
      readClaudeTranscripts: vi.fn().mockResolvedValue({
        events: [usageEvent()],
        diagnostics: {
          scannedFileCount: 5,
          malformedLineCount: 2,
          dedupedEventCount: 4,
          skippedLineCount: 3,
        },
      }),
    });

    await expect(runCli(['--verbose', '--dry-run'], deps)).resolves.toBe(0);

    const stderr = deps.stderr.mock.calls.map(([message]) => message).join('\n');
    expect(stderr).toContain('malformed-line-count: 2');
    expect(stderr).toContain('skipped-line-count: 3');
    expect(stderr).toContain('dedupe-count: 4');
  });

  it('--pr passes the PR number to the resolver', async () => {
    const deps = createDeps();

    await expect(runCli(['--pr', '123', '--dry-run'], deps)).resolves.toBe(0);

    expect(deps.resolvePullRequest).toHaveBeenCalledWith({ cwd: '/repo', prNumber: 123 });
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
