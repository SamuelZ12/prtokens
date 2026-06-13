# Changelog

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
