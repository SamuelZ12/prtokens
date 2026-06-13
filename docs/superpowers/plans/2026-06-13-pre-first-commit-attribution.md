# Pre-First-Commit Attribution Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make PR commit cost breakdowns more accurate by separating usage before the first PR commit and making cache-token costs visible.

**Architecture:** Attribution will create a dedicated `pre-first-commit work` bucket for usage earlier than the first PR commit instead of rolling it into that first commit. Rendering will include cache write/read token columns so the displayed tokens explain the dollar estimate.

**Tech Stack:** TypeScript, Vitest, Node.js CLI, GitHub-flavored Markdown rendering.

---

### Task 1: Add Pre-First-Commit Attribution Bucket

**Files:**
- Modify: `src/types.ts`
- Modify: `src/attribution-engine.ts`
- Test: `tests/attribution-engine.test.ts`

- [ ] **Step 1: Write the failing test**

Add a test replacing the existing expectation that pre-first-commit usage rolls into the first commit:

```ts
it('puts usage before the first commit in a visible pre-first-commit bucket', () => {
  const result = attributeUsageToCommits({
    branch: 'main',
    commits,
    events: [usageEvent({ gitBranch: 'main' })],
  });

  expect(result.preFirstCommit).toMatchObject({
    label: 'pre-first-commit work',
    inputTokens: 100,
    outputTokens: 10,
    eventCount: 1,
    sessionCount: 1,
  });
  expect(result.buckets[0]).toMatchObject({ commitSha: 'aaa1111', eventCount: 0, inputTokens: 0 });
  expect(result.buckets[1]).toMatchObject({ commitSha: 'bbb2222', eventCount: 0, inputTokens: 0 });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/attribution-engine.test.ts`

Expected: FAIL because `preFirstCommit` does not exist and the first commit still receives the event.

- [ ] **Step 3: Write minimal implementation**

Update `src/types.ts`:

```ts
export interface AttributionBucket extends TokenTotals {
  commitSha?: string;
  patchId?: string;
  message?: string;
  authorLogin?: string;
  label?: 'pre-first-commit work' | 'uncommitted tail';
  eventCount: number;
  lowConfidenceEventCount: number;
  models: string[];
  modelTokenTotals?: ModelTokenTotals;
}

export interface AttributionResult {
  branch: string;
  preFirstCommit?: AttributionBucket;
  buckets: AttributionBucket[];
  uncommittedTail?: AttributionBucket;
  totals: TokenTotals & {
    observedEventCount: number;
    attributedEventCount: number;
    lowConfidenceEventCount: number;
  };
  coverage: {
    attributedPercent: number;
    lowConfidencePercent: number;
  };
}
```

Update `src/attribution-engine.ts` to create and include the pre-first bucket:

```ts
let preFirstCommit: MutableBucket | undefined;
let uncommittedTail: MutableBucket | undefined;

for (const event of input.events) {
  const lowConfidence = event.gitBranch === undefined;

  if (!lowConfidence && event.gitBranch !== input.branch) {
    continue;
  }

  const bucket = bucketForEvent(buckets, commits, event, () => (preFirstCommit ??= createPreFirstCommitBucket()), () => (uncommittedTail ??= createTailBucket()));
  addEventToBucket(bucket, event, lowConfidence);
}

const allBuckets = [
  ...(preFirstCommit === undefined ? [] : [preFirstCommit]),
  ...buckets,
  ...(uncommittedTail === undefined ? [] : [uncommittedTail]),
];
```

Add helper behavior:

```ts
function createPreFirstCommitBucket(): MutableBucket {
  return {
    label: 'pre-first-commit work',
    inputTokens: 0,
    outputTokens: 0,
    cacheWriteTokens: 0,
    cacheReadTokens: 0,
    sessionCount: 0,
    eventCount: 0,
    lowConfidenceEventCount: 0,
    models: [],
    modelTokenTotals: {},
    sessionIds: new Set<string>(),
    modelNames: new Set<string>(),
  };
}

function bucketForEvent(
  buckets: MutableBucket[],
  commits: CommitRecord[],
  event: UsageEvent,
  getPreFirstCommit: () => MutableBucket,
  getUncommittedTail: () => MutableBucket,
): MutableBucket {
  const eventTime = Date.parse(event.timestamp);
  const firstCommitTime = commits[0] === undefined ? undefined : Date.parse(commits[0].authoredAt);

  if (firstCommitTime !== undefined && eventTime < firstCommitTime) {
    return getPreFirstCommit();
  }

  return firstBucketAtOrAfterEvent(buckets, commits, event) ?? getUncommittedTail();
}
```

