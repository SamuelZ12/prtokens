import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

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

      return {
        stdout: typeof result.stdout === 'string' ? result.stdout : '',
        stderr: typeof result.stderr === 'string' ? result.stderr : '',
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
  const configuredHooksPath = deps.runCommand('git', ['config', '--global', '--path', '--get', 'core.hooksPath']);
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
  if (configuredHooksPath.status !== 0 && configuredHooksPathError !== '') {
    return {
      ok: false,
      dryRun,
      hooksDir,
      hookPath,
      hookBody: '',
      hookAction: 'installed',
      coreHooksPathAction,
      error: `Failed to read core.hooksPath: ${configuredHooksPathError}`,
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
    const configResult = deps.runCommand('git', ['config', '--global', 'core.hooksPath', hooksDir]);
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
    'git_dir="$(git rev-parse --path-format=absolute --git-common-dir 2>/dev/null || true)"',
    'local_hook="$git_dir/hooks/pre-push"',
    'if [ -n "$git_dir" ] && [ -x "$local_hook" ] && [ "$local_hook" != "$0" ]; then',
    '  "$local_hook" "$@"',
    '  local_hook_status=$?',
    '  if [ "$local_hook_status" -ne 0 ]; then',
    '    exit "$local_hook_status"',
    '  fi',
    'fi',
    `prtokens_bin="$(command -v prtokens 2>/dev/null || echo ${shellQuote(prtokensBinPath)})"`,
    '"$prtokens_bin" >/dev/null 2>&1 </dev/null &',
    managedEnd,
  ].join('\n');
}

function runCommandSafely(deps: HookInstallerDeps, cmd: string, args: string[]): CommandResult {
  try {
    return deps.runCommand(cmd, args);
  } catch {
    return { stdout: '', status: 1 };
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
