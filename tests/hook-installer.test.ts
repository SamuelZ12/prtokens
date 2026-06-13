import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { installGlobalPrePushHook, runPreflight, type HookInstallerDeps } from '../src/hook-installer.js';

type CommandCall = { cmd: string; args: string[] };

function createDeps(overrides: Partial<HookInstallerDeps> & { files?: Record<string, string>; commands?: Record<string, { stdout: string; status: number }> } = {}) {
  const files = new Map(Object.entries(overrides.files ?? {}));
  const chmods: Array<{ path: string; mode: number }> = [];
  const mkdirs: Array<{ path: string; opts: { recursive: true } }> = [];
  const commands: CommandCall[] = [];
  const commandResults = overrides.commands ?? {};

  const deps: HookInstallerDeps = {
    runCommand: vi.fn((cmd: string, args: string[]) => {
      commands.push({ cmd, args });
      return commandResults[[cmd, ...args].join(' ')] ?? { stdout: '', status: 1 };
    }),
    homedir: vi.fn(() => '/home/alice'),
    env: {},
    nodeVersion: '22.13.0',
    prtokensBinPath: '/usr/local/bin/prtokens',
    fs: {
      existsSync: vi.fn((path: string) => files.has(path)),
      readFileSync: vi.fn((path: string) => {
        const value = files.get(path);
        if (value === undefined) {
          throw new Error(`Missing fake file: ${path}`);
        }
        return value;
      }),
      writeFileSync: vi.fn((path: string, data: string) => {
        files.set(path, data);
      }),
      mkdirSync: vi.fn((path: string, opts: { recursive: true }) => {
        mkdirs.push({ path, opts });
      }),
      chmodSync: vi.fn((path: string, mode: number) => {
        chmods.push({ path, mode });
      }),
    },
    ...overrides,
  };

  return { deps, files, chmods, mkdirs, commands };
}

