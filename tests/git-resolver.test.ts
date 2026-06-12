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
});
