import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';

export interface CommandResult {
  stdout: string;
  stderr?: string;
  status: number;
}

export interface HookInstallerDeps {
  runCommand(cmd: string, args: string[]): CommandResult;
  homedir(): string;
  env: NodeJS.ProcessEnv;
  fs: {
    existsSync(p: string): boolean;
    readFileSync(p: string): string;
    writeFileSync(p: string, data: string): void;
    mkdirSync(p: string, opts: { recursive: true }): void;
    chmodSync(p: string, mode: number): void;
  };
  nodeVersion: string;
  prtokensBinPath: string;
}

export type PreflightStatus = 'ok' | 'warning' | 'fail' | 'unknown';

export interface PreflightCheck {
  name: 'Node.js' | 'GitHub CLI' | 'GitHub auth';
  status: PreflightStatus;
  message: string;
  hint?: string;
}

export interface PreflightResult {
  checks: PreflightCheck[];
}

export type HookAction = 'installed' | 'updated-existing-block' | 'appended-to-existing-hook' | 'already-up-to-date';
export type CoreHooksPathAction = 'set' | 'respected' | 'would-set' | 'would-respect';

export interface InstallResult {
  ok: boolean;
  dryRun: boolean;
  hooksDir: string;
  hookPath: string;
  hookBody: string;
  hookAction: HookAction;
  coreHooksPathAction: CoreHooksPathAction;
  error?: string;
}

export interface InstallOptions {
  dryRun?: boolean;
}

const managedStart = '# >>> prtokens >>>';
const managedEnd = '# <<< prtokens <<<';
const requiredNodeVersion = '22.13.0';

export function createDefaultHookInstallerDeps(prtokensBinPath: string): HookInstallerDeps {
  return {
    runCommand(cmd, args) {
      const result = spawnSync(cmd, args, { encoding: 'utf8', env: process.env });
      const stderr = typeof result.stderr === 'string' ? result.stderr : '';
      const spawnError = result.error instanceof Error ? result.error.message : '';

      return {
        stdout: typeof result.stdout === 'string' ? result.stdout : '',
        stderr: spawnError === '' ? stderr : `${stderr}${stderr === '' ? '' : '\n'}${spawnError}`,
        status: result.status ?? 1,
      };
    },
    homedir,
    env: process.env,
    fs: {
      existsSync: fs.existsSync,
      readFileSync(p) {
        return fs.readFileSync(p, 'utf8');
      },
      writeFileSync(p, data) {
        fs.writeFileSync(p, data);
      },
      mkdirSync(p, opts) {
        fs.mkdirSync(p, opts);
      },
      chmodSync: fs.chmodSync,
    },
    nodeVersion: process.versions.node,
    prtokensBinPath,
  };
}

export function runPreflight(deps: HookInstallerDeps): PreflightResult {
  const checks: PreflightCheck[] = [];

  if (compareVersions(deps.nodeVersion, requiredNodeVersion) >= 0) {
    checks.push({
      name: 'Node.js',
      status: 'ok',
      message: `Node.js ${deps.nodeVersion} satisfies the required ${requiredNodeVersion}.`,
    });
  } else {
    checks.push({
      name: 'Node.js',
      status: 'warning',
      message: `Node.js ${deps.nodeVersion} is below the required ${requiredNodeVersion}.`,
      hint: 'Install Node.js 22.13 or newer.',
    });
  }

  const ghVersion = runCommandSafely(deps, 'gh', ['--version']);
  if (ghVersion.status !== 0) {
    checks.push({
      name: 'GitHub CLI',
      status: 'fail',
      message: 'GitHub CLI is not installed or not on PATH.',
      hint: 'Install GitHub CLI: https://cli.github.com/',
    });
    checks.push({
      name: 'GitHub auth',
      status: 'unknown',
      message: 'Skipped because GitHub CLI is not available.',
      hint: 'Install GitHub CLI, then run gh auth login.',
    });

    return { checks };
  }

  checks.push({
    name: 'GitHub CLI',
    status: 'ok',
    message: 'GitHub CLI is installed.',
  });

  const ghAuth = runCommandSafely(deps, 'gh', ['auth', 'status']);
  if (ghAuth.status === 0) {
    checks.push({
      name: 'GitHub auth',
      status: 'ok',
      message: 'GitHub CLI is authenticated.',
    });
  } else {
    checks.push({
      name: 'GitHub auth',
      status: 'fail',
      message: 'GitHub CLI is not authenticated.',
      hint: 'Run gh auth login.',
    });
  }

  return { checks };
}