Return `preFirstCommit` in the final result.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- tests/attribution-engine.test.ts`

Expected: PASS.

### Task 2: Render Pre-First Bucket and Cache Columns

**Files:**
- Modify: `src/cli.ts`
- Modify: `src/comment-renderer.ts`
- Test: `tests/comment-renderer.test.ts`
- Test: `tests/cli.test.ts`

- [ ] **Step 1: Write failing renderer test**

Update `currentAuthor.rows[0]` in `tests/comment-renderer.test.ts` to include cache fields and add an assertion that the table header and row include cache columns:

```ts
expect(body).toContain('| Commit | Message | In | Out | Cache Write | Cache Read | Cost | Sessions |');
expect(body).toContain('| `aaa1111` | first commit | 1M | 100k | 5k | 12k | ~$2.30 | 1 |');
```

Add row properties where needed:

```ts
cacheWriteTokens: 5_000,
cacheReadTokens: 12_000,
```

- [ ] **Step 2: Write failing CLI row-order test**

Add a CLI/unit test or update an existing one so `toRenderAuthorInput` output includes rows in this order when present: `pre-first-commit work`, commit rows, `uncommitted tail`. If `toRenderAuthorInput` remains private, assert against dry-run markdown.

Expected markdown row:

```md
| `pre-fir` | pre-first-commit work | 100 | 10 | 0 | 50 | ~$1.00 | 1 |
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `npm test -- tests/comment-renderer.test.ts tests/cli.test.ts`

Expected: FAIL because rows do not expose cache fields and `allPricedBuckets` omits `preFirstCommit`.

- [ ] **Step 4: Write minimal implementation**

Update `RenderAuthorInput.rows` in `src/comment-renderer.ts`:

```ts
rows: Array<{
  sha: string;
  message: string;
  inputTokens: number;
  outputTokens: number;
  cacheWriteTokens: number;
  cacheReadTokens: number;
  costUsd: number;
  sessionCount: number;
}>;
```

Update the table header and row rendering:

```ts
'| Commit | Message | In | Out | Cache Write | Cache Read | Cost | Sessions |',
'| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |',
...author.rows.map(
  (row) =>
    `| \`${truncateSha(row.sha)}\` | ${escapeTableCell(row.message)} | ${formatTokens(row.inputTokens)} | ${formatTokens(
      row.outputTokens,
    )} | ${formatTokens(row.cacheWriteTokens)} | ${formatTokens(row.cacheReadTokens)} | ${formatCost(row.costUsd)} | ${row.sessionCount} |`,
),
```

Update `src/cli.ts` row mapping:

```ts
const rows = allPricedBuckets(priced).map((bucket) => ({
  sha: bucket.commitSha ?? bucket.label ?? 'uncommitted',
  message: bucket.message ?? bucket.label ?? '',
  inputTokens: bucket.inputTokens,
  outputTokens: bucket.outputTokens,
  cacheWriteTokens: bucket.cacheWriteTokens,
  cacheReadTokens: bucket.cacheReadTokens,
  costUsd: bucket.costUsd,
  sessionCount: bucket.sessionCount,
}));
```

Update `allPricedBuckets`:

```ts
function allPricedBuckets(priced: PricedAttributionResult): PricedAttributionBucket[] {
  return [
    ...(priced.preFirstCommit === undefined ? [] : [priced.preFirstCommit]),
    ...priced.buckets,
    ...(priced.uncommittedTail === undefined ? [] : [priced.uncommittedTail]),
  ];
}
```

Update `src/pricing.ts` so `PricedAttributionResult` includes `preFirstCommit`, and price it the same way as other buckets.

- [ ] **Step 5: Run tests to verify they pass**

Run: `npm test -- tests/comment-renderer.test.ts tests/cli.test.ts tests/attribution-engine.test.ts`

Expected: PASS.

### Task 3: Verify Real PR Output

**Files:**
- Build output: `dist/`

- [ ] **Step 1: Run full verification**

Run: `npm test`

Expected: PASS.

Run: `npm run typecheck`

Expected: PASS.

Run: `npm run build`

Expected: PASS.

- [ ] **Step 2: Run dry-run from the PR worktree**

Run from `/Users/samuelzhang/Documents/GitHub/tinker/.worktrees/generation-api-renderer-selection`:

```bash
npx prtokens --dry-run --verbose
```

Expected: the large bucket is labeled `pre-first-commit work`, `0f1ed82` no longer carries all prior usage, and cache columns make the cost easier to understand.

- [ ] **Step 3: Commit**

```bash
git add src tests dist docs/superpowers/plans/2026-06-13-pre-first-commit-attribution.md
git commit -m "fix: separate pre-first-commit usage"
```
