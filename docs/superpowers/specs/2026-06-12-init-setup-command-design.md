# prtokens — `init` setup command design

**Date:** 2026-06-12
**Status:** Approved design, pre-implementation
**Relates to:** `2026-06-12-prtokens-design.md` (v0) and
`2026-06-12-multi-agent-support-design.md`. Those define the global `pre-push`
hook that this command automates installing.

## 1. Goal

Make prtokens shareable. Today, "set everything up so all my PRs track token
usage" requires a developer to paste a ~25-line shell snippet from the README
to hand-install a global `pre-push` hook, plus separately have `prtokens` on
`PATH` and `gh` authenticated. This feature collapses that into one shareable
command:

```bash
npm i -g prtokens && prtokens init
```

The global install puts `prtokens` on `PATH` (so the hook can call it); `init`
installs the hook idempotently and reports on the remaining prerequisites.

## 2. Decisions (made 2026-06-12, with user)

| Decision | Choice | Rationale |
|---|---|---|
| Setup model | Per-machine, global `pre-push` hook | Matches "all PRs across all my repos" and the existing README approach. Per-repo models were rejected |
| Scope | Install hook + preflight checks (Node, `gh` installed, `gh` authed) | Best first-run experience. Auto-installing `gh` / running interactive `gh auth login` rejected as fragile across OSes |
| Delivery | `prtokens init` subcommand | Idiomatic for an npm tool, cross-platform (Node, not shell), unit-testable, lives in the repo. `curl \| sh` (trust/hosting/portability) and npm `postinstall` (surprising global side-effect, blocked by npm) rejected |
| Preflight severity | Informational, never blocks the hook install | Prerequisites can be fixed after setup; the hook is best-effort anyway |
| Existing config | Respect an existing global `core.hooksPath`; never clobber a foreign global hook | Sentinel-wrapped managed block; appends to foreign hooks, replaces only our own block on re-run |
| `--dry-run` on `init` | Keep | Trust aid for a command that edits global git config |
| Absolute-path fallback in hook | Keep | Robust against GUI git clients with a minimal `PATH` |
| Trigger mechanism | Unchanged (`pre-push`) | Fixing the `gh pr create` / first-push gap is separate, larger work |

## 3. Architecture

One new module plus CLI wiring, following the codebase's existing
dependency-injection + structured-result style (`readAllUsage`, `runCli` deps).

| Module | Responsibility |
|---|---|
| `src/hook-installer.ts` | Pure logic with injected deps. Exports `runPreflight(deps) → PreflightResult` and `installGlobalPrePushHook(deps) → InstallResult`. No direct console I/O — returns structured results |
| `src/cli.ts` | Subcommand dispatch + `runInit(argv, deps)` that calls the installer and formats output via the existing `stdout`/`stderr` deps |

Injected deps (so tests never touch the real home dir or git config):

```ts
interface HookInstallerDeps {
  runCommand(cmd: string, args: string[]): { stdout: string; status: number };
  homedir(): string;
  env: NodeJS.ProcessEnv;
  fs: {
    existsSync(p: string): boolean;
    readFileSync(p: string): string;
    writeFileSync(p: string, data: string): void;
    mkdirSync(p: string, opts: { recursive: true }): void;
    chmodSync(p: string, mode: number): void;
  };
  nodeVersion: string; // process.versions.node
  prtokensBinPath: string; // absolute path resolved at init for the hook fallback
}
```

## 4. CLI surface

`runCli` gains subcommand dispatch **before** the existing `parseArgs`:

- If `argv[0] === 'init'` → `return runInit(argv.slice(1), deps)`.
- Otherwise → the existing report flow runs exactly as today (`parseArgs` with
  `allowPositionals: false`, flags `--dry-run`/`--json`/`--verbose`/`--pr`).

Backward compatibility: bare `prtokens` and all existing flags are untouched.
Only the new `init` positional is added; the report path never sees it.

`init` parses its own args: a single `--dry-run` boolean (print planned
actions + the hook body, write nothing, change no git config). Unknown args to
`init` error out via `parseArgs` strict mode, consistent with the report path.

## 5. What `init` does

### 5.1 Preflight (informational)

Run before the install and report at the end; **none of these block the hook
install**:

1. **Node** — compare `process.versions.node` to `>=22.13`. Below → ⚠ with the
   required version. (prtokens itself needs it, but `init` still installs.)
2. **`gh` installed** — `gh --version`; non-zero/ENOENT → ✗ with install hint.
3. **`gh` authenticated** — `gh auth status`; non-zero → ✗ with `gh auth login`
   hint. Skipped (reported as unknown) if `gh` is not installed.

### 5.2 Hook install (core)

