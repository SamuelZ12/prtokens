# prtokens

Attribute coding-agent token usage to the GitHub pull request that shipped it.

## Usage

```bash
npx prtokens
npx prtokens --dry-run
npx prtokens --json
npx prtokens --pr 123
npx prtokens --verbose
```

`--verbose` prints per-source reader diagnostics. `--json` includes the rendered markdown, attribution result, pricing result, per-agent totals, and per-source diagnostics.

## What It Posts

`prtokens` posts or updates one PR comment containing aggregate token counts, estimated API-rate dollar cost, session count, model names, attribution coverage, and a per-commit table.

## Privacy

Claude Code transcripts, Codex rollouts, and OpenCode databases never leave your machine. The GitHub comment contains aggregate numbers only: token counts, dollar estimates, session counts, model names, agent names, coverage, and commit metadata already visible in the PR.

## Requirements

- Node.js 22.13+
- GitHub CLI authenticated with `gh auth login`
- Claude Code transcripts under `~/.claude/projects` when using Claude Code
- Codex sessions under `~/.codex/sessions` or `~/.codex/archived_sessions` when using Codex
- OpenCode SQLite databases under `~/.local/share/opencode` when using OpenCode

## Optional Global Pre-Push Hook

To run `prtokens` as a best-effort background task from `pre-push` on this machine, install it globally and run the setup command:

```bash
npm i -g prtokens
prtokens init
```

Preview the changes without writing files:

```bash
prtokens init --dry-run
```

`prtokens init` installs or updates a sentinel-wrapped managed block in the global `pre-push` hook. If an absolute global `core.hooksPath` is already configured, prtokens respects it and writes the hook there. If it is unset, prtokens creates `~/.config/git/hooks/pre-push` and sets `core.hooksPath` to `~/.config/git/hooks`. If your existing global `core.hooksPath` is relative, `prtokens init` fails safely instead of writing to a path relative to the current directory. Set an absolute global hooks path or use manual setup for that configuration.

Setup checks for Node.js 22.13+, GitHub CLI, and `gh auth login` are informational. The hook still installs so you can fix prerequisites later.

<details><summary>Manual / advanced setup</summary>

First check whether you already have a global hooks path:

```sh
git config --global --path --get core.hooksPath
```

If this prints an absolute path, use that path as the target hooks directory and place or merge the `pre-push` hook there. Do not overwrite existing hooks. If a shell `pre-push` file already exists, prefer appending the managed block below to the end of that file. `prtokens init` fails safely instead of appending when the existing hook's last meaningful line is terminal `exit` or `exec`, because the managed block would be unreachable. Keep the block after any logic that needs original `pre-push` stdin, because the block captures stdin with `cat > "$stdin_file"`. If you manually place it before trailing commands, those commands must not depend on stdin unless you adapt the hook to replay `"$stdin_file"` to them.

If this prints a relative path, it is resolved by Git relative to each repository. `prtokens init` rejects that configuration because it cannot safely update one global hook file for all repositories. Set an absolute global hooks path or manually install the block in the repository-specific hook locations you intend to use.

If replacing an existing `# >>> prtokens >>>` / `# <<< prtokens <<<` managed block and the hook has trailing commands after it, prefer `prtokens init --dry-run` to preview the exact replacement before running `prtokens init`. Be careful around an existing terminal `exit 0`: to run prtokens, the block must be reachable, but moving it earlier must not bypass failure handling or stdin-consuming logic.

If it prints nothing, create a global hooks directory and configure Git to use it:

```sh
mkdir -p ~/.config/git/hooks
git config --global core.hooksPath ~/.config/git/hooks
```

For a new `pre-push` file, start with:

```sh
#!/bin/sh

# >>> prtokens >>>
prtokens_previous_status=$?
if [ "$prtokens_previous_status" -ne 0 ]; then
  exit "$prtokens_previous_status"
fi
# Installed by `prtokens init`. Re-run prtokens init to update this block.
stdin_file="$(mktemp)" || exit 1
if ! cat > "$stdin_file"; then
  rm -f "$stdin_file"
  exit 1
fi

repo_common_dir="$(git rev-parse --path-format=absolute --git-common-dir 2>/dev/null || true)"
repo_hook="${repo_common_dir:+$repo_common_dir/hooks/pre-push}"
current_hook="$0"
repo_hook_path="$repo_hook"
if command -v realpath >/dev/null 2>&1; then
  current_hook="$(realpath "$current_hook" 2>/dev/null || printf '%s\n' "$current_hook")"
  repo_hook_path="$(realpath "$repo_hook" 2>/dev/null || printf '%s\n' "$repo_hook")"
fi
if [ -n "$repo_hook" ] && [ -x "$repo_hook" ] && [ "$repo_hook_path" != "$current_hook" ]; then
  if "$repo_hook" "$@" < "$stdin_file"; then
    status=0
  else
    status=$?
  fi
  if [ "$status" -ne 0 ]; then
    rm -f "$stdin_file"
    exit "$status"
  fi
fi

rm -f "$stdin_file"
prtokens_bin="$(command -v prtokens 2>/dev/null || echo '/absolute/path/to/prtokens')"
"$prtokens_bin" >/dev/null 2>&1 </dev/null &
exit 0
# <<< prtokens <<<
```

Replace `/absolute/path/to/prtokens` with the path to your installed binary. `prtokens init --dry-run` prints the exact managed block prtokens would generate, including its absolute fallback path.

Then make the hook executable:

```sh
chmod +x "$(git config --global --path --get core.hooksPath)/pre-push"
```

</details>

Caveats: `prtokens` must be on `PATH` for Git hooks, or the generated absolute fallback path from `prtokens init` / `--dry-run` must remain valid; `pre-push` may not observe newly pushed commits immediately, especially on first pushes or PR creation; repositories with a local `core.hooksPath` bypass the global hook; `gh pr create` on an already-pushed branch performs no push, so it will not trigger this hook.

## Exit Behavior

- No open PR: prints a hint and exits 0.
- No transcripts: prints a hint and exits 0.
- Missing or unauthenticated `gh`: prints one-line setup instructions and exits 1.
- Comment post failure: prints the rendered markdown so you can paste it manually and exits 0.

## Pricing

Costs are estimated at API rates using a bundled LiteLLM pricing snapshot covering Claude models across first-party, Bedrock, and Vertex id forms. Subscription users may have zero marginal cost; the number is a notional cost-awareness estimate.

Refresh the snapshot from LiteLLM's published rates with `npm run update-pricing`.
