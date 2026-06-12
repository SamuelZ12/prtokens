import { describe, expect, it } from 'vitest';
import { ensureGhReady, upsertPrComment } from '../src/github-poster.js';
import type { CommandRunner } from '../src/git-resolver.js';

interface RecordedCommand {
  command: string;
  args: string[];
}

function createRunner(
  handler: (command: string, args: string[]) => Promise<{ stdout: string; stderr: string }> | { stdout: string; stderr: string },
): CommandRunner & { commands: RecordedCommand[] } {
  const commands: RecordedCommand[] = [];

  return {
    commands,
    async run(command, args) {
      commands.push({ command, args });
      return handler(command, args);
    },
  };
}

const markdown = ['<!-- prtokens:v1 -->', '', 'Token summary'].join('\n');

describe('ensureGhReady', () => {
  it('returns setup instructions when gh auth status fails', async () => {
    const runner = createRunner(() => {
      throw new Error('gh auth status failed');
    });

    const result = await ensureGhReady(runner);

    expect(result).toEqual({ ok: false, message: 'Install GitHub CLI and run gh auth login.' });
    expect(runner.commands).toEqual([{ command: 'gh', args: ['auth', 'status'] }]);
  });
});

describe('upsertPrComment', () => {
  it('updates an existing issue comment containing the prtokens marker', async () => {
    const runner = createRunner((command, args) => {
      if (command === 'gh' && args.join(' ') === 'api repos/OWNER/REPO/issues/12/comments') {
        return {
          stdout: JSON.stringify([
            { id: 88, body: 'unrelated comment' },
            { id: 99, body: `existing\n${markdown}`, html_url: 'https://github.com/OWNER/REPO/pull/12#issuecomment-99' },
          ]),
          stderr: '',
        };
      }

      if (command === 'gh' && args.join(' ') === `api --method PATCH repos/OWNER/REPO/issues/comments/99 -f body=${markdown}`) {
        return { stdout: JSON.stringify({ html_url: 'https://github.com/OWNER/REPO/pull/12#issuecomment-99' }), stderr: '' };
      }

      throw new Error(`unexpected command: ${command} ${args.join(' ')}`);
    });

    const result = await upsertPrComment({ runner, repository: 'OWNER/REPO', prNumber: 12, markdown });

    expect(result).toEqual({ ok: true, commentUrl: 'https://github.com/OWNER/REPO/pull/12#issuecomment-99' });
    expect(runner.commands).toEqual([
      { command: 'gh', args: ['api', 'repos/OWNER/REPO/issues/12/comments'] },
      { command: 'gh', args: ['api', '--method', 'PATCH', 'repos/OWNER/REPO/issues/comments/99', '-f', `body=${markdown}`] },
    ]);
  });

  it('creates a new issue comment when no marker exists', async () => {
    const runner = createRunner((command, args) => {
      if (command === 'gh' && args.join(' ') === 'api repos/OWNER/REPO/issues/12/comments') {
        return { stdout: JSON.stringify([{ id: 88, body: 'unrelated comment' }]), stderr: '' };
      }

      if (command === 'gh' && args.join(' ') === `api --method POST repos/OWNER/REPO/issues/12/comments -f body=${markdown}`) {
        return { stdout: JSON.stringify({ html_url: 'https://github.com/OWNER/REPO/pull/12#issuecomment-100' }), stderr: '' };
      }

      throw new Error(`unexpected command: ${command} ${args.join(' ')}`);
    });

    const result = await upsertPrComment({ runner, repository: 'OWNER/REPO', prNumber: 12, markdown });

    expect(result).toEqual({ ok: true, commentUrl: 'https://github.com/OWNER/REPO/pull/12#issuecomment-100' });
    expect(runner.commands).toEqual([
      { command: 'gh', args: ['api', 'repos/OWNER/REPO/issues/12/comments'] },
      { command: 'gh', args: ['api', '--method', 'POST', 'repos/OWNER/REPO/issues/12/comments', '-f', `body=${markdown}`] },
    ]);
  });

  it('returns rendered markdown when posting the issue comment fails', async () => {
    const runner = createRunner((command, args) => {
      if (command === 'gh' && args.join(' ') === 'api repos/OWNER/REPO/issues/12/comments') {
        return { stdout: JSON.stringify([]), stderr: '' };
      }

      if (command === 'gh' && args.join(' ') === `api --method POST repos/OWNER/REPO/issues/12/comments -f body=${markdown}`) {
        throw new Error('gh api failed');
      }

      throw new Error(`unexpected command: ${command} ${args.join(' ')}`);
    });

    const result = await upsertPrComment({ runner, repository: 'OWNER/REPO', prNumber: 12, markdown });

    expect(result).toEqual({ ok: false, renderedMarkdown: markdown, error: 'gh api failed' });
  });

  it('returns rendered markdown when updating the issue comment fails', async () => {
    const runner = createRunner((command, args) => {
      if (command === 'gh' && args.join(' ') === 'api repos/OWNER/REPO/issues/12/comments') {
        return { stdout: JSON.stringify([{ id: 99, body: markdown }]), stderr: '' };
      }

      if (command === 'gh' && args.join(' ') === `api --method PATCH repos/OWNER/REPO/issues/comments/99 -f body=${markdown}`) {
        throw new Error('gh api failed');
      }

      throw new Error(`unexpected command: ${command} ${args.join(' ')}`);
    });

    const result = await upsertPrComment({ runner, repository: 'OWNER/REPO', prNumber: 12, markdown });

    expect(result).toEqual({ ok: false, renderedMarkdown: markdown, error: 'gh api failed' });
  });
});
