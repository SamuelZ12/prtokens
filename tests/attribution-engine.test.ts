import { describe, expect, it } from 'vitest';
import { attributeUsageToCommits } from '../src/attribution-engine.js';
import type { CommitRecord, UsageEvent } from '../src/types.js';

const commits: CommitRecord[] = [
  {
    sha: 'aaa1111',
    patchId: 'patch-a',
    message: 'first',
    authorLogin: 'sam',
    authoredAt: '2026-06-12T10:00:00.000Z',
  },
  {
    sha: 'bbb2222',
    patchId: 'patch-b',
    message: 'second',
    authorLogin: 'sam',
    authoredAt: '2026-06-12T11:00:00.000Z',
  },
];

function usageEvent(overrides: Partial<UsageEvent> = {}): UsageEvent {
  return {
    id: 'event-1',
    agent: 'claude-code',
    timestamp: '2026-06-12T09:30:00.000Z',
    model: 'claude-sonnet-4-6',
    inputTokens: 100,
    outputTokens: 10,
    cacheWriteTokens: 0,
    cacheReadTokens: 0,
    sessionId: 'session-1',
    ...overrides,
  };
}

describe('attributeUsageToCommits', () => {
  it('attributes work before a commit to the first PR commit at or after event time', () => {
    const result = attributeUsageToCommits({
      branch: 'main',
      commits,
      events: [
        usageEvent({
          gitBranch: 'main',
          timestamp: '2026-06-12T10:30:00.000Z',
        }),
      ],
    });

    expect(result.buckets[0]).toMatchObject({ commitSha: 'aaa1111', eventCount: 0, inputTokens: 0 });
    expect(result.buckets[1]).toMatchObject({
      commitSha: 'bbb2222',
      patchId: 'patch-b',
      message: 'second',
      authorLogin: 'sam',
      inputTokens: 100,
      outputTokens: 10,
      eventCount: 1,
      lowConfidenceEventCount: 0,
      sessionCount: 1,
      models: ['claude-sonnet-4-6'],
    });
  });

  it('puts usage after the last commit in a visible uncommitted tail bucket', () => {
    const result = attributeUsageToCommits({
      branch: 'main',
      commits,
      events: [
        usageEvent({
          gitBranch: 'main',
          timestamp: '2026-06-12T11:30:00.000Z',
        }),
      ],
    });

    expect(result.uncommittedTail).toMatchObject({
      label: 'uncommitted tail',
      inputTokens: 100,
      outputTokens: 10,
      eventCount: 1,
    });
    expect(result.buckets.map((bucket) => bucket.commitSha)).toEqual(['aaa1111', 'bbb2222']);
  });

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

  it('sorts commits by authored time without mutating caller input', () => {
    const unsortedCommits = [commits[1], commits[0]];

    const result = attributeUsageToCommits({
      branch: 'main',
      commits: unsortedCommits,
      events: [
        usageEvent({
          gitBranch: 'main',
          timestamp: '2026-06-12T10:30:00.000Z',
        }),
      ],
    });

    expect(result.buckets.map((bucket) => bucket.commitSha)).toEqual(['aaa1111', 'bbb2222']);
    expect(result.buckets[1]).toMatchObject({ commitSha: 'bbb2222', eventCount: 1, inputTokens: 100 });
    expect(unsortedCommits.map((commit) => commit.sha)).toEqual(['bbb2222', 'aaa1111']);
  });

  it('splits branch-hopping sessions by event branch while observing the full event count', () => {
    const result = attributeUsageToCommits({
      branch: 'main',
      commits,
      events: [
        usageEvent({
          id: 'event-main',
          gitBranch: 'main',
          timestamp: '2026-06-12T10:30:00.000Z',
        }),
        usageEvent({
          id: 'event-feature',
          gitBranch: 'feature',
          timestamp: '2026-06-12T10:30:00.000Z',
          inputTokens: 900,
          outputTokens: 90,
        }),
      ],
    });

    expect(result.totals.observedEventCount).toBe(2);
    expect(result.totals.attributedEventCount).toBe(1);
    expect(result.coverage.attributedPercent).toBe(50);
    expect(result.buckets[1]).toMatchObject({ inputTokens: 100, outputTokens: 10, eventCount: 1 });
  });

  it('attributes missing branch by timestamp and marks it low-confidence', () => {
    const result = attributeUsageToCommits({
      branch: 'main',
      commits,
      events: [usageEvent({ timestamp: '2026-06-12T10:30:00.000Z' })],
    });

    expect(result.buckets[1]).toMatchObject({
      commitSha: 'bbb2222',
      eventCount: 1,
      lowConfidenceEventCount: 1,
      inputTokens: 100,
    });
    expect(result.totals.lowConfidenceEventCount).toBe(1);
    expect(result.coverage.lowConfidencePercent).toBe(100);
  });

  it('keeps commits with no attributable usage as zero rows', () => {
    const result = attributeUsageToCommits({
      branch: 'main',
      commits,
      events: [],
    });

    expect(result.buckets).toHaveLength(2);
    expect(result.buckets).toEqual([
      expect.objectContaining({ commitSha: 'aaa1111', eventCount: 0, inputTokens: 0, outputTokens: 0 }),
      expect.objectContaining({ commitSha: 'bbb2222', eventCount: 0, inputTokens: 0, outputTokens: 0 }),
    ]);
  });

  it('preserves per-model token totals for mixed-model buckets', () => {
    const result = attributeUsageToCommits({
      branch: 'main',
      commits,
      events: [
        usageEvent({
          id: 'sonnet-event',
          gitBranch: 'main',
          timestamp: '2026-06-12T10:30:00.000Z',
          model: 'claude-sonnet-4-6',
          inputTokens: 1_000_000,
          outputTokens: 100_000,
          cacheWriteTokens: 10_000,
          cacheReadTokens: 100_000,
        }),
        usageEvent({
          id: 'opus-event',
          gitBranch: 'main',
          timestamp: '2026-06-12T10:35:00.000Z',
          model: 'claude-opus-4-8',
          inputTokens: 1_000_000,
          outputTokens: 100_000,
          cacheWriteTokens: 10_000,
          cacheReadTokens: 100_000,
        }),
      ],
    });

    expect(result.buckets[1]).toMatchObject({
      inputTokens: 2_000_000,
      outputTokens: 200_000,
      cacheWriteTokens: 20_000,
      cacheReadTokens: 200_000,
      models: ['claude-sonnet-4-6', 'claude-opus-4-8'],
      modelTokenTotals: {
        'claude-sonnet-4-6': {
          inputTokens: 1_000_000,
          outputTokens: 100_000,
          cacheWriteTokens: 10_000,
          cacheReadTokens: 100_000,
        },
        'claude-opus-4-8': {
          inputTokens: 1_000_000,
          outputTokens: 100_000,
          cacheWriteTokens: 10_000,
          cacheReadTokens: 100_000,
        },
      },
    });
  });

  it('aggregates source-reported costs and covered tokens into buckets', () => {
    const result = attributeUsageToCommits({
      branch: 'main',
      commits,
      events: [
        usageEvent({
          id: 'priced-event',
          gitBranch: 'main',
          timestamp: '2026-06-12T10:30:00.000Z',
          sourceCostUsd: 1.5,
        }),
      ],
    });

    expect(result.buckets[1]).toMatchObject({
      sourceCostUsd: 1.5,
      sourceCostTokenTotals: {
        inputTokens: 100,
        outputTokens: 10,
        cacheWriteTokens: 0,
        cacheReadTokens: 0,
      },
      sourceCostModelTokenTotals: {
        'claude-sonnet-4-6': {
          inputTokens: 100,
          outputTokens: 10,
          cacheWriteTokens: 0,
          cacheReadTokens: 0,
        },
      },
    });
  });

  it('preserves cache creation duration totals for pricing aggregates', () => {
    const result = attributeUsageToCommits({
      branch: 'main',
      commits,
      events: [
        usageEvent({
          id: 'source-priced-event',
          gitBranch: 'main',
          timestamp: '2026-06-12T10:30:00.000Z',
          model: 'claude-sonnet-4-6',
          cacheWriteTokens: 12,
          cacheWrite5mTokens: 5,
          cacheWrite1hTokens: 7,
          sourceCostUsd: 1.5,
        }),
        usageEvent({
          id: 'estimated-event',
          gitBranch: 'main',
          timestamp: '2026-06-12T10:35:00.000Z',
          model: 'claude-sonnet-4-6',
          cacheWriteTokens: 6,
          cacheWrite5mTokens: 2,
          cacheWrite1hTokens: 4,
        }),
      ],
    });

    expect(result.buckets[1]).toMatchObject({
      cacheWriteTokens: 18,
      cacheWrite5mTokens: 7,
      cacheWrite1hTokens: 11,
      modelTokenTotals: {
        'claude-sonnet-4-6': {
          cacheWriteTokens: 18,
          cacheWrite5mTokens: 7,
          cacheWrite1hTokens: 11,
        },
      },
      sourceCostTokenTotals: {
        cacheWriteTokens: 12,
        cacheWrite5mTokens: 5,
        cacheWrite1hTokens: 7,
      },
      sourceCostModelTokenTotals: {
        'claude-sonnet-4-6': {
          cacheWriteTokens: 12,
          cacheWrite5mTokens: 5,
          cacheWrite1hTokens: 7,
        },
      },
    });
    expect(result.totals.cacheWrite5mTokens).toBe(7);
    expect(result.totals.cacheWrite1hTokens).toBe(11);
  });

  it('counts same raw session id from different agents as separate sessions', () => {
    const result = attributeUsageToCommits({
      branch: 'main',
      commits,
      events: [
        usageEvent({
          id: 'claude-event',
          agent: 'claude-code',
          gitBranch: 'main',
          timestamp: '2026-06-12T10:30:00.000Z',
          sessionId: 'shared-session',
        }),
        usageEvent({
          id: 'codex-event',
          agent: 'codex',
          gitBranch: 'main',
          timestamp: '2026-06-12T10:35:00.000Z',
          sessionId: 'shared-session',
        }),
      ],
    });

    expect(result.buckets[1]).toMatchObject({ eventCount: 2, sessionCount: 2 });
    expect(result.totals.sessionCount).toBe(2);
  });
});