export function installGlobalPrePushHook(deps: HookInstallerDeps, options: InstallOptions = {}): InstallResult {
  const dryRun = options.dryRun === true;
  const configuredHooksPath = runCommandSafely(deps, 'git', ['config', '--global', '--path', '--get', 'core.hooksPath']);
  const configuredHooksPathError = commandDetail(configuredHooksPath);
  const existingHooksDir = configuredHooksPath.status === 0 ? configuredHooksPath.stdout.trim() : '';
  const hasExistingHooksDir = existingHooksDir !== '';
  const hooksDir = hasExistingHooksDir ? existingHooksDir : join(deps.homedir(), '.config', 'git', 'hooks');
  const hookPath = join(hooksDir, 'pre-push');
  const coreHooksPathAction: CoreHooksPathAction = hasExistingHooksDir
    ? dryRun
      ? 'would-respect'
      : 'respected'
    : dryRun
      ? 'would-set'
      : 'set';
  const missingHooksPathConfig = configuredHooksPath.status === 1 && configuredHooksPathError === '';
  if (configuredHooksPath.status !== 0 && !missingHooksPathConfig) {
    return {
      ok: false,
      dryRun,
      hooksDir,
      hookPath,
      hookBody: '',
      hookAction: 'installed',
      coreHooksPathAction,
      error: configuredHooksPathError === '' ? 'Failed to read core.hooksPath.' : `Failed to read core.hooksPath: ${configuredHooksPathError}`,
    };
  }
  if (configuredHooksPath.status === 0 && existingHooksDir === '') {
    return {
      ok: false,
      dryRun,
      hooksDir,
      hookPath,
      hookBody: '',
      hookAction: 'installed',
      coreHooksPathAction,
      error: 'Failed to read core.hooksPath: configured path is empty.',
    };
  }
  if (hasExistingHooksDir && !isAbsolute(hooksDir)) {
    return {
      ok: false,
      dryRun,
      hooksDir,
      hookPath,
      hookBody: '',
      hookAction: 'installed',
      coreHooksPathAction,
      error: 'Failed to read core.hooksPath: configured path must be absolute, not relative.',
    };
  }
  let currentHookBody: string | undefined;
  try {
    currentHookBody = deps.fs.existsSync(hookPath) ? deps.fs.readFileSync(hookPath) : undefined;
  } catch (error) {
    return {
      ok: false,
      dryRun,
      hooksDir,
      hookPath,
      hookBody: '',
      hookAction: 'installed',
      coreHooksPathAction,
      error: errorMessage(error),
    };
  }
  if (currentHookBody !== undefined && !isShellCompatibleHook(currentHookBody)) {
    return {
      ok: false,
      dryRun,
      hooksDir,
      hookPath,
      hookBody: currentHookBody,
      hookAction: 'appended-to-existing-hook',
      coreHooksPathAction,
      error: 'Unsupported non-shell existing pre-push hook.',
    };
  }
  const { hookBody, hookAction } = mergeHookBody(currentHookBody, deps.prtokensBinPath);
  const resultBase = {
    dryRun,
    hooksDir,
    hookPath,
    hookBody,
    hookAction,
    coreHooksPathAction,
  };

  if (dryRun) {
    return { ok: true, ...resultBase };
  }

  try {
    deps.fs.mkdirSync(hooksDir, { recursive: true });
    if (currentHookBody !== hookBody) {
      deps.fs.writeFileSync(hookPath, hookBody);
    }
    deps.fs.chmodSync(hookPath, 0o755);
  } catch (error) {
    return { ok: false, ...resultBase, error: errorMessage(error) };
  }

  if (!hasExistingHooksDir) {
    const configResult = runCommandSafely(deps, 'git', ['config', '--global', 'core.hooksPath', hooksDir]);
    if (configResult.status !== 0) {
      const detail = commandDetail(configResult);
      return {
        ok: false,
        ...resultBase,
        error: detail === '' ? 'Failed to set core.hooksPath.' : `Failed to set core.hooksPath: ${detail}`,
      };
    }
  }

  return { ok: true, ...resultBase };
}