1. **Resolve the hooks dir.** Read `git config --global --get core.hooksPath`.
   - Set → use that directory as-is (respect the user's choice); do **not**
     change `core.hooksPath`.
   - Unset → use `<homedir>/.config/git/hooks` (absolute, `~` expanded via
     `homedir()`), and set `core.hooksPath` to it after writing the hook.
2. **Ensure the dir exists** (`mkdirSync(..., { recursive: true })`).
3. **Write/merge `<hooksDir>/pre-push`** using a sentinel-wrapped managed block:
   - Sentinels: `# >>> prtokens >>>` and `# <<< prtokens <<<`.
   - File absent → write `#!/bin/sh\n` + the managed block.
   - File present, contains our sentinels → replace **only** the text between
     them (idempotent re-run / template refresh); leave the rest intact.
   - File present, no sentinels (foreign global hook) → append the managed
     block to the end, preserving existing content. Report that we appended.
   - `chmodSync(hookPath, 0o755)` in all write cases.
4. **Set `core.hooksPath`** only in the unset case from step 1, to the absolute
   default dir.

### 5.3 Report

A tidy summary via `stdout`:

- What happened to the hook: `installed` / `updated existing block` /
  `appended to existing hook` / `already up to date`, with the absolute path.
- Whether `core.hooksPath` was set by us or an existing one was respected.
- Prerequisite checklist (Node / gh installed / gh authed) with next-step hints
  for any ✗.
- Closing line: push a branch that has an open PR and prtokens will comment.

Exit code: `0` when the hook is in place (even if `gh` still needs auth); `1`
only if the hook write/chmod fails. `--dry-run` prints the plan + hook body and
exits `0` without writing.

## 6. The hook body

Same chaining behavior as today's README hook (so a global `core.hooksPath`
does not silently disable repo-local `pre-push` hooks), plus a `PATH`-robust
invocation:

```sh
# >>> prtokens >>>
# Installed by `prtokens init`. Re-run prtokens init to update this block.
stdin_file="$(mktemp)"
cat > "$stdin_file"

repo_git_dir="$(git rev-parse --absolute-git-dir 2>/dev/null || true)"
repo_hook="${repo_git_dir:+$repo_git_dir/hooks/pre-push}"
if [ -n "$repo_hook" ] && [ -x "$repo_hook" ]; then
  "$repo_hook" "$@" < "$stdin_file"
  status=$?
  if [ "$status" -ne 0 ]; then
    rm -f "$stdin_file"
    exit "$status"
  fi
fi

rm -f "$stdin_file"
prtokens_bin="$(command -v prtokens 2>/dev/null || echo '<ABS_PATH_AT_INIT>')"
"$prtokens_bin" >/dev/null 2>&1 </dev/null &
exit 0
# <<< prtokens <<<
```

`<ABS_PATH_AT_INIT>` is the absolute path to the installed `prtokens` binary,
resolved during `init` (from `process.argv[1]` / the global bin), so GUI git
clients with a minimal `PATH` still work. When appending to a foreign hook, the
block omits the leading `#!/bin/sh` (the existing file already has its shebang).

## 7. Testing

`tests/hook-installer.test.ts` with injected fs/exec/home (no real writes):

- Fresh machine (no `core.hooksPath`): writes `pre-push`, sets `core.hooksPath`
  to the absolute default, `chmod 0755`, body contains both sentinels and the
  resolved bin path.
- Existing global `core.hooksPath`: writes into that dir, does **not** change
  `core.hooksPath`.
- Foreign existing `pre-push`: appends the managed block, preserves original
  content, no second shebang.
- Re-run idempotency: a file already containing our sentinels has only the
  block replaced; surrounding content unchanged; running twice is a no-op
  beyond the block.
- `--dry-run`: no `writeFileSync` / `mkdirSync` / `chmodSync` / git-config
  writes occur; plan + hook body printed.
- Preflight: gh missing, gh installed-but-not-authed, old Node — each reported
  with the right status and hint; none block the install.

CLI dispatch tests in `tests/cli.test.ts`: `prtokens init` routes to the
installer; bare `prtokens` and existing flags are unaffected; `init` with an
unknown flag errors.

## 8. Docs

README: replace the manual snippet section with the one-liner
(`npm i -g prtokens && prtokens init`) and a note about `prtokens init
--dry-run` to preview. Keep the manual steps as a collapsed "manual / advanced"
fallback for users who don't want a global install.

## 9. Out of scope

- Changing the trigger from `pre-push` (the `gh pr create` / first-push gap
  remains, as the README already documents).
- An uninstall command. The managed block is removable by hand; a
  `prtokens init --uninstall` is possible future work.
- Auto-installing `gh` or running interactive `gh auth login`.
- Per-repo / committed-hook setup models.
