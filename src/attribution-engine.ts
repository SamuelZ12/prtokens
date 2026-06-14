import type { AttributionBucket, AttributionResult, CommitRecord, ModelTokenTotals, UsageEvent } from './types.js';

export interface AttributeUsageInput {
  events: UsageEvent[];
  commits: CommitRecord[];
  branch: string;
  firstCommitAttributionStart?: string;
}

type MutableBucket = AttributionBucket & {
  modelTokenTotals: ModelTokenTotals;
  sessionIds: Set<string>;
  modelNames: Set<string>;
};

export function attributeUsageToCommits(input: AttributeUsageInput): AttributionResult {
  const commits = [...input.commits].sort((left, right) => Date.parse(left.authoredAt) - Date.parse(right.authoredAt));
  const buckets = commits.map((commit) => createCommitBucket(commit));
  let preFirstCommit: MutableBucket | undefined;
  let uncommittedTail: MutableBucket | undefined;

  for (const event of input.events) {
    const lowConfidence = event.gitBranch === undefined;

    if (!lowConfidence && event.gitBranch !== input.branch) {
      continue;
    }

    const bucket = bucketForEvent(
      buckets,
      commits,
      event,
      lowConfidence,
      input.firstCommitAttributionStart,
      () => (preFirstCommit ??= createPreFirstCommitBucket()),
      () => (uncommittedTail ??= createTailBucket()),
    );
    addEventToBucket(bucket, event, lowConfidence);
  }

  const allBuckets = buckets;
  const totalSessionIds = new Set<string>();

  const totals = allBuckets.reduce<AttributionResult['totals']>(
    (total, bucket) => {
      total.inputTokens += bucket.inputTokens;
      total.outputTokens += bucket.outputTokens;
      total.cacheWriteTokens += bucket.cacheWriteTokens;
      addCacheDurationTokens(total, bucket);
      total.cacheReadTokens += bucket.cacheReadTokens;
      total.attributedEventCount += bucket.eventCount;
      total.lowConfidenceEventCount += bucket.lowConfidenceEventCount;

      for (const sessionId of bucket.sessionIds) {
        totalSessionIds.add(sessionId);
      }

      return total;
    },
    {
      inputTokens: 0,
      outputTokens: 0,
      cacheWriteTokens: 0,
      cacheReadTokens: 0,
      sessionCount: 0,
      observedEventCount: input.events.length,
      attributedEventCount: 0,
      lowConfidenceEventCount: 0,
    },
  );

  totals.sessionCount = totalSessionIds.size;

  return {
    branch: input.branch,
    preFirstCommit: preFirstCommit === undefined ? undefined : stripInternalSets(preFirstCommit),
    buckets: buckets.map(stripInternalSets),
    uncommittedTail: uncommittedTail === undefined ? undefined : stripInternalSets(uncommittedTail),
    totals,
    coverage: {
      attributedPercent: percent(totals.attributedEventCount, totals.observedEventCount),
      lowConfidencePercent: percent(totals.lowConfidenceEventCount, totals.observedEventCount),
    },
  };
}

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

