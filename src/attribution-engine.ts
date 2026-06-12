import type { AttributionBucket, AttributionResult, CommitRecord, ModelTokenTotals, UsageEvent } from './types.js';

export interface AttributeUsageInput {
  events: UsageEvent[];
  commits: CommitRecord[];
  branch: string;
}

type MutableBucket = AttributionBucket & {
  modelTokenTotals: ModelTokenTotals;
  sessionIds: Set<string>;
  modelNames: Set<string>;
};

export function attributeUsageToCommits(input: AttributeUsageInput): AttributionResult {
  const commits = [...input.commits].sort((left, right) => Date.parse(left.authoredAt) - Date.parse(right.authoredAt));
  const buckets = commits.map((commit) => createCommitBucket(commit));
  let uncommittedTail: MutableBucket | undefined;

  for (const event of input.events) {
    const lowConfidence = event.gitBranch === undefined;

    if (!lowConfidence && event.gitBranch !== input.branch) {
      continue;
    }

    const bucket = firstBucketAtOrAfterEvent(buckets, commits, event) ?? (uncommittedTail ??= createTailBucket());
    addEventToBucket(bucket, event, lowConfidence);
  }

  const allBuckets = uncommittedTail === undefined ? buckets : [...buckets, uncommittedTail];
  const totalSessionIds = new Set<string>();

  const totals = allBuckets.reduce(
    (total, bucket) => {
      total.inputTokens += bucket.inputTokens;
      total.outputTokens += bucket.outputTokens;
      total.cacheWriteTokens += bucket.cacheWriteTokens;
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
    buckets: buckets.map(stripInternalSets),
    uncommittedTail: uncommittedTail === undefined ? undefined : stripInternalSets(uncommittedTail),
    totals,
    coverage: {
      attributedPercent: percent(totals.attributedEventCount, totals.observedEventCount),
      lowConfidencePercent: percent(totals.lowConfidenceEventCount, totals.observedEventCount),
    },
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

function addEventToBucket(bucket: MutableBucket, event: UsageEvent, lowConfidence: boolean): void {
  bucket.inputTokens += event.inputTokens;
  bucket.outputTokens += event.outputTokens;
  bucket.cacheWriteTokens += event.cacheWriteTokens;
  bucket.cacheReadTokens += event.cacheReadTokens;
  bucket.eventCount += 1;
  bucket.lowConfidenceEventCount += lowConfidence ? 1 : 0;
  bucket.sessionIds.add(event.sessionId);
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
  modelTotals.cacheReadTokens += event.cacheReadTokens;

  if (!bucket.modelNames.has(event.model)) {
    bucket.modelNames.add(event.model);
    bucket.models.push(event.model);
  }
}

function stripInternalSets(bucket: MutableBucket): AttributionBucket {
  const { sessionIds: _sessionIds, modelNames: _modelNames, ...publicBucket } = bucket;

  return publicBucket;
}

function percent(count: number, total: number): number {
  return total === 0 ? 0 : Math.round((count / total) * 100);
}
