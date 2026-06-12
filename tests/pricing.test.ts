import { describe, expect, it } from 'vitest';
import { estimateUsageCost, priceAttributionResult } from '../src/pricing.js';
import type { AttributionResult, UsageEvent } from '../src/types.js';

function usageEvent(overrides: Partial<UsageEvent> = {}): UsageEvent {
  return {
    id: 'event-1',
    timestamp: '2026-06-12T09:30:00.000Z',
    model: 'claude-sonnet-4-6',
    inputTokens: 1_000_000,
    outputTokens: 100_000,
    cacheWriteTokens: 10_000,
    cacheReadTokens: 100_000,
    sessionId: 'session-1',
    ...overrides,
  };
}

describe('estimateUsageCost', () => {
  it('prices input, output, cache writes, and cache reads with distinct rates', () => {
    const price = estimateUsageCost(usageEvent());

    expect(price.costUsd).toBeGreaterThan(0);
    expect(price.pricedTokens).toEqual({
      inputTokens: 1_000_000,
      outputTokens: 100_000,
      cacheWriteTokens: 10_000,
      cacheReadTokens: 100_000,
    });
    expect(price.label).toBe('estimated at API rates');
  });

  it('counts unknown model tokens without a dollar cost', () => {
    const price = estimateUsageCost(usageEvent({ model: 'unknown-model' }));

    expect(price.costUsd).toBe(0);
    expect(price.pricedTokens).toEqual({
      inputTokens: 1_000_000,
      outputTokens: 100_000,
      cacheWriteTokens: 10_000,
      cacheReadTokens: 100_000,
    });
    expect(price.warning).toBe('No bundled pricing for unknown-model; counted tokens without dollar cost.');
  });
});

describe('priceAttributionResult', () => {
  it('adds per-bucket and total dollar estimates', () => {
    const result: AttributionResult = {
      branch: 'main',
      buckets: [
        {
          commitSha: 'aaa1111',
          patchId: 'patch-a',
          message: 'first',
          authorLogin: 'sam',
          inputTokens: 1_000_000,
          outputTokens: 100_000,
          cacheWriteTokens: 10_000,
          cacheReadTokens: 100_000,
          sessionCount: 1,
          eventCount: 1,
          lowConfidenceEventCount: 0,
          models: ['claude-sonnet-4-6'],
        },
      ],
      totals: {
        inputTokens: 1_000_000,
        outputTokens: 100_000,
        cacheWriteTokens: 10_000,
        cacheReadTokens: 100_000,
        sessionCount: 1,
        observedEventCount: 1,
        attributedEventCount: 1,
        lowConfidenceEventCount: 0,
      },
      coverage: {
        attributedPercent: 100,
        lowConfidencePercent: 0,
      },
    };

    const priced = priceAttributionResult(result);

    expect(priced.totalCostUsd).toBeGreaterThan(0);
    expect(priced.buckets[0].costUsd).toBe(priced.totalCostUsd);
  });
});
