# prtokens — multi-agent support (Codex + OpenCode) design

**Date:** 2026-06-12
**Status:** Approved design, pre-implementation
**Extends:** `2026-06-12-prtokens-design.md` (v0). That doc scoped v0 to Claude
Code only and noted the attribution join was "designed source-agnostic for
later parsers." This is that work.

## 1. Goal

`prtokens` currently attributes Claude Code token usage to the PR that shipped
it. This feature adds two more sources — OpenAI Codex CLI and OpenCode — so a
PR comment reflects all coding-agent spend, and replaces the per-tool trigger
with one agent-agnostic mechanism.

Market check (2026-06-12): ccusage now reads Claude Code, Codex, OpenCode,
Amp, and pi-agent ("all detected sources by default") but remains a manual CLI
with no GitHub join. Codecov-style centralization (push → CI → bot comment)
requires the data to be visible server-side; agent transcripts live on dev
machines, so that model maps to v0's deferred Approach B, not this work.

## 2. Decisions (made 2026-06-12, with user)

| Decision | Choice | Rationale |
|---|---|---|
| Comment UX | Per-agent breakdown line in each author section | Shows which tool did what without bloating the comment; commit table stays merged |
| Trigger | Global git `pre-push` hook + existing Claude Code hook as backstop | Every agent shells out to `git push`; one chokepoint covers all tools and bare terminals. Claude hook covers the `gh pr create` gap. Idempotent overlap is harmless |
| Reader architecture | Per-agent reader modules behind the existing contract | Formats share almost nothing; a plugin framework is speculative; wrapping ccusage loses per-event timestamps/branch needed for commit attribution |
| SQLite access | Built-in `node:sqlite`, dynamic import | No native deps (v0 principle), no external binary. Engines bump to Node ≥22.13 (Node 20 EOL 2026-04-30); older Node degrades to a warning |
| OpenCode legacy JSON storage | Out of scope | Target machine fully migrated to SQLite; ccusage-style fallback noted as future work |
| Approach B (usage ref + Action) | Out of scope | Separate, larger project; this work is its foundation either way |

## 3. Architecture

Two new reader modules plus a thin aggregator, mirroring
`readClaudeTranscripts`'s contract exactly:

| Module | Responsibility |
|---|---|
| `src/codex-reader.ts` | `readCodexUsage({repoRoot, homeDir}) → {events, diagnostics}` from `~/.codex/sessions/` + `~/.codex/archived_sessions/` rollout JSONL |
| `src/opencode-reader.ts` | `readOpencodeUsage({repoRoot, homeDir}) → {events, diagnostics}` from `~/.local/share/opencode/opencode.db` (read-only) |
| `src/usage-readers.ts` | `readAllUsage(...)` — runs all three readers, tags events with `agent`, concatenates, merges per-source diagnostics, isolates failures |

`UsageEvent` gains a required field:

```ts
agent: 'claude-code' | 'codex' | 'opencode'
```

Attribution engine, pricing, comment renderer internals, and poster are
unchanged in their core logic — they already operate on normalized events.
The CLI swaps its direct `readClaudeTranscripts` call for `readAllUsage`.

