export type AgentName = 'claude-code' | 'codex' | 'opencode';

export interface UsageEvent {
  id: string;
  agent: AgentName;
  timestamp: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheWriteTokens: number;
  cacheWrite5mTokens?: number;
  cacheWrite1hTokens?: number;
  cacheReadTokens: number;
  sessionId: string;
  sourceCostUsd?: number;
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
  cacheWrite5mTokens?: number;
  cacheWrite1hTokens?: number;
  cacheReadTokens: number;
  sessionCount: number;
}

export type ModelTokenTotals = Record<string, Omit<TokenTotals, 'sessionCount'>>;

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
  sourceCostUsd?: number;
  sourceCostTokenTotals?: Omit<TokenTotals, 'sessionCount'>;
  sourceCostModelTokenTotals?: ModelTokenTotals;
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