function mergeHookBody(currentHookBody: string | undefined, prtokensBinPath: string): { hookBody: string; hookAction: HookAction } {
  const managedBlock = renderManagedBlock(prtokensBinPath);

  if (currentHookBody === undefined) {
    return { hookBody: `#!/bin/sh\n${managedBlock}\n`, hookAction: 'installed' };
  }

  const managedBlockPattern = new RegExp(`${escapeRegExp(managedStart)}[\\s\\S]*?${escapeRegExp(managedEnd)}`);
  if (managedBlockPattern.test(currentHookBody)) {
    const hookBody = currentHookBody.replace(managedBlockPattern, managedBlock);

    return {
      hookBody,
      hookAction: hookBody === currentHookBody ? 'already-up-to-date' : 'updated-existing-block',
    };
  }

  const separator = currentHookBody.endsWith('\n') ? '' : '\n';

  return {
    hookBody: `${currentHookBody}${separator}${managedBlock}\n`,
    hookAction: 'appended-to-existing-hook',
  };
}

function renderManagedBlock(prtokensBinPath: string): string {
  return [
    managedStart,
    'prtokens_previous_status=$?',
    'if [ "$prtokens_previous_status" -ne 0 ]; then',
    '  exit "$prtokens_previous_status"',
    'fi',
    '# Installed by `prtokens init`. Re-run prtokens init to update this block.',
    'stdin_file="$(mktemp)"',
    'cat > "$stdin_file"',
    '',
    'repo_git_dir="$(git rev-parse --absolute-git-dir 2>/dev/null || true)"',
    'repo_hook="${repo_git_dir:+$repo_git_dir/hooks/pre-push}"',
    'current_hook="$0"',
    'repo_hook_path="$repo_hook"',
    'if command -v realpath >/dev/null 2>&1; then',
    '  current_hook="$(realpath "$current_hook" 2>/dev/null || printf \'%s\\n\' "$current_hook")"',
    '  repo_hook_path="$(realpath "$repo_hook" 2>/dev/null || printf \'%s\\n\' "$repo_hook")"',
    'fi',
    'if [ -n "$repo_hook" ] && [ -x "$repo_hook" ] && [ "$repo_hook_path" != "$current_hook" ]; then',
    '  if "$repo_hook" "$@" < "$stdin_file"; then',
    '    status=0',
    '  else',
    '    status=$?',
    '  fi',
    '  if [ "$status" -ne 0 ]; then',
    '    rm -f "$stdin_file"',
    '    exit "$status"',
    '  fi',
    'fi',
    '',
    'rm -f "$stdin_file"',
    `prtokens_bin="$(command -v prtokens 2>/dev/null || echo ${shellQuote(prtokensBinPath)})"`,
    '"$prtokens_bin" >/dev/null 2>&1 </dev/null &',
    'exit 0',
    managedEnd,
  ].join('\n');
}

function isShellCompatibleHook(hookBody: string): boolean {
  if (!hookBody.startsWith('#!')) {
    return true;
  }

  const [shebang = ''] = hookBody.split('\n', 1);
  const parts = shebang.slice(2).trim().split(/\s+/);
  const command = parts[0] ?? '';

  if (command.endsWith('/env')) {
    return parts[1] === 'sh' || parts[1] === 'bash';
  }

  return command.endsWith('/sh') || command.endsWith('/bash');
}

function runCommandSafely(deps: HookInstallerDeps, cmd: string, args: string[]): CommandResult {
  try {
    return deps.runCommand(cmd, args);
  } catch (error) {
    return { stdout: '', stderr: errorMessage(error), status: 1 };
  }
}

function commandDetail(result: CommandResult): string {
  return (result.stderr ?? result.stdout).trim() || result.stdout.trim();
}

function compareVersions(left: string, right: string): number {
  const leftParts = versionParts(left);
  const rightParts = versionParts(right);

  for (let index = 0; index < Math.max(leftParts.length, rightParts.length); index += 1) {
    const difference = (leftParts[index] ?? 0) - (rightParts[index] ?? 0);
    if (difference !== 0) {
      return difference;
    }
  }

  return 0;
}

function versionParts(version: string): number[] {
  return version.replace(/^v/, '').split('.').map((part) => Number.parseInt(part, 10) || 0);
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
