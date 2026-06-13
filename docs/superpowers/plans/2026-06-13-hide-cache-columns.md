# Hide Cache Columns Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove prompt-cache token columns from the default Markdown PR comment while preserving cache-inclusive costs and JSON detail.

**Architecture:** Keep attribution and pricing unchanged. Update only the Markdown renderer expectations and output, then verify CLI dry-run Markdown and JSON behavior through existing tests.

**Tech Stack:** TypeScript, Vitest, Markdown rendering in `src/comment-renderer.ts`.

---

## File Structure

- Modify `tests/comment-renderer.test.ts`: assert the default table omits `Cache Write` and `Cache Read`, row cells omit cache token values, and the cache-cost note appears.
- Modify `tests/cli.test.ts`: assert dry-run Markdown omits cache columns while JSON still exposes `cacheWriteTokens` and `cacheReadTokens`.
- Modify `src/comment-renderer.ts`: remove cache columns from the table and append the explanatory note inside the details section.

### Task 1: Renderer Markdown Contract

**Files:**
- Modify: `tests/comment-renderer.test.ts`
- Modify: `src/comment-renderer.ts`

- [ ] **Step 1: Write the failing renderer expectations**

Change the first renderer test to expect this header and row:

```ts
expect(body).toContain('| Commit | Message | In | Out | Cost | Sessions |');
expect(body).not.toContain('Cache Write');
expect(body).not.toContain('Cache Read');
expect(body).toContain('| `aaa1111` | first commit | 1M | 100k | ~$2.30 | 1 |');
expect(body).toContain('Cost includes prompt-cache write/read tokens when reported by the coding agent.');
```

Update preserved-section assertions so expected rows use the six-column format, for example:

```ts
expect(body).toContain('| `abc9999` | alex unique detail row | 100k | 10k | ~$1.00 | 1 |');
```

- [ ] **Step 2: Run the focused renderer test and verify it fails**

Run: `npm test -- tests/comment-renderer.test.ts`

Expected: failure because `src/comment-renderer.ts` still renders cache columns.

- [ ] **Step 3: Update the renderer table and note**

In `src/comment-renderer.ts`, change the details section to render:

```ts
'| Commit | Message | In | Out | Cost | Sessions |',
'| --- | --- | ---: | ---: | ---: | ---: |',
...author.rows.map(
  (row) =>
    `| \`${truncateSha(row.sha)}\` | ${escapeTableCell(row.message)} | ${formatTokens(row.inputTokens)} | ${formatTokens(
      row.outputTokens,
    )} | ${formatCost(row.costUsd)} | ${row.sessionCount} |`,
),
'',
'Cost includes prompt-cache write/read tokens when reported by the coding agent.',
```

- [ ] **Step 4: Run the focused renderer test and verify it passes**

Run: `npm test -- tests/comment-renderer.test.ts`

Expected: all renderer tests pass.

### Task 2: CLI Markdown and JSON Coverage

**Files:**
- Modify: `tests/cli.test.ts`

- [ ] **Step 1: Add CLI assertions for default Markdown and JSON**

In the dry-run or pre-first-commit test area, assert Markdown omits cache columns:

```ts
const markdown = deps.stdout.mock.calls[0]?.[0];
expect(markdown).toContain('| Commit | Message | In | Out | Cost | Sessions |');
expect(markdown).not.toContain('Cache Write');
expect(markdown).not.toContain('Cache Read');
expect(markdown).toContain('Cost includes prompt-cache write/read tokens when reported by the coding agent.');
```

In the JSON test, assert cache fields remain in priced output:

```ts
expect(payload.pricing.buckets[0]).toMatchObject({ cacheWriteTokens: 100, cacheReadTokens: 50 });
```

- [ ] **Step 2: Run the focused CLI test**

Run: `npm test -- tests/cli.test.ts`

Expected: all CLI tests pass after Task 1 renderer changes.

### Task 3: Final Verification and Commit

**Files:**
- Modify: `tests/comment-renderer.test.ts`
- Modify: `tests/cli.test.ts`
- Modify: `src/comment-renderer.ts`

- [ ] **Step 1: Run full verification**

Run: `npm test`

Expected: all tests pass.

Run: `npm run typecheck`

Expected: no TypeScript errors.

Run: `npm run build`

Expected: build completes and copies the pricing snapshot.

- [ ] **Step 2: Commit implementation**

```bash
git add src/comment-renderer.ts tests/comment-renderer.test.ts tests/cli.test.ts docs/superpowers/plans/2026-06-13-hide-cache-columns.md
git commit -m "fix: simplify cache token comment display"
```

## Self-Review

- Spec coverage: the plan removes cache columns, adds a note, leaves JSON intact, and verifies the default comment and JSON payload.
- Placeholder scan: no placeholders remain.
- Type consistency: existing `cacheWriteTokens` and `cacheReadTokens` names are preserved; only Markdown rendering changes.
