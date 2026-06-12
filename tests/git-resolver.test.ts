import { describe, expect, it } from 'vitest';
import { resolvePullRequest, type CommandRunner } from '../src/git-resolver.js';

interface RecordedCommand {
  command: string;
  args: string[];
  input?: string;
}

function createRunner(
  handler: (command: string, args: string[], options?: { cwd?: string; input?: string }) => Promise<{ stdout: string; stderr: string }> | { stdout: string; stderr: string },
): CommandRunner & { commands: RecordedCommand[] } {
  const commands: RecordedCommand[] = [];

  return {
    commands,
    async run(command, args, options) {
      commands.push({ command, args, input: options?.input });
      return handler(command, args, options);
    },
  };
}

const prJson = {
  number: 12,
  url: 'https://github.com/sam/prtokens/pull/12',
  headRefName: 'feature',
  baseRefName: 'main',
  author: { login: 'sam' },
  commits: [{ oid: 'def', messageHeadline: 'feat', authoredDate: '2026-06-12T10:00:00Z' }],
};

describe('resolvePullRequest', () => {
  it('finds the current branch open PR through gh pr view', async () => {
    const runner = createRunner((command, args) => {
      if (command === 'git' && args.join(' ') === 'branch --show-current') return { stdout: 'feature\n', stderr: '' };
      if (command === 'git' && args.join(' ') === 'rev-parse --show-toplevel') return { stdout: '/repo\n', stderr: '' };
      if (command === 'gh' && args[0] === 'pr') return { stdout: JSON.stringify(prJson), stderr: '' };
      if (command === 'gh' && args.join(' ') === 'repo view --json nameWithOwner') {
        return { stdout: JSON.stringify({ nameWithOwner: 'sam/prtokens' }), stderr: '' };
      }
      if (command === 'git' && args[0] === 'log') {
        return { stdout: 'def\u00002026-06-12T10:00:00Z\u0000feat\n', stderr: '' };
      }
      if (command === 'git' && args[0] === 'show') return { stdout: 'diff for def', stderr: '' };
      if (command === 'git' && args.join(' ') === 'patch-id --stable') return { stdout: 'patch-1 def\n', stderr: '' };
      throw new Error(`unexpected command: ${command} ${args.join(' ')}`);
    });

    const result = await resolvePullRequest({ runner });

    expect(result.kind).toBe('ok');
    expect(result.branch).toBe('feature');
    expect(result.kind === 'ok' ? result.pr.number : undefined).toBe(12);
  });

  it('includes the authenticated GitHub user login in PR info', async () => {
    const runner = createRunner((command, args) => {
      if (command === 'git' && args.join(' ') === 'branch --show-current') return { stdout: 'feature\n', stderr: '' };
      if (command === 'git' && args.join(' ') === 'rev-parse --show-toplevel') return { stdout: '/repo\n', stderr: '' };
      if (command === 'gh' && args[0] === 'pr') {
        return { stdout: JSON.stringify({ ...prJson, author: { login: 'pr-author' } }), stderr: '' };
      }
      if (command === 'gh' && args.join(' ') === 'api user --jq .login') return { stdout: 'runner-user\n', stderr: '' };
      if (command === 'gh' && args.join(' ') === 'repo view --json nameWithOwner') {
        return { stdout: JSON.stringify({ nameWithOwner: 'sam/prtokens' }), stderr: '' };
      }
      if (command === 'git' && args[0] === 'log') {
        return { stdout: 'def\u00002026-06-12T10:00:00Z\u0000feat\n', stderr: '' };
      }
      if (command === 'git' && args[0] === 'show') return { stdout: 'diff for def', stderr: '' };
      if (command === 'git' && args.join(' ') === 'patch-id --stable') return { stdout: 'patch-1 def\n', stderr: '' };
      throw new Error(`unexpected command: ${command} ${args.join(' ')}`);
    });

    const result = await resolvePullRequest({ runner });

    expect(result.kind).toBe('ok');
    expect(result.kind === 'ok' ? result.pr.authorLogin : undefined).toBe('pr-author');
    expect(result.kind === 'ok' ? result.pr.currentUserLogin : undefined).toBe('runner-user');
  });

  it('derives the posting repository from the PR url rather than gh repo view', async () => {
    const forkPrJson = {
      ...prJson,
      number: 3,
      url: 'https://github.com/SamuelZ12/TradingAgents/pull/3',
    };
    const runner = createRunner((command, args) => {
      if (command === 'git' && args.join(' ') === 'branch --show-current') return { stdout: 'feature\n', stderr: '' };
      if (command === 'git' && args.join(' ') === 'rev-parse --show-toplevel') return { stdout: '/repo\n', stderr: '' };
      if (command === 'gh' && args[0] === 'pr') return { stdout: JSON.stringify(forkPrJson), stderr: '' };
      if (command === 'gh' && args.join(' ') === 'repo view --json nameWithOwner') {
        // In a fork checkout gh resolves the upstream repo, not the fork the PR lives on.
        return { stdout: JSON.stringify({ nameWithOwner: 'TauricResearch/TradingAgents' }), stderr: '' };
      }
      if (command === 'git' && args[0] === 'log') {
        return { stdout: 'def\u00002026-06-12T10:00:00Z\u0000feat\n', stderr: '' };
      }
      if (command === 'git' && args[0] === 'show') return { stdout: 'diff for def', stderr: '' };
      if (command === 'git' && args.join(' ') === 'patch-id --stable') return { stdout: 'patch-1 def\n', stderr: '' };
      throw new Error(`unexpected command: ${command} ${args.join(' ')}`);
    });

    const result = await resolvePullRequest({ runner });

    expect(result.kind).toBe('ok');
    expect(result.kind === 'ok' ? result.pr.repository : undefined).toBe('SamuelZ12/TradingAgents');
    expect(runner.commands.some((entry) => entry.command === 'gh' && entry.args[0] === 'repo')).toBe(false);
  });

  it('returns no-pr without invoking gh when the current directory is not a git repository', async () => {
    const runner = createRunner((command, args) => {
      if (command === 'git' && args.join(' ') === 'branch --show-current') {
        throw Object.assign(new Error('git failed'), { exitCode: 128, stderr: 'fatal: not a git repository' });
      }
      throw new Error(`unexpected command: ${command} ${args.join(' ')}`);
    });

    const result = await resolvePullRequest({ runner });

    expect(result).toMatchObject({ kind: 'no-pr', branch: '' });
    expect(runner.commands.some((command) => command.command === 'gh')).toBe(false);
  });

  it('returns no-pr instead of throwing when gh pr view finds no pull requests', async () => {
    const runner = createRunner((command, args) => {
      if (command === 'git' && args.join(' ') === 'branch --show-current') return { stdout: 'feature\n', stderr: '' };
      if (command === 'git' && args.join(' ') === 'rev-parse --show-toplevel') return { stdout: '/repo\n', stderr: '' };
      if (command === 'gh' && args[0] === 'pr') {
        throw Object.assign(new Error('gh pr view failed'), { exitCode: 1, stderr: 'no pull requests found' });
      }
      throw new Error(`unexpected command: ${command} ${args.join(' ')}`);
    });

    const result = await resolvePullRequest({ runner });

    expect(result).toMatchObject({ kind: 'no-pr', branch: 'feature' });
  });

  it('returns no-pr instead of throwing when gh pr view cannot find git remotes', async () => {
    const runner = createRunner((command, args) => {
      if (command === 'git' && args.join(' ') === 'branch --show-current') return { stdout: 'feature\n', stderr: '' };
      if (command === 'git' && args.join(' ') === 'rev-parse --show-toplevel') return { stdout: '/repo\n', stderr: '' };
      if (command === 'gh' && args[0] === 'pr') {
        throw Object.assign(new Error('gh failed'), { exitCode: 1, stderr: 'no git remotes found' });
      }
      throw new Error(`unexpected command: ${command} ${args.join(' ')}`);
    });

    const result = await resolvePullRequest({ runner });

    expect(result).toMatchObject({ kind: 'no-pr', branch: 'feature' });
  });

  it('matches local commits to PR commits by patch-id rather than SHA', async () => {
    const runner = createRunner((command, args, options) => {
      if (command === 'git' && args.join(' ') === 'branch --show-current') return { stdout: 'feature\n', stderr: '' };
      if (command === 'git' && args.join(' ') === 'rev-parse --show-toplevel') return { stdout: '/repo\n', stderr: '' };
      if (command === 'gh' && args[0] === 'pr') return { stdout: JSON.stringify(prJson), stderr: '' };
      if (command === 'gh' && args.join(' ') === 'repo view --json nameWithOwner') {
        return { stdout: JSON.stringify({ nameWithOwner: 'sam/prtokens' }), stderr: '' };
      }
      if (command === 'git' && args[0] === 'log') {
        return { stdout: 'abc\u00002026-06-12T10:00:00Z\u0000local feat\n', stderr: '' };
      }
      if (command === 'git' && args.join(' ') === 'show abc --pretty=format:') return { stdout: 'local diff', stderr: '' };
      if (command === 'git' && args.join(' ') === 'show def --pretty=format:') return { stdout: 'pr diff', stderr: '' };
      if (command === 'git' && args.join(' ') === 'patch-id --stable' && options?.input === 'local diff') {
        return { stdout: 'patch-1 abc\n', stderr: '' };
      }
      if (command === 'git' && args.join(' ') === 'patch-id --stable' && options?.input === 'pr diff') {
        return { stdout: 'patch-1 def\n', stderr: '' };
      }
      throw new Error(`unexpected command: ${command} ${args.join(' ')}`);
    });

    const result = await resolvePullRequest({ runner });

    expect(result.kind).toBe('ok');
    expect(result.kind === 'ok' ? result.commits : []).toEqual([
      {
        sha: 'def',
        patchId: 'patch-1',
        message: 'feat',
        authorLogin: 'sam',
        authoredAt: '2026-06-12T10:00:00Z',
      },
    ]);
  });

  it('does not match commits when local and PR patch-id output is empty', async () => {
    const runner = createRunner((command, args, options) => {
      if (command === 'git' && args.join(' ') === 'branch --show-current') return { stdout: 'feature\n', stderr: '' };
      if (command === 'git' && args.join(' ') === 'rev-parse --show-toplevel') return { stdout: '/repo\n', stderr: '' };
      if (command === 'gh' && args[0] === 'pr') return { stdout: JSON.stringify(prJson), stderr: '' };
      if (command === 'gh' && args.join(' ') === 'repo view --json nameWithOwner') {
        return { stdout: JSON.stringify({ nameWithOwner: 'sam/prtokens' }), stderr: '' };
      }
      if (command === 'git' && args[0] === 'log') {
        return { stdout: 'abc\u00002026-06-12T10:00:00Z\u0000local feat\n', stderr: '' };
      }
      if (command === 'git' && args.join(' ') === 'show abc --pretty=format:') return { stdout: 'local diff', stderr: '' };
      if (command === 'git' && args.join(' ') === 'show def --pretty=format:') return { stdout: 'pr diff', stderr: '' };
      if (command === 'git' && args.join(' ') === 'patch-id --stable' && options?.input === 'local diff') {
        return { stdout: '', stderr: '' };
      }
      if (command === 'git' && args.join(' ') === 'patch-id --stable' && options?.input === 'pr diff') {
        return { stdout: '', stderr: '' };
      }
      throw new Error(`unexpected command: ${command} ${args.join(' ')}`);
    });

    const result = await resolvePullRequest({ runner });

    expect(result.kind).toBe('ok');
    expect(result.kind === 'ok' ? result.commits : []).toEqual([]);
  });

  it('ignores local commits without patch-id while keeping valid patch-id matches', async () => {
    const prWithTwoCommits = {
      ...prJson,
      commits: [
        { oid: 'def', messageHeadline: 'empty patch', authoredDate: '2026-06-12T10:00:00Z' },
        { oid: 'jkl', messageHeadline: 'valid patch', authoredDate: '2026-06-12T11:00:00Z' },
      ],
    };
    const runner = createRunner((command, args, options) => {
      if (command === 'git' && args.join(' ') === 'branch --show-current') return { stdout: 'feature\n', stderr: '' };
      if (command === 'git' && args.join(' ') === 'rev-parse --show-toplevel') return { stdout: '/repo\n', stderr: '' };
      if (command === 'gh' && args[0] === 'pr') return { stdout: JSON.stringify(prWithTwoCommits), stderr: '' };
      if (command === 'gh' && args.join(' ') === 'repo view --json nameWithOwner') {
        return { stdout: JSON.stringify({ nameWithOwner: 'sam/prtokens' }), stderr: '' };
      }
      if (command === 'git' && args[0] === 'log') {
        return {
          stdout: 'abc\u00002026-06-12T10:00:00Z\u0000empty local\nghi\u00002026-06-12T11:00:00Z\u0000valid local\n',
          stderr: '',
        };
      }
      if (command === 'git' && args.join(' ') === 'show abc --pretty=format:') return { stdout: 'empty local diff', stderr: '' };
      if (command === 'git' && args.join(' ') === 'show ghi --pretty=format:') return { stdout: 'valid local diff', stderr: '' };
      if (command === 'git' && args.join(' ') === 'show def --pretty=format:') return { stdout: 'empty pr diff', stderr: '' };
      if (command === 'git' && args.join(' ') === 'show jkl --pretty=format:') return { stdout: 'valid pr diff', stderr: '' };
      if (command === 'git' && args.join(' ') === 'patch-id --stable' && options?.input === 'empty local diff') {
        return { stdout: '', stderr: '' };
      }
      if (command === 'git' && args.join(' ') === 'patch-id --stable' && options?.input === 'empty pr diff') {
        return { stdout: '', stderr: '' };
      }
      if (command === 'git' && args.join(' ') === 'patch-id --stable' && options?.input === 'valid local diff') {
        return { stdout: 'patch-2 ghi\n', stderr: '' };
      }
      if (command === 'git' && args.join(' ') === 'patch-id --stable' && options?.input === 'valid pr diff') {
        return { stdout: 'patch-2 jkl\n', stderr: '' };
      }
      throw new Error(`unexpected command: ${command} ${args.join(' ')}`);
    });

    const result = await resolvePullRequest({ runner });

    expect(result.kind).toBe('ok');
    expect(result.kind === 'ok' ? result.commits : []).toEqual([
      {
        sha: 'jkl',
        patchId: 'patch-2',
        message: 'valid patch',
        authorLogin: 'sam',
        authoredAt: '2026-06-12T11:00:00Z',
      },
    ]);
  });
});
