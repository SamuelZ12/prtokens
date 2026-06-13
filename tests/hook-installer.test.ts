import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  createDefaultHookInstallerDeps,
  installGlobalPrePushHook,
  runPreflight,
  type CommandResult,
  type HookInstallerDeps,
} from '../src/hook-installer.js';

type CommandCall = { cmd: string; args: string[] };

function createDeps(overrides: Partial<HookInstallerDeps> & { files?: Record<string, string>; commands?: Record<string, CommandResult> } = {}) {
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
    const hookContent = files.get(hookPath) ?? '';
    expect(hookContent).toContain('#!/bin/sh\n# >>> prtokens >>>');
    expect(hookContent).toContain('# <<< prtokens <<<');
    expect(hookContent).toContain('stdin_file="$(mktemp)" || exit 1');
    expect(hookContent).toContain('if ! cat > "$stdin_file"; then');
    expect(hookContent).toContain('rm -f "$stdin_file"');
    expect(hookContent).toContain('exit 1');
    expect(hookContent).toContain('repo_common_dir="$(git rev-parse --path-format=absolute --git-common-dir 2>/dev/null || true)"');
    expect(hookContent).toContain('repo_hook="${repo_common_dir:+$repo_common_dir/hooks/pre-push}"');
    expect(hookContent).not.toContain('$repo_git_dir/hooks/pre-push');
    expect(hookContent).toContain('current_hook="$0"');
    expect(hookContent).toContain('repo_hook_path="$repo_hook"');
    expect(hookContent).toContain('realpath "$repo_hook"');
    expect(hookContent).toContain('[ "$repo_hook_path" != "$current_hook" ]');
    expect(hookContent).toContain('if "$repo_hook" "$@" < "$stdin_file"; then');
    expect(hookContent).toContain('status=0');
    expect(hookContent).toContain('status=$?');
    expect(hookContent).toContain('exit "$status"');
    expect(hookContent).toContain('rm -f "$stdin_file"');
    expect(hookContent).toContain("command -v prtokens 2>/dev/null || echo '/usr/local/bin/prtokens'");
    expect(hookContent).toContain('"$prtokens_bin" >/dev/null 2>&1 </dev/null &');
    expect(hookContent).toContain('exit 0');
    expect(chmods).toEqual([{ path: hookPath, mode: 0o755 }]);
    expect(commands).toEqual([
      { cmd: 'git', args: ['config', '--global', '--path', '--get', 'core.hooksPath'] },
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
    expect(result.error).toContain('core.hooksPath');
    expect(commands).toEqual([
      { cmd: 'git', args: ['config', '--global', '--path', '--get', 'core.hooksPath'] },
      { cmd: 'git', args: ['config', '--global', 'core.hooksPath', hooksDir] },
    ]);
  });

  it('surfaces stderr when core.hooksPath cannot be configured', () => {
    const hooksDir = '/home/alice/.config/git/hooks';
    const { deps } = createDeps({
      commands: {
        [`git config --global core.hooksPath ${hooksDir}`]: { stdout: '', stderr: 'fatal: config file is locked\n', status: 1 },
      },
    });

    const result = installGlobalPrePushHook(deps);

    expect(result).toMatchObject({ ok: false, coreHooksPathAction: 'set' });
    expect(result.error).toContain('core.hooksPath');
    expect(result.error).toContain('fatal: config file is locked');
  });

  it('returns a failed result when reading core.hooksPath fails with detail', () => {
    const { deps, commands } = createDeps({
      commands: {
        'git config --global --path --get core.hooksPath': { stdout: '', stderr: 'fatal: config error', status: 2 },
      },
    });

    const result = installGlobalPrePushHook(deps);

    expect(result).toMatchObject({ ok: false });
    expect(result.error).toContain('core.hooksPath');
    expect(result.error).toContain('fatal: config error');
    expect(deps.fs.mkdirSync).not.toHaveBeenCalled();
    expect(deps.fs.writeFileSync).not.toHaveBeenCalled();
    expect(deps.fs.chmodSync).not.toHaveBeenCalled();
    expect(commands).toEqual([{ cmd: 'git', args: ['config', '--global', '--path', '--get', 'core.hooksPath'] }]);
  });

  it('returns a failed result when reading core.hooksPath exits non-missing without detail', () => {
    const { deps, commands } = createDeps({
      commands: {
        'git config --global --path --get core.hooksPath': { stdout: '', stderr: '', status: 2 },
      },
    });

    const result = installGlobalPrePushHook(deps);

    expect(result).toMatchObject({ ok: false });
    expect(result.error).toContain('core.hooksPath');
    expect(deps.fs.mkdirSync).not.toHaveBeenCalled();
    expect(deps.fs.writeFileSync).not.toHaveBeenCalled();
    expect(deps.fs.chmodSync).not.toHaveBeenCalled();
    expect(commands).toEqual([{ cmd: 'git', args: ['config', '--global', '--path', '--get', 'core.hooksPath'] }]);
  });

  it('returns a failed result when core.hooksPath is configured as an empty path', () => {
    const { deps, commands } = createDeps({
      commands: {
        'git config --global --path --get core.hooksPath': { stdout: '', stderr: '', status: 0 },
      },
    });

    const result = installGlobalPrePushHook(deps);

    expect(result).toMatchObject({ ok: false });
    expect(result.error).toContain('core.hooksPath');
    expect(deps.fs.mkdirSync).not.toHaveBeenCalled();
    expect(deps.fs.writeFileSync).not.toHaveBeenCalled();
    expect(deps.fs.chmodSync).not.toHaveBeenCalled();
    expect(commands).toEqual([{ cmd: 'git', args: ['config', '--global', '--path', '--get', 'core.hooksPath'] }]);
  });

  it('returns a failed result when core.hooksPath is configured as a relative path', () => {
    const { deps, commands } = createDeps({
      commands: {
        'git config --global --path --get core.hooksPath': { stdout: 'hooks\n', status: 0 },
      },
    });

    const result = installGlobalPrePushHook(deps);

    expect(result).toMatchObject({ ok: false });
    expect(result.error).toContain('core.hooksPath');
    expect(result.error).toMatch(/absolute|relative/);
    expect(deps.fs.mkdirSync).not.toHaveBeenCalled();
    expect(deps.fs.writeFileSync).not.toHaveBeenCalled();
    expect(deps.fs.chmodSync).not.toHaveBeenCalled();
    expect(commands).toEqual([{ cmd: 'git', args: ['config', '--global', '--path', '--get', 'core.hooksPath'] }]);
  });

  it('returns a failed result when reading core.hooksPath throws', () => {
    const { deps } = createDeps();
    vi.mocked(deps.runCommand).mockImplementation((cmd: string, args: string[]) => {
      if (cmd === 'git' && args.join(' ') === 'config --global --path --get core.hooksPath') {
        throw new Error('config read exploded');
      }

      return { stdout: '', status: 1 };
    });

    const result = installGlobalPrePushHook(deps);

    expect(result).toMatchObject({ ok: false });
    expect(result.error).toContain('core.hooksPath');
    expect(result.error).toContain('config read exploded');
    expect(deps.fs.mkdirSync).not.toHaveBeenCalled();
    expect(deps.fs.writeFileSync).not.toHaveBeenCalled();
    expect(deps.fs.chmodSync).not.toHaveBeenCalled();
  });

  it('returns a failed result when setting core.hooksPath throws', () => {
    const hooksDir = '/home/alice/.config/git/hooks';
    const { deps } = createDeps();
    vi.mocked(deps.runCommand).mockImplementation((cmd: string, args: string[]) => {
      if (cmd === 'git' && args.join(' ') === 'config --global --path --get core.hooksPath') {
        return { stdout: '', status: 1 };
      }
      if (cmd === 'git' && args.join(' ') === `config --global core.hooksPath ${hooksDir}`) {
        throw new Error('config set exploded');
      }

      return { stdout: '', status: 1 };
    });

    const result = installGlobalPrePushHook(deps);

    expect(result).toMatchObject({ ok: false, hookPath: `${hooksDir}/pre-push`, coreHooksPathAction: 'set' });
    expect(result.error).toContain('core.hooksPath');
    expect(result.error).toContain('config set exploded');
  });

  it('respects an existing global core.hooksPath without changing git config', () => {
    const { deps, files, commands } = createDeps({
      commands: {
        'git config --global --path --get core.hooksPath': { stdout: '/custom/hooks\n', status: 0 },
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
    expect(commands).toEqual([{ cmd: 'git', args: ['config', '--global', '--path', '--get', 'core.hooksPath'] }]);
  });

  it('uses the expanded core.hooksPath returned by git --path', () => {
    const hooksDir = '/home/alice/.config/git/hooks';
    const { deps, files, commands } = createDeps({
      commands: {
        'git config --global --path --get core.hooksPath': { stdout: `${hooksDir}\n`, status: 0 },
      },
    });

    const result = installGlobalPrePushHook(deps);

    expect(result).toMatchObject({
      ok: true,
      hooksDir,
      hookPath: `${hooksDir}/pre-push`,
      coreHooksPathAction: 'respected',
    });
    expect(files.get(`${hooksDir}/pre-push`)).toContain('# >>> prtokens >>>');
    expect(commands).toEqual([{ cmd: 'git', args: ['config', '--global', '--path', '--get', 'core.hooksPath'] }]);
  });

  it('appends the managed block to a foreign existing hook without adding a second shebang', () => {
    const existing = '#!/bin/sh\necho foreign\n';
    const { deps, files } = createDeps({
      commands: {
        'git config --global --path --get core.hooksPath': { stdout: '/custom/hooks\n', status: 0 },
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

  it('preserves previous shell hook failure status when appending the managed block', () => {
    const existing = '#!/bin/sh\nfalse\n';
    const { deps, files } = createDeps({
      commands: {
        'git config --global --path --get core.hooksPath': { stdout: '/custom/hooks\n', status: 0 },
      },
      files: {
        '/custom/hooks/pre-push': existing,
      },
    });

    const result = installGlobalPrePushHook(deps);

    const content = files.get('/custom/hooks/pre-push') ?? '';
    expect(result.hookAction).toBe('appended-to-existing-hook');
    expect(content).toContain('# >>> prtokens >>>\nprtokens_previous_status=$?');
    expect(content).toContain('exit "$prtokens_previous_status"');
    expect(content).toContain('exit 0');
    const previousStatusIndex = content.indexOf('prtokens_previous_status=$?');
    const previousStatusExitIndex = content.indexOf('exit "$prtokens_previous_status"');
    const stdinCaptureIndex = content.indexOf('stdin_file="$(mktemp)"');
    const backgroundLaunchIndex = content.indexOf('"$prtokens_bin" >/dev/null 2>&1 </dev/null &');
    expect(previousStatusIndex).toBeLessThan(stdinCaptureIndex);
    expect(previousStatusExitIndex).toBeLessThan(stdinCaptureIndex);
    expect(previousStatusExitIndex).toBeLessThan(backgroundLaunchIndex);
  });

  it.each(['exit 0', 'exec ./custom-pre-push'])(
    'returns a failed result for an existing shell hook ending in terminal %s',
    (terminalCommand) => {
      const existing = `#!/bin/sh\necho before\n${terminalCommand}\n`;
      const { deps, files, commands } = createDeps({
        commands: {
          'git config --global --path --get core.hooksPath': { stdout: '/custom/hooks\n', status: 0 },
        },
        files: {
          '/custom/hooks/pre-push': existing,
        },
      });

      const result = installGlobalPrePushHook(deps);

      expect(result).toMatchObject({ ok: false, hookPath: '/custom/hooks/pre-push' });
      expect(result.error).toMatch(/exit|exec|manual merge/);
      expect(files.get('/custom/hooks/pre-push')).toBe(existing);
      expect(deps.fs.writeFileSync).not.toHaveBeenCalled();
      expect(deps.fs.chmodSync).not.toHaveBeenCalled();
      expect(commands).toEqual([{ cmd: 'git', args: ['config', '--global', '--path', '--get', 'core.hooksPath'] }]);
    },
  );

  it('allows appending after non-terminal comments and blank lines', () => {
    const existing = '#!/bin/sh\necho before\n\n# done\n';
    const { deps, files, commands } = createDeps({
      commands: {
        'git config --global --path --get core.hooksPath': { stdout: '/custom/hooks\n', status: 0 },
      },
      files: {
        '/custom/hooks/pre-push': existing,
      },
    });

    const result = installGlobalPrePushHook(deps);

    expect(result.hookAction).toBe('appended-to-existing-hook');
    expect(files.get('/custom/hooks/pre-push')).toContain('# >>> prtokens >>>');
    expect(deps.fs.writeFileSync).toHaveBeenCalledWith('/custom/hooks/pre-push', expect.stringContaining(existing));
    expect(commands).toEqual([{ cmd: 'git', args: ['config', '--global', '--path', '--get', 'core.hooksPath'] }]);
  });

  it('returns a failed result for an existing non-shell hook without modifying it', () => {
    const existing = "#!/usr/bin/env node\nconsole.log('x')\n";
    const { deps, files, commands } = createDeps({
      commands: {
        'git config --global --path --get core.hooksPath': { stdout: '/custom/hooks\n', status: 0 },
      },
      files: {
        '/custom/hooks/pre-push': existing,
      },
    });

    const result = installGlobalPrePushHook(deps);

    expect(result).toMatchObject({ ok: false, hookPath: '/custom/hooks/pre-push' });
    expect(result.error).toMatch(/unsupported|non-shell/);
    expect(files.get('/custom/hooks/pre-push')).toBe(existing);
    expect(deps.fs.writeFileSync).not.toHaveBeenCalled();
    expect(deps.fs.chmodSync).not.toHaveBeenCalled();
    expect(commands).toEqual([{ cmd: 'git', args: ['config', '--global', '--path', '--get', 'core.hooksPath'] }]);
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
        'git config --global --path --get core.hooksPath': { stdout: '/custom/hooks\n', status: 0 },
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
    expect(afterFirst).not.toContain('exit 0\n# <<< prtokens <<<\necho after');
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
    expect(result.hookBody).toContain('"$prtokens_bin" >/dev/null 2>&1 </dev/null &');
    expect(deps.fs.mkdirSync).not.toHaveBeenCalled();
    expect(deps.fs.writeFileSync).not.toHaveBeenCalled();
    expect(deps.fs.chmodSync).not.toHaveBeenCalled();
    expect(commands).toEqual([{ cmd: 'git', args: ['config', '--global', '--path', '--get', 'core.hooksPath'] }]);
  });

  it('returns a failed result and does not set core.hooksPath when chmod fails', () => {
    const hooksDir = '/home/alice/.config/git/hooks';
    const hookPath = join(hooksDir, 'pre-push');
    const { deps, commands } = createDeps({
      commands: {
        [`git config --global core.hooksPath ${hooksDir}`]: { stdout: '', status: 0 },
      },
    });
    vi.mocked(deps.fs.chmodSync).mockImplementation(() => {
      throw new Error('chmod denied');
    });

    const result = installGlobalPrePushHook(deps);

    expect(result).toMatchObject({
      ok: false,
      hookPath,
      error: 'chmod denied',
    });
    expect(commands).toEqual([{ cmd: 'git', args: ['config', '--global', '--path', '--get', 'core.hooksPath'] }]);
  });

  it('returns a failed result when an existing hook cannot be read', () => {
    const hookPath = '/custom/hooks/pre-push';
    const { deps, commands } = createDeps({
      commands: {
        'git config --global --path --get core.hooksPath': { stdout: '/custom/hooks\n', status: 0 },
      },
      files: {
        [hookPath]: '',
      },
    });
    vi.mocked(deps.fs.readFileSync).mockImplementation(() => {
      throw new Error('read denied');
    });

    const result = installGlobalPrePushHook(deps);

    expect(result).toMatchObject({
      ok: false,
      hookPath,
      error: 'read denied',
    });
    expect(deps.fs.writeFileSync).not.toHaveBeenCalled();
    expect(deps.fs.chmodSync).not.toHaveBeenCalled();
    expect(commands).toEqual([{ cmd: 'git', args: ['config', '--global', '--path', '--get', 'core.hooksPath'] }]);
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
    expect(deps.fs.chmodSync).not.toHaveBeenCalled();
    expect(commands).toEqual([{ cmd: 'git', args: ['config', '--global', '--path', '--get', 'core.hooksPath'] }]);
  });

  it('generated hook invokes a distinct repo-local hook exactly once', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'prtokens-hook-'));
    try {
      const repoDir = join(tempDir, 'repo');
      const globalHook = join(tempDir, 'global-pre-push');
      const marker = join(tempDir, 'marker.txt');
      mkdirSync(repoDir);
      expect(spawnSync('git', ['init'], { cwd: repoDir, encoding: 'utf8' }).status).toBe(0);

      const repoHook = join(repoDir, '.git', 'hooks', 'pre-push');
      writeFileSync(repoHook, `#!/bin/sh\nprintf 'ran\\n' >> ${shellQuote(marker)}\nexit 0\n`);
      chmodSync(repoHook, 0o755);
      writeFileSync(globalHook, generatedHookBody());
      chmodSync(globalHook, 0o755);

      const result = spawnSync(globalHook, [], { cwd: repoDir, env: hookExecutionEnv(), input: 'refs\n', encoding: 'utf8', timeout: 2000 });

      expect(result.error).toBeUndefined();
      expect(result.status).toBe(0);
      expect(readFileSync(marker, 'utf8')).toBe('ran\n');
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('generated hook does not recurse when it is the repo-local hook', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'prtokens-hook-'));
    try {
      const repoDir = join(tempDir, 'repo');
      mkdirSync(repoDir);
      expect(spawnSync('git', ['init'], { cwd: repoDir, encoding: 'utf8' }).status).toBe(0);

      const repoHook = join(repoDir, '.git', 'hooks', 'pre-push');
      writeFileSync(repoHook, generatedHookBody());
      chmodSync(repoHook, 0o755);

      const result = spawnSync(repoHook, [], { cwd: repoDir, env: hookExecutionEnv(), input: 'refs\n', encoding: 'utf8', timeout: 2000 });

      expect(result.error).toBeUndefined();
      expect(result.status).toBe(0);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('generated hook invokes common repo hook from a linked worktree', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'prtokens-hook-'));
    try {
      const repoDir = join(tempDir, 'repo');
      const worktreeDir = join(tempDir, 'worktree');
      const globalHook = join(tempDir, 'global-pre-push');
      const marker = join(tempDir, 'marker.txt');
      mkdirSync(repoDir);
      expect(spawnSync('git', ['init'], { cwd: repoDir, encoding: 'utf8' }).status).toBe(0);
      writeFileSync(join(repoDir, 'file.txt'), 'base\n');
      expect(spawnSync('git', ['add', 'file.txt'], { cwd: repoDir, encoding: 'utf8' }).status).toBe(0);
      expect(spawnSync('git', ['commit', '-m', 'base'], { cwd: repoDir, env: gitTestEnv(), encoding: 'utf8' }).status).toBe(0);
      expect(spawnSync('git', ['worktree', 'add', worktreeDir], { cwd: repoDir, encoding: 'utf8' }).status).toBe(0);

      const repoHook = join(repoDir, '.git', 'hooks', 'pre-push');
      writeFileSync(repoHook, `#!/bin/sh\nprintf 'ran\\n' >> ${shellQuote(marker)}\nexit 0\n`);
      chmodSync(repoHook, 0o755);
      writeFileSync(globalHook, generatedHookBody());
      chmodSync(globalHook, 0o755);

      const result = spawnSync(globalHook, [], { cwd: worktreeDir, env: hookExecutionEnv(), input: 'refs\n', encoding: 'utf8', timeout: 2000 });

      expect(result.error).toBeUndefined();
      expect(result.status).toBe(0);
      expect(readFileSync(marker, 'utf8')).toBe('ran\n');
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});

function generatedHookBody(): string {
  const hooksDir = '/home/alice/.config/git/hooks';
  const { deps } = createDeps({
    commands: {
      [`git config --global core.hooksPath ${hooksDir}`]: { stdout: '', status: 0 },
    },
    prtokensBinPath: '/bin/true',
  });

  return installGlobalPrePushHook(deps).hookBody;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function hookExecutionEnv(): NodeJS.ProcessEnv {
  return { PATH: '/bin:/usr/bin' };
}

function gitTestEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    GIT_AUTHOR_EMAIL: 'test@example.com',
    GIT_AUTHOR_NAME: 'Test User',
    GIT_COMMITTER_EMAIL: 'test@example.com',
    GIT_COMMITTER_NAME: 'Test User',
  };
}

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

  it('reports gh installed but unauthenticated', () => {
    const { deps } = createDeps({
      commands: {
        'gh --version': { stdout: 'gh version 2.0.0\n', status: 0 },
        'gh auth status': { stdout: '', status: 1 },
      },
    });

    const result = runPreflight(deps);

    expect(result.checks).toEqual([
      {
        name: 'Node.js',
        status: 'ok',
        message: 'Node.js 22.13.0 satisfies the required 22.13.0.',
      },
      {
        name: 'GitHub CLI',
        status: 'ok',
        message: 'GitHub CLI is installed.',
      },
      {
        name: 'GitHub auth',
        status: 'fail',
        message: 'GitHub CLI is not authenticated.',
        hint: 'Run gh auth login.',
      },
    ]);
  });

  it('reports all checks ok when Node, gh, and auth are ready', () => {
    const { deps } = createDeps({
      commands: {
        'gh --version': { stdout: 'gh version 2.0.0\n', status: 0 },
        'gh auth status': { stdout: 'Logged in to github.com\n', status: 0 },
      },
    });

    const result = runPreflight(deps);

    expect(result.checks.map((check) => check.status)).toEqual(['ok', 'ok', 'ok']);
  });
});

describe('createDefaultHookInstallerDeps', () => {
  it('preserves spawn execution errors in stderr', () => {
    const deps = createDefaultHookInstallerDeps('/usr/local/bin/prtokens');

    const result = deps.runCommand('__prtokens_missing_command__', []);

    expect(result.status).not.toBe(0);
    expect(result.stderr?.trim()).not.toBe('');
  });
});
