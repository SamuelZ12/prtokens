import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { estimateUsageCost, priceAttributionResult } from '../src/pricing.js';
import type { AttributionResult, UsageEvent } from '../src/types.js';

const projectRoot = fileURLToPath(new URL('..', import.meta.url));

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

    expect(price.costUsd).toBeCloseTo(4.5675, 10);
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

describe('bundled pricing coverage', () => {
  it.each([
    ['claude-fable-5', 10],
    ['claude-opus-4-8', 5],
    ['claude-opus-4-7', 5],
    ['claude-sonnet-4-6', 3],
    ['claude-haiku-4-5', 1],
    ['claude-haiku-4-5-20251001', 1],
  ])('prices %s input at $%d per million tokens', (model, usdPerMillion) => {
    const price = estimateUsageCost(
      usageEvent({ model, inputTokens: 1_000_000, outputTokens: 0, cacheWriteTokens: 0, cacheReadTokens: 0 }),
    );

    expect(price.warning).toBeUndefined();
    expect(price.costUsd).toBe(usdPerMillion);
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

  it('prices zero-token empty buckets at zero without warnings', () => {
    const priced = priceAttributionResult(
      attributionResult({
        buckets: [bucket({ models: [] })],
      }),
    );

    expect(priced.buckets[0].costUsd).toBe(0);
    expect(priced.buckets[0].warning).toBeUndefined();
    expect(priced.warnings).toBeUndefined();
    expect(priced.totalCostUsd).toBe(0);
  });

  it('does not price nonzero mixed-model buckets without per-model token totals', () => {
    const priced = priceAttributionResult(
      attributionResult({
        buckets: [
          bucket({
            inputTokens: 1_000_000,
            models: ['claude-sonnet-4-6', 'claude-opus-4-8'],
          }),
        ],
      }),
    );

    const warning =
      'Cannot price mixed-model bucket (claude-opus-4-8, claude-sonnet-4-6) without per-model token totals.';

    expect(priced.buckets[0].costUsd).toBe(0);
    expect(priced.buckets[0].warning).toBe(warning);
    expect(priced.warnings).toEqual([warning]);
    expect(priced.totalCostUsd).toBe(0);
  });

  it('prices mixed-model buckets from per-model token totals', () => {
    const priced = priceAttributionResult(
      attributionResult({
        buckets: [
          bucket({
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
          }),
        ],
      }),
    );

    expect(priced.buckets[0].costUsd).toBeCloseTo(12.18, 10);
    expect(priced.buckets[0].warning).toBeUndefined();
    expect(priced.warnings).toBeUndefined();
    expect(priced.totalCostUsd).toBeCloseTo(12.18, 10);
  });

  it('deduplicates aggregate warnings', () => {
    const priced = priceAttributionResult(
      attributionResult({
        buckets: [
          bucket({ inputTokens: 1, models: ['unknown-model'] }),
          bucket({ inputTokens: 2, models: ['unknown-model'] }),
        ],
      }),
    );

    expect(priced.warnings).toEqual(['No bundled pricing for unknown-model; counted tokens without dollar cost.']);
  });
});

describe('built pricing module', () => {
  it('can be loaded after build', () => {
    execFileSync('npm', ['run', 'build'], { cwd: projectRoot, stdio: 'pipe' });

    expect(() => {
      execFileSync(process.execPath, ['-e', "import('./dist/pricing.js')"], { cwd: projectRoot, stdio: 'pipe' });
    }).not.toThrow();
  });
});

function attributionResult(overrides: Partial<AttributionResult> = {}): AttributionResult {
  return {
    branch: 'main',
    buckets: [],
    totals: {
      inputTokens: 0,
      outputTokens: 0,
      cacheWriteTokens: 0,
      cacheReadTokens: 0,
      sessionCount: 0,
      observedEventCount: 0,
      attributedEventCount: 0,
      lowConfidenceEventCount: 0,
    },
    coverage: {
      attributedPercent: 0,
      lowConfidencePercent: 0,
    },
    ...overrides,
  };
}

function bucket(overrides: Partial<AttributionResult['buckets'][number]> = {}): AttributionResult['buckets'][number] {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheWriteTokens: 0,
    cacheReadTokens: 0,
    sessionCount: 0,
    eventCount: 0,
    lowConfidenceEventCount: 0,
    models: ['claude-sonnet-4-6'],
    ...overrides,
  };
}