Failure isolation: a missing store (ENOENT) yields zero events silently (the
normal case — most machines don't run all three tools). A broken store
(corrupt DB, unreadable file, missing `node:sqlite`) yields a warning in that
source's diagnostics; the other readers still run.

## 4. Codex reader

**Source:** `${homeDir}/.codex/sessions/**/*.jsonl` and
`${homeDir}/.codex/archived_sessions/**/*.jsonl`. When both contain the same
relative path, the active `sessions/` copy wins (ccusage precedent).

**File format** (verified against real rollouts, cli_version 0.125.0, and
cross-checked against ccusage's Codex adapter):

- `{type: "session_meta", payload: {id, timestamp, cwd, git: {branch, commit_hash}, ...}}`
  — first line; session id, working directory, git branch at session start.
- `{type: "turn_context", payload: {model, cwd, ...}}` — precedes each turn;
  carries the model name (e.g. `gpt-5.5`).
- `{timestamp, type: "event_msg", payload: {type: "token_count", info, rate_limits}}`
  — `info` is null for rate-limit-only updates (skip). Otherwise
  `info.last_token_usage` is the per-request delta and
  `info.total_token_usage` is the session-cumulative figure. Verified:
  last-usage values sum exactly to the cumulative across a session.

**Parse strategy:** stream lines per file. Read `session_meta` first; if
`payload.cwd` ≠ resolved `repoRoot`, skip the entire file (cheap filter —
~270 files on the target machine). Files with no parseable `session_meta`
`cwd` (pre-dating the format) are skipped entirely and tallied in
diagnostics — repo matching is impossible without it. Track the latest
`turn_context` model. Emit one `UsageEvent` per `token_count` with non-null
`info`.

**Token mapping** (from `last_token_usage`):

| UsageEvent field | Codex source | Note |
|---|---|---|
| `inputTokens` | `input_tokens − cached_input_tokens` | clamped ≥ 0; `cached_input_tokens` is a subset of `input_tokens` (verified: `total = input + output`) |
| `cacheReadTokens` | `min(cached_input_tokens, input_tokens)` | defensive clamp, ccusage precedent |
| `outputTokens` | `output_tokens` | already includes `reasoning_output_tokens` (verified subset) |
| `cacheWriteTokens` | `0` | OpenAI does not bill cache writes |

**Other fields:** `timestamp` = the line's outer timestamp. `model` = latest
`turn_context` model; if none has appeared (early-format sessions), leave
empty so pricing surfaces its existing "no bundled pricing" warning rather
than silently guessing. `sessionId` = `session_meta.payload.id`. `gitBranch` =
`session_meta.payload.git.branch` → these events attribute with high
confidence.

**Legacy cumulative-only entries** (no `last_token_usage`): recover the delta
by subtracting the previous cumulative total within the file (ccusage's
rule); the first such entry uses the cumulative value as-is.

**Dedupe key:** `sessionId:timestamp:total_token_usage.total_tokens` —
stable if a resumed session ever replays lines across files. Fallback when
identity fields are missing: `filePath:lineNumber`. Event id prefix:
`codex-rollout:`.

## 5. OpenCode reader

**Source:** `${homeDir}/.local/share/opencode/opencode.db`, plus any
`opencode-*.db` siblings (ccusage precedent). Open **read-only** via dynamic
`import('node:sqlite')` (`DatabaseSync`, `{readOnly: true}`); WAL mode makes
concurrent reads safe alongside a running OpenCode instance.

**Schema** (verified against a live 3.5 GB DB, Drizzle-managed): `message`
table has `id` (PK), `session_id`, `time_created`, and `data` (JSON). Assistant
messages carry:

```json
{
  "role": "assistant",
  "path": {"root": "/abs/repo/root", "cwd": "..."},
  "tokens": {"total": n, "input": n, "output": n, "reasoning": n,
             "cache": {"read": n, "write": n}},
  "modelID": "gpt-5.5-fast", "providerID": "openai",
  "time": {"created": ms, "completed": ms}
}
```

**Query:** one SELECT of `id`, `session_id`, and the needed `json_extract`
fields where `json_extract(data,'$.role') = 'assistant'` and
`json_extract(data,'$.path.root') = :repoRoot`.

**Token mapping:**

| UsageEvent field | OpenCode source | Note |
|---|---|---|
| `inputTokens` | `tokens.input` | already excludes cache reads (verified) |
| `outputTokens` | `tokens.output + tokens.reasoning` | reasoning is a **separate billable bucket** — verified `total = input + output + reasoning + cache.read + cache.write` exactly, with reasoning sometimes exceeding output. (ccusage drops it; we don't) |
| `cacheReadTokens` | `tokens.cache.read` | |
| `cacheWriteTokens` | `tokens.cache.write` | nonzero for Anthropic-style providers |

**Other fields:** `model` = `modelID`. `sessionId` = `session_id` column.
`timestamp` = ISO-8601 from `time.completed ?? time.created` (epoch ms).
`gitBranch` = undefined — OpenCode stores no branch, so these events take the
existing low-confidence path (attributed by timestamp, counted in the
low-confidence percentage). Dedupe: message `id`, applied across all opened
DB files (a message migrated between DBs counts once); event id =
`opencode-db:<messageId>`.

The per-message `cost` field is ignored (it is 0 under subscription auth);
prtokens always prices from its own snapshot for consistency across agents.

## 6. Pricing

Regenerate `src/pricing/litellm-snapshot.json` from LiteLLM upstream
(`model_prices_and_context_window.json`, fetched at implementation time —
gpt-5.4/5.5 rates postdate training data and must not come from memory).
Keep the existing Anthropic entries; add the OpenAI families observed in real
usage and their near neighbors: `gpt-5.x`, `gpt-5.x-codex`, `gpt-5.x-fast`,
`mini`/`nano` variants. Conversion as today (per-token × 1e6). OpenAI
cache-write rate = 0 (field absent upstream; writes are unbilled).

Model-name keys observed in real data (`gpt-5.4`, `gpt-5.5`, `gpt-5.4-fast`,
`gpt-5.5-fast` from OpenCode; `gpt-5.5` from Codex turn_context) are expected
to match LiteLLM keys directly; add alias normalization only if a used model
turns out missing.

The snapshot stays bundled and offline — no network at runtime (privacy
stance unchanged). Note: `dist/pricing/litellm-snapshot.json` is currently a
stale 2-model copy; the next `npm run build` refreshes it.

## 7. Comment rendering

`RenderAuthorInput` and the hidden author-marker JSON gain:

```ts
agents?: Array<{agent: string; costUsd: number; inputTokens: number;
                outputTokens: number; sessionCount: number}>
```

- Rendered as one line per author section, **only when 2+ agents** are
  present (single-agent sections look exactly as today):
  `Agents: \`claude-code\` ~$3.20 · \`codex\` ~$1.10 · \`opencode\` ~$0.45`
  (ordered by cost, descending).
- `isAuthorSummary` treats `agents` as optional → old comment markers parse
  unchanged; existing PR comments upsert cleanly.

Per-agent numbers come from running the existing pure pipeline
(`attributeUsageToCommits` → `priceAttributionResult`) once per agent
partition of the events, totals only. Zero engine changes; pricing is linear
per (model, tokens), so partition costs sum exactly to the merged headline
total. Agents whose partition attributes zero events are dropped from the
array.

## 8. CLI surface

- `CliDeps.readClaudeTranscripts` → `readAllUsage` (test doubles updated).
- `--verbose` prints per-source diagnostics
  (`claude-code: 12 files scanned…`, `opencode: skipped — Node 22.13+
  required`, malformed/skipped/deduped counts per source).
- No-data message: `No coding-agent usage found for this repo (checked
  Claude Code, Codex, OpenCode).`
- `--json`: additive fields — per-agent totals and per-source diagnostics.
- `package.json` description and README updated to "coding-agent token
  usage"; engines `>=22.13`; `@types/node` ^22.

## 9. Trigger: global git pre-push hook

Setup on this machine (documented in README for others):

1. Write `~/.config/git/hooks/pre-push` (executable, `#!/bin/sh`):
   - Buffer stdin (the refs list).
   - If the repo's own `"$GIT_DIR/hooks/pre-push"` exists and is executable,
     run it with the same args and replayed stdin; propagate non-zero exit
     (repo hooks like husky-managed ones keep working, and can still block
     the push).
   - Launch `prtokens >/dev/null 2>&1 </dev/null &` — fire-and-forget;
     pushes gain zero latency and prtokens can never block a push.
2. `git config --global core.hooksPath ~/.config/git/hooks`.

Caveats (documented):

- Repos that set `core.hooksPath` **locally** (husky does) bypass the global
  hook entirely; those pushes rely on the Claude Code backstop or manual runs.
- `gh pr create` on an already-pushed branch performs no push, so the first
  comment on a brand-new PR comes from the **existing Claude Code PostToolUse
  hook**, which is kept. Overlapping runs are idempotent upserts.
- A `prtokens setup-hooks` subcommand is deferred until sharing demands it.

## 10. Error handling

| Condition | Behavior |
|---|---|
| Store missing (no `~/.codex`, no DB) | Zero events, no output (normal) |
| `node:sqlite` unavailable (Node < 22.13) | Warning diagnostic: OpenCode skipped; others run |
| Corrupt/locked DB, unreadable file | Warning diagnostic for that source; others run |
| Malformed JSONL lines / JSON columns | Tallied per source, reported under `--verbose` (existing pattern) |

Exit-code behavior is unchanged from v0.

## 11. Testing

Vitest, one suite per module (repo precedent):

- **codex-reader**: cwd-mismatch file skip; null-info token_counts skipped;
  delta recovery from cumulative-only legacy entries; model tracking across
  turn_contexts and empty-model fallback; branch propagation; resumed-session
  dedupe across files; archived/active precedence; `cached > input` clamp.
- **opencode-reader**: builds a real temp SQLite file with the `message`
  schema and fixture rows — repo-root filter, output+reasoning summation,
  cache mapping, epoch→ISO conversion, missing-DB silence, mocked
  `node:sqlite` import failure → graceful warning.
- **usage-readers**: agent tagging, merge, one-reader-throws isolation,
  diagnostics namespacing.
- **comment-renderer / cli**: `Agents:` line at 2+ agents only; legacy marker
  (no `agents` field) backward compat; new `--json`/`--verbose` shapes.
- **pricing**: gpt-5.x entries load and price after snapshot regeneration.
- **End-to-end (manual)**: `prtokens --dry-run` in a repo with real Codex
  sessions (reposeek) and one with OpenCode usage; a real push through the
  new git hook verifying chaining + background fire; a PR comment upsert that
  merges with a pre-existing prtokens comment.

## 12. Out of scope

- Codex/OpenCode native hook configuration (superseded by the git hook).
- OpenCode legacy `storage/message/*.json` fallback.
- Approach B (usage records on a hidden git ref + GitHub Action poster).
- Watcher daemon.
- Amp, pi-agent, or other agents (the reader convention makes each a
  one-file addition later).