function createCommitBucket(commit: CommitRecord): MutableBucket {
  return {
    commitSha: commit.sha,
    patchId: commit.patchId,
    message: commit.message,
    authorLogin: commit.authorLogin,
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

function createTailBucket(): MutableBucket {
  return {
    label: 'uncommitted tail',
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

function firstBucketAtOrAfterEvent(
  buckets: MutableBucket[],
  commits: CommitRecord[],
  event: UsageEvent,
): MutableBucket | undefined {
  const eventTime = Date.parse(event.timestamp);
  const index = commits.findIndex((commit) => Date.parse(commit.authoredAt) >= eventTime);

  return index === -1 ? undefined : buckets[index];
}

function bucketForEvent(
  buckets: MutableBucket[],
  commits: CommitRecord[],
  event: UsageEvent,
  lowConfidence: boolean,
  firstCommitAttributionStart: string | undefined,
  getPreFirstCommit: () => MutableBucket,
  getUncommittedTail: () => MutableBucket,
): MutableBucket {
  const eventTime = Date.parse(event.timestamp);
  const firstCommitTime = commits[0] === undefined ? undefined : Date.parse(commits[0].authoredAt);

  if (firstCommitTime !== undefined && eventTime < firstCommitTime) {
    if (!lowConfidence && buckets[0] !== undefined) {
      return buckets[0];
    }

    const attributionStartTime = firstCommitAttributionStart === undefined ? undefined : Date.parse(firstCommitAttributionStart);
    if (buckets[0] !== undefined && attributionStartTime !== undefined && eventTime >= attributionStartTime) {
      return buckets[0];
    }

    return getPreFirstCommit();
  }

  return firstBucketAtOrAfterEvent(buckets, commits, event) ?? getUncommittedTail();
}

function addEventToBucket(bucket: MutableBucket, event: UsageEvent, lowConfidence: boolean): void {
  bucket.inputTokens += event.inputTokens;
  bucket.outputTokens += event.outputTokens;
  bucket.cacheWriteTokens += event.cacheWriteTokens;
  addCacheDurationTokens(bucket, event);
  bucket.cacheReadTokens += event.cacheReadTokens;
  bucket.eventCount += 1;
  bucket.lowConfidenceEventCount += lowConfidence ? 1 : 0;
  bucket.sessionIds.add(`${event.agent}:${event.sessionId}`);
  bucket.sessionCount = bucket.sessionIds.size;
  const modelTotals = (bucket.modelTokenTotals[event.model] ??= {
    inputTokens: 0,
    outputTokens: 0,
    cacheWriteTokens: 0,
    cacheReadTokens: 0,
  });
  modelTotals.inputTokens += event.inputTokens;
  modelTotals.outputTokens += event.outputTokens;
  modelTotals.cacheWriteTokens += event.cacheWriteTokens;
  addCacheDurationTokens(modelTotals, event);
  modelTotals.cacheReadTokens += event.cacheReadTokens;

  if (event.sourceCostUsd !== undefined) {
    bucket.sourceCostUsd = (bucket.sourceCostUsd ?? 0) + event.sourceCostUsd;
    const sourceTotals = (bucket.sourceCostTokenTotals ??= {
      inputTokens: 0,
      outputTokens: 0,
      cacheWriteTokens: 0,
      cacheReadTokens: 0,
    });
    sourceTotals.inputTokens += event.inputTokens;
    sourceTotals.outputTokens += event.outputTokens;
    sourceTotals.cacheWriteTokens += event.cacheWriteTokens;
    addCacheDurationTokens(sourceTotals, event);
    sourceTotals.cacheReadTokens += event.cacheReadTokens;

    const sourceModelTotals = (bucket.sourceCostModelTokenTotals ??= {});
    const sourceModelTotal = (sourceModelTotals[event.model] ??= {
      inputTokens: 0,
      outputTokens: 0,
      cacheWriteTokens: 0,
      cacheReadTokens: 0,
    });
    sourceModelTotal.inputTokens += event.inputTokens;
    sourceModelTotal.outputTokens += event.outputTokens;
    sourceModelTotal.cacheWriteTokens += event.cacheWriteTokens;
    addCacheDurationTokens(sourceModelTotal, event);
    sourceModelTotal.cacheReadTokens += event.cacheReadTokens;
  }

  if (!bucket.modelNames.has(event.model)) {
    bucket.modelNames.add(event.model);
    bucket.models.push(event.model);
  }
}

function addCacheDurationTokens(
  total: Pick<AttributionBucket, 'cacheWrite5mTokens' | 'cacheWrite1hTokens'>,
  event: Pick<UsageEvent, 'cacheWrite5mTokens' | 'cacheWrite1hTokens'>,
): void {
  if (event.cacheWrite5mTokens !== undefined) {
    total.cacheWrite5mTokens = (total.cacheWrite5mTokens ?? 0) + event.cacheWrite5mTokens;
  }
  if (event.cacheWrite1hTokens !== undefined) {
    total.cacheWrite1hTokens = (total.cacheWrite1hTokens ?? 0) + event.cacheWrite1hTokens;
  }
}

function stripInternalSets(bucket: MutableBucket): AttributionBucket {
  const { sessionIds: _sessionIds, modelNames: _modelNames, ...publicBucket } = bucket;

  return publicBucket;
}

function percent(count: number, total: number): number {
  return total === 0 ? 0 : Math.round((count / total) * 100);
}
