# prtokens

Attribute Claude Code token usage to the GitHub pull request that shipped it.

## Usage

```bash
npx prtokens
npx prtokens --dry-run
npx prtokens --json
npx prtokens --pr 123
npx prtokens --verbose
```

## What It Posts

`prtokens` posts or updates one PR comment containing aggregate token counts, estimated API-rate dollar cost, session count, model names, attribution coverage, and a per-commit table.

## Privacy

Claude Code transcripts never leave your machine. The GitHub comment contains aggregate numbers only: token counts, dollar estimates, session counts, model names, coverage, and commit metadata already visible in the PR.

## Requirements

- Node.js 20+
- GitHub CLI authenticated with `gh auth login`
- Claude Code local transcripts under `~/.claude/projects`

## Exit Behavior

- No open PR: prints a hint and exits 0.
- No transcripts: prints a hint and exits 0.
- Missing or unauthenticated `gh`: prints one-line setup instructions and exits 1.
- Comment post failure: prints the rendered markdown so you can paste it manually and exits 0.

## Pricing

Costs are estimated at API rates using a bundled LiteLLM pricing snapshot. Subscription users may have zero marginal cost; the number is a notional cost-awareness estimate.
