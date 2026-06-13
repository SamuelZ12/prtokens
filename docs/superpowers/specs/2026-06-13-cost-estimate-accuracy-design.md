# Cost Estimate Accuracy Design

## Goal

Improve the default cost estimate accuracy without adding user-facing cost modes. `prtokens` should keep one automatic best-effort path: prefer source-reported costs when present, and otherwise estimate from token counts using the most specific token breakdown available in local logs and the bundled pricing snapshot.

## Context

`prtokens` currently reads Claude Code, Codex, and OpenCode usage, attributes events to PR commits, then prices buckets in `src/pricing.ts`. Claude Code records may include `costUSD`, and the current code already treats that as authoritative for the event. When `costUSD` is absent, the estimator uses bundled LiteLLM rates for input, output, cache write, and cache read tokens.

The main known accuracy gap is Claude cache creation pricing. Current code collapses `cache_creation_input_tokens` into one `cacheWriteTokens` value. Recent Claude Code JSONL records can include `usage.cache_creation.ephemeral_5m_input_tokens` and `ephemeral_1h_input_tokens`. ccusage prices these separately: 5-minute cache creation uses the normal cache creation rate, while 1-hour cache creation uses `input * 2`. Collapsing both buckets likely underprices 1-hour cache creation.

The current rendered PR footer also says `estimated at API rates` unconditionally, even when some costs are source-reported or when missing pricing warnings exist.

## Approach

Keep the single default pricing behavior. Do not add `--cost-mode` controls.

For each usage event:

1. If the source provides `sourceCostUsd`, use it as the event cost.
2. Otherwise, estimate from tokens.
3. For Claude cache creation tokens with duration breakdowns, price 5-minute and 1-hour tokens separately.
4. When no duration breakdown exists, preserve the current flat cache-write pricing behavior.

This keeps the default behavior simple while improving estimates for modern Claude Code records.

## Data Model

Extend token records with optional cache creation duration fields while preserving the existing aggregate token shape:

- `cacheWriteTokens` remains the total cache creation token count used in totals, attribution, and display.
- Add optional `cacheWrite5mTokens` and `cacheWrite1hTokens` for pricing precision.
- Readers that do not provide a duration breakdown leave these fields undefined.

The optional fields must be carried through every pricing-relevant aggregate:

- `UsageEvent`
- `AttributionBucket`
- `modelTokenTotals`
- `sourceCostTokenTotals`
- `sourceCostModelTokenTotals`

This ensures bucket-level pricing, mixed-model pricing, and mixed source-estimated pricing keep the duration detail needed for accurate estimates.

`transcript-reader.ts` will parse Claude Code usage as follows:

- If `usage.cache_creation` exists, read `ephemeral_5m_input_tokens` and `ephemeral_1h_input_tokens`.
- Set `cacheWriteTokens` to the sum of those values.
- Set `cacheWrite5mTokens` and `cacheWrite1hTokens` to the parsed values.
- If `usage.cache_creation` is absent, keep using `cache_creation_input_tokens` as the aggregate `cacheWriteTokens`.

Codex and OpenCode readers can keep their existing aggregate fields unchanged.

## Pricing

Update token pricing so cache creation is calculated from duration fields when available:

- Input: `(inputTokens / 1_000_000) * inputUsdPerMillion`
- Output: `(outputTokens / 1_000_000) * outputUsdPerMillion`
- Cache read: `(cacheReadTokens / 1_000_000) * cacheReadUsdPerMillion`
- Cache creation without breakdown: `(cacheWriteTokens / 1_000_000) * cacheWriteUsdPerMillion`
- Cache creation with breakdown: `(cacheWrite5mTokens / 1_000_000) * cacheWriteUsdPerMillion + (cacheWrite1hTokens / 1_000_000) * inputUsdPerMillion * 2`

When a duration breakdown is present, pricing should use the duration fields rather than double-counting the aggregate `cacheWriteTokens` value.

The source-reported cost path remains unchanged and authoritative. Source-cost token totals should continue tracking aggregate token totals and duration totals so mixed source-estimated buckets can subtract already-priced usage correctly.

Do not add tiered above-200k pricing in this change. It is a valid future improvement, but the cache-duration change is smaller and directly addresses the known current underpricing gap.

## Confidence And Output

Update user-facing language so it does not overstate how costs were produced.

The PR comment footer should no longer always say `estimated at API rates`. It should describe the mixed default behavior, for example: `cost uses source-reported values when available; otherwise estimated from token pricing`.

If pricing warnings exist, keep them in JSON as today. A concise comment-level warning can be added only if it does not make the comment noisy; otherwise the JSON warning output is enough for this change.

The existing attribution confidence fields remain unchanged:

- `attributedPercent`
- `lowConfidencePercent`

These already communicate commit-attribution confidence separately from cost-pricing confidence.

## Tests

Add focused coverage for:

- Claude transcript parsing of `usage.cache_creation.ephemeral_5m_input_tokens` and `ephemeral_1h_input_tokens`.
- Cost estimation where 1-hour cache creation is priced at `input * 2`.
- Fallback behavior when only flat `cache_creation_input_tokens` exists.
- Source-reported cost still overriding token-derived cost.
- Rendered footer no longer claiming all costs are estimated at API rates.

Existing mixed source-estimated bucket tests should continue to pass because aggregate cache creation totals remain available.

## Non-Goals

- No cost-mode CLI flag.
- No runtime pricing refresh.
- No custom pricing overrides.
- No tiered above-200k pricing in this change.
- No broad ccusage parity work beyond the cache-duration behavior and clearer confidence language.