describe('installGlobalPrePushHook', () => {
  it('writes a fresh global pre-push hook and sets core.hooksPath when unset', () => {
    const hooksDir = '/home/alice/.config/git/hooks';
    const { deps, files, chmods, mkdirs, commands } = createDeps({
      commands: {
        [`git config --global core.hooksPath ${hooksDir}`]: { stdout: '', status: 0 },
      },
    });

    const result = installGlobalPrePushHook(deps);

    const hookPath = join(hooksDir, 'pre-push');
    expect(result).toMatchObject({
      ok: true,
      dryRun: false,
      hookPath,
      hooksDir,
      hookAction: 'installed',
      coreHooksPathAction: 'set',
    });
    expect(mkdirs).toEqual([{ path: hooksDir, opts: { recursive: true } }]);
    expect(files.get(hookPath)).toContain('#!/bin/sh\n# >>> prtokens >>>');
    expect(files.get(hookPath)).toContain('# <<< prtokens <<<');
    expect(files.get(hookPath)).toContain("command -v prtokens 2>/dev/null || echo '/usr/local/bin/prtokens'");
    expect(chmods).toEqual([{ path: hookPath, mode: 0o755 }]);
    expect(commands).toEqual([
      { cmd: 'git', args: ['config', '--global', '--get', 'core.hooksPath'] },
      { cmd: 'git', args: ['config', '--global', 'core.hooksPath', hooksDir] },
    ]);
  });

  it('returns a failed result when core.hooksPath cannot be configured', () => {
    const hooksDir = '/home/alice/.config/git/hooks';
    const hookPath = join(hooksDir, 'pre-push');
    const { deps, commands } = createDeps({
      commands: {
        [`git config --global core.hooksPath ${hooksDir}`]: { stdout: 'permission denied\n', status: 1 },
      },
    });

    const result = installGlobalPrePushHook(deps);

    expect(result).toMatchObject({
      ok: false,
      hookPath,
      coreHooksPathAction: 'set',
    });
    expect(result.hookAction).not.toBe('installed');
    expect(result.error).toContain('core.hooksPath');
    expect(commands).toEqual([
      { cmd: 'git', args: ['config', '--global', '--get', 'core.hooksPath'] },
      { cmd: 'git', args: ['config', '--global', 'core.hooksPath', hooksDir] },
    ]);
  });

  it('respects an existing global core.hooksPath without changing git config', () => {
    const { deps, files, commands } = createDeps({
      commands: {
        'git config --global --get core.hooksPath': { stdout: '/custom/hooks\n', status: 0 },
      },
    });

    const result = installGlobalPrePushHook(deps);

    expect(result).toMatchObject({
      ok: true,
      hooksDir: '/custom/hooks',
      hookPath: '/custom/hooks/pre-push',
      hookAction: 'installed',
      coreHooksPathAction: 'respected',
    });
    expect(files.get('/custom/hooks/pre-push')).toContain('# >>> prtokens >>>');
    expect(commands).toEqual([{ cmd: 'git', args: ['config', '--global', '--get', 'core.hooksPath'] }]);
  });

  it('appends the managed block to a foreign existing hook without adding a second shebang', () => {
    const existing = '#!/bin/sh\necho foreign\n';
    const { deps, files } = createDeps({
      commands: {
        'git config --global --get core.hooksPath': { stdout: '/custom/hooks\n', status: 0 },
      },
      files: {
        '/custom/hooks/pre-push': existing,
      },
    });

    const result = installGlobalPrePushHook(deps);

    const content = files.get('/custom/hooks/pre-push') ?? '';
    expect(result.hookAction).toBe('appended-to-existing-hook');
    expect(content.startsWith(existing)).toBe(true);
    expect(content).toContain('# >>> prtokens >>>');
    expect(content.match(/^#!\/bin\/sh/gm)).toHaveLength(1);
  });

  it('replaces only the managed block on rerun and then reports already up to date', () => {
    const oldHook = [
      '#!/bin/sh',
      'echo before',
      '# >>> prtokens >>>',
      'old managed content',
      '# <<< prtokens <<<',
      'echo after',
      '',
    ].join('\n');
    const { deps, files } = createDeps({
      commands: {
        'git config --global --get core.hooksPath': { stdout: '/custom/hooks\n', status: 0 },
      },
      files: {
        '/custom/hooks/pre-push': oldHook,
      },
    });

    const first = installGlobalPrePushHook(deps);
    const afterFirst = files.get('/custom/hooks/pre-push') ?? '';
    const second = installGlobalPrePushHook(deps);

    expect(first.hookAction).toBe('updated-existing-block');
    expect(afterFirst).toContain('echo before\n# >>> prtokens >>>');
    expect(afterFirst).toContain('# <<< prtokens <<<\necho after');
    expect(afterFirst).not.toContain('old managed content');
    expect(second.hookAction).toBe('already-up-to-date');
    expect(files.get('/custom/hooks/pre-push')).toBe(afterFirst);
  });

  it('dry-run returns the plan and hook body without writing files or git config', () => {
    const { deps, commands } = createDeps();

    const result = installGlobalPrePushHook(deps, { dryRun: true });

    expect(result).toMatchObject({
      ok: true,
      dryRun: true,
      hookAction: 'installed',
      coreHooksPathAction: 'would-set',
    });
    expect(result.hookBody).toContain('# >>> prtokens >>>');
    expect(result.hookBody).toContain("echo '/usr/local/bin/prtokens'");
    expect(deps.fs.mkdirSync).not.toHaveBeenCalled();
    expect(deps.fs.writeFileSync).not.toHaveBeenCalled();
    expect(deps.fs.chmodSync).not.toHaveBeenCalled();
    expect(commands).toEqual([{ cmd: 'git', args: ['config', '--global', '--get', 'core.hooksPath'] }]);
  });

  it('returns a failed result when the hook cannot be written', () => {
    const hooksDir = '/home/alice/.config/git/hooks';
    const { deps, commands } = createDeps({
      commands: {
        [`git config --global core.hooksPath ${hooksDir}`]: { stdout: '', status: 0 },
      },
    });
    vi.mocked(deps.fs.writeFileSync).mockImplementation(() => {
      throw new Error('permission denied');
    });

    const result = installGlobalPrePushHook(deps);

    expect(result).toMatchObject({
      ok: false,
      hookPath: '/home/alice/.config/git/hooks/pre-push',
      error: 'permission denied',
    });
    expect(commands).toEqual([{ cmd: 'git', args: ['config', '--global', '--get', 'core.hooksPath'] }]);
  });
});

describe('runPreflight', () => {
  it('reports gh missing, skips auth as unknown, and warns on old Node without blocking install', () => {
    const { deps } = createDeps({ nodeVersion: '20.10.0' });

    const result = runPreflight(deps);

    expect(result.checks).toEqual([
      {
        name: 'Node.js',
        status: 'warning',
        message: 'Node.js 20.10.0 is below the required 22.13.0.',
        hint: 'Install Node.js 22.13 or newer.',
      },
      {
        name: 'GitHub CLI',
        status: 'fail',
        message: 'GitHub CLI is not installed or not on PATH.',
        hint: 'Install GitHub CLI: https://cli.github.com/',
      },
      {
        name: 'GitHub auth',
        status: 'unknown',
        message: 'Skipped because GitHub CLI is not available.',
        hint: 'Install GitHub CLI, then run gh auth login.',
      },
    ]);
  });
});
