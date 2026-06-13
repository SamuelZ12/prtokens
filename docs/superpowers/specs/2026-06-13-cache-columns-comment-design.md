# Cache Columns Comment Design

## Context

The PR comment currently shows separate `Cache Write` and `Cache Read` columns in the commit breakdown. These values explain prompt-cache billing, but they make the default table harder to scan for normal PR review.

## Approved Behavior

The default Markdown PR comment should hide cache token counts from the commit breakdown table. The table should show the core review fields only: commit, message, input tokens, output tokens, cost, and sessions.

Costs should continue to include prompt-cache write/read tokens when the underlying coding-agent usage reports them. To avoid confusion, the details section should include a short note after the table: `Cost includes prompt-cache write/read tokens when reported by the coding agent.`

## Data Flow

Pricing and attribution continue to carry `cacheWriteTokens` and `cacheReadTokens`. The renderer receives those fields unchanged, but only uses them indirectly through each row's priced `costUsd`.

The `--json` payload remains unchanged so debugging and downstream consumers can still inspect detailed cache token values.

## Testing

Renderer tests should assert that the Markdown table no longer includes `Cache Write` or `Cache Read`, that row cells omit cache token counts, and that the explanatory note is present. CLI tests should assert dry-run Markdown follows the same default behavior while JSON retains cache fields.
