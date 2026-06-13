# Changelog

## 0.3.1 - 2026-06-13

### Fixed

- Exclude pre-PR history and uncommitted tail usage from PR token totals.
- Hide attribution diagnostics from generated PR comments.
- Prioritize source-reported costs in PR comment summaries.
- Harden generated pre-push hook installation and execution behavior.
- Price flat-rate cache usage when cache duration is not fully covered.

## 0.3.0 - 2026-06-13

### Added

- Add `prtokens init` to install global pre-push hook integration.
- Add Claude cache creation duration parsing, attribution, and pricing.

### Changed

- Include worktree roots when reading OpenCode usage.
- Prefer source-reported usage costs when agents provide them.
- Clarify estimated-cost wording in generated PR comments.

### Fixed

- Harden generated hook installation and execution around existing hooks, hook paths, stdin forwarding, recursion, and failure handling.
- Price Codex fast-mode usage.
- Keep pre-first-commit usage attribution separate from PR usage.
- Simplify cache token comment display.
- Preserve flat cache pricing and partial cache-duration coverage edge cases.

## 0.2.0 - 2026-06-12

### Added

- Add multi-agent usage attribution for Claude Code, Codex, and OpenCode.
- Add per-agent token and cost totals to PR comments and JSON output.
- Add Codex JSONL and OpenCode SQLite usage readers with source diagnostics.
- Bundle OpenAI GPT-5 coding-agent pricing aliases in the pricing snapshot.
- Export public multi-agent reader APIs and package metadata.

### Changed

- Require Node.js 22.13+ for `node:sqlite` support.
- Namespace session counting by agent to avoid cross-agent session collisions.
- Document multi-agent requirements and safer global pre-push hook setup.

## 0.1.0 - 2026-06-12

### Added

- Initial release for attributing Claude Code token usage to GitHub pull requests.
