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

To run `prtokens` as a best-effort background task from `pre-push` on this machine, install a global `pre-push` hook. First check whether you already have a global hooks path:

```sh
git config --global --get core.hooksPath
```

If this prints a path, place or merge the `pre-push` hook in that existing directory instead of overwriting it. If it prints nothing, this example creates a global hooks directory and configures Git to use it:

```sh
mkdir -p ~/.config/git/hooks
cat > ~/.config/git/hooks/pre-push <<'EOF'
#!/bin/sh
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
prtokens >/dev/null 2>&1 </dev/null &
exit 0
EOF
chmod +x ~/.config/git/hooks/pre-push
git config --global core.hooksPath ~/.config/git/hooks
```

The hook invokes `prtokens` directly, so `prtokens` must be available on `PATH` for Git hooks, such as through a global install or another wrapper command. Because this runs from `pre-push`, it may not observe newly pushed commits immediately, especially on first pushes or PR creation. Repositories with a local `core.hooksPath` bypass the global hook. `gh pr create` on an already-pushed branch performs no push, so it will not trigger this hook.

## Exit Behavior

- No open PR: prints a hint and exits 0.
- No transcripts: prints a hint and exits 0.
- Missing or unauthenticated `gh`: prints one-line setup instructions and exits 1.
- Comment post failure: prints the rendered markdown so you can paste it manually and exits 0.

## Pricing

Costs are estimated at API rates using a bundled LiteLLM pricing snapshot covering Claude models across first-party, Bedrock, and Vertex id forms. Subscription users may have zero marginal cost; the number is a notional cost-awareness estimate.

Refresh the snapshot from LiteLLM's published rates with `npm run update-pricing`.
