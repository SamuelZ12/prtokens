import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';

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
  if (currentHookBody !== undefined) {
    const terminalCommand = terminalLastCommand(contentBeforeManagedBlock(currentHookBody) ?? currentHookBody);
    if (terminalCommand !== undefined) {
      return {
        ok: false,
        dryRun,
        hooksDir,
        hookPath,
        hookBody: currentHookBody,
        hookAction: 'appended-to-existing-hook',
        coreHooksPathAction,
        error: `Managed prtokens block would be unreachable after terminal ${terminalCommand}; manual merge required.`,
      };
    }
  }
  const { hookBody, hookAction } = mergeHookBody(currentHookBody, hookPathPrefix(deps));
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

function mergeHookBody(currentHookBody: string | undefined, pathPrefix: HookPathPrefix): { hookBody: string; hookAction: HookAction } {
  if (currentHookBody === undefined) {
    const managedBlock = renderManagedBlock(pathPrefix, true, true);

    return { hookBody: `#!/bin/sh\n${managedBlock}\n`, hookAction: 'installed' };
  }

  const managedBlockPattern = createManagedBlockPattern();
  if (managedBlockPattern.test(currentHookBody)) {
    const prefix = contentBeforeManagedBlock(currentHookBody) ?? '';
    const managedBlock = renderManagedBlock(
      pathPrefix,
      trailingContentAfterManagedBlock(currentHookBody).trim() === '',
      !hasMeaningfulShellContent(prefix),
    );
    const hookBody = currentHookBody.replace(managedBlockPattern, managedBlock);

    return {
      hookBody,
      hookAction: hookBody === currentHookBody ? 'already-up-to-date' : 'updated-existing-block',
    };
  }

  const separator = currentHookBody.endsWith('\n') ? '' : '\n';
  const managedBlock = renderManagedBlock(pathPrefix, true, !hasMeaningfulShellContent(currentHookBody));

  return {
    hookBody: `${currentHookBody}${separator}${managedBlock}\n`,
    hookAction: 'appended-to-existing-hook',
  };
}

function createManagedBlockPattern(): RegExp {
  return new RegExp(`${escapeRegExp(managedStart)}[\\s\\S]*?${escapeRegExp(managedEnd)}`);
}

function contentBeforeManagedBlock(hookBody: string): string | undefined {
  const startIndex = hookBody.indexOf(managedStart);

  return startIndex === -1 ? undefined : hookBody.slice(0, startIndex);
}

function terminalLastCommand(hookBody: string): 'exit' | 'exec' | undefined {
  const lastMeaningfulLine = hookBody
    .split('\n')
    .map((line) => line.trim())
    .reverse()
    .find((line) => line !== '' && !line.startsWith('#'));

  if (lastMeaningfulLine === undefined) {
    return undefined;
  }

  const matches = lastMeaningfulLine.matchAll(/(^|;|&&|&|\|)\s*(exit|exec)(?=$|\s|;|&&|&|\|\||\|)/g);
  for (const match of matches) {
    const separator = match[1] ?? '';
    const index = match.index ?? 0;
    if (separator === '|' && lastMeaningfulLine[index - 1] === '|') {
      continue;
    }

    return match[2] as 'exit' | 'exec';
  }

  return undefined;
}

function hasMeaningfulShellContent(hookBody: string): boolean {
  return hookBody.split('\n').some((line, index) => {
    const trimmed = line.trim();

    return trimmed !== '' && !trimmed.startsWith('#') && !(index === 0 && trimmed.startsWith('#!'));
  });
}

interface HookPathPrefix {
  prtokensBinPath: string;
  pathPrefix: string;
}

function renderManagedBlock(pathPrefix: HookPathPrefix, includeFinalExit: boolean, includeRepoLocalForwarding: boolean): string {
  const lines = [
    managedStart,
    'prtokens_previous_status=$?',
    'if [ "$prtokens_previous_status" -ne 0 ]; then',
    '  exit "$prtokens_previous_status"',
    'fi',
    '# Installed by `prtokens init`. Re-run prtokens init to update this block.',
    ...renderPathExportLines(pathPrefix.pathPrefix),
    'stdin_file="$(mktemp)" || exit 1',
    'if ! cat > "$stdin_file"; then',
    '  rm -f "$stdin_file"',
    '  exit 1',
    'fi',
    '',
  ];

  if (includeRepoLocalForwarding) {
    lines.push(
      'repo_common_dir="$(git rev-parse --path-format=absolute --git-common-dir 2>/dev/null || true)"',
      'repo_hook="${repo_common_dir:+$repo_common_dir/hooks/pre-push}"',
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
      '',
    );
  }

  lines.push(
    `prtokens_bin=${shellQuote(pathPrefix.prtokensBinPath)}`,
    'if [ ! -x "$prtokens_bin" ]; then',
    `  prtokens_bin="$(command -v prtokens 2>/dev/null || printf '%s\\n' ${shellQuote(pathPrefix.prtokensBinPath)})"`,
    'fi',
    'remote_name="$1"',
    'zero_sha=0000000000000000000000000000000000000000',
    'if [ -n "$stdin_file" ] && [ -r "$stdin_file" ]; then',
    '  while read local_ref local_sha remote_ref remote_sha; do',
    '    if [ -n "$remote_name" ] && [ -n "$local_sha" ] && [ "${remote_ref#refs/heads/}" != "$remote_ref" ] && [ "$local_sha" != "$zero_sha" ]; then',
    '      local_branch="${local_ref#refs/heads/}"',
    '      remote_branch="${remote_ref#refs/heads/}"',
    '      "$prtokens_bin" __hook-pushed-ref \\',
    '        --remote-name "$remote_name" \\',
    '        --local-branch "$local_branch" \\',
    '        --remote-branch "$remote_branch" \\',
    '        --head-sha "$local_sha" >/dev/null 2>&1 </dev/null || true',
    '    fi',
    '  done < "$stdin_file"',
    '  rm -f "$stdin_file"',
    'fi',
  );

  if (includeFinalExit) {
    lines.push('exit 0');
  }

  lines.push(managedEnd);

  return lines.join('\n');
}

function renderPathExportLines(pathPrefix: string): string[] {
  if (pathPrefix === '') return [];

  return [
    `PATH=${shellQuote(pathPrefix)}\${PATH:+":$PATH"}`,
    'export PATH',
    '',
  ];
}

function hookPathPrefix(deps: HookInstallerDeps): HookPathPrefix {
  const entries = [
    dirname(deps.prtokensBinPath),
    commandDir(deps, 'node'),
    commandDir(deps, 'gh'),
  ];

  return {
    prtokensBinPath: deps.prtokensBinPath,
    pathPrefix: uniqueStrings(entries)
      .filter((entry) => entry !== '' && isAbsolute(entry))
      .join(':'),
  };
}

function commandDir(deps: HookInstallerDeps, command: string): string {
  if ((deps.env.PATH ?? '') === '') return '';

  const result = runCommandSafely(deps, 'sh', ['-c', `command -v ${command}`]);
  if (result.status !== 0) return '';

  const commandPath = result.stdout.trim().split('\n')[0] ?? '';
  return commandPath === '' ? '' : dirname(commandPath);
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values)];
}

function trailingContentAfterManagedBlock(hookBody: string): string {
  const startIndex = hookBody.indexOf(managedStart);
  const endIndex = startIndex === -1 ? -1 : hookBody.indexOf(managedEnd, startIndex);

  return endIndex === -1 ? '' : hookBody.slice(endIndex + managedEnd.length);
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
