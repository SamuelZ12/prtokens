export interface UsageEvent {
  id: string;
  timestamp: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheWriteTokens: number;
  cacheReadTokens: number;
  sessionId: string;
  gitBranch?: string;
}

export interface CommitRecord {
  sha: string;
  patchId: string;
  message: string;
  authorLogin: string;
  authoredAt: string;
}

export interface TokenTotals {
  inputTokens: number;
  outputTokens: number;
  cacheWriteTokens: number;
  cacheReadTokens: number;
  sessionCount: number;
}

export interface AttributionBucket extends TokenTotals {
  commitSha?: string;
  patchId?: string;
  message?: string;
  authorLogin?: string;
  label?: 'uncommitted tail';
  eventCount: number;
  lowConfidenceEventCount: number;
  models: string[];
}

export interface AttributionResult {
  branch: string;
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
