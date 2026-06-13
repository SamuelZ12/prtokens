import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { estimateUsageCost, priceAttributionResult } from '../src/pricing.js';
import type { AttributionResult, UsageEvent } from '../src/types.js';

const projectRoot = fileURLToPath(new URL('..', import.meta.url));

function usageEvent(overrides: Partial<UsageEvent> = {}): UsageEvent {
  return {
    id: 'event-1',
    agent: 'claude-code',
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

  it('prefers source-reported costs over token estimates', () => {
    const price = estimateUsageCost(usageEvent({ sourceCostUsd: 1.23 }));

    expect(price.costUsd).toBe(1.23);
    expect(price.label).toBe('source reported');
    expect(price.warning).toBeUndefined();
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

describe('OpenAI pricing coverage', () => {
  it.each(['gpt-5.4', 'gpt-5.5', 'gpt-5.4-fast', 'gpt-5.5-fast'])(
    'prices %s from the bundled snapshot',
    (model) => {
      const price = estimateUsageCost(
        usageEvent({
          model,
          inputTokens: 1_000_000,
          outputTokens: 1_000_000,
          cacheWriteTokens: 1_000_000,
          cacheReadTokens: 1_000_000,
        }),
      );

      expect(price.warning).toBeUndefined();
      expect(price.costUsd).toBeGreaterThan(0);
    },
  );

  it('does not charge OpenAI cache writes when LiteLLM omits a cache write rate', () => {
    const withCacheWrites = estimateUsageCost(
      usageEvent({ model: 'gpt-5.5', inputTokens: 0, outputTokens: 0, cacheWriteTokens: 1_000_000, cacheReadTokens: 0 }),
    );

    expect(withCacheWrites.warning).toBeUndefined();
    expect(withCacheWrites.costUsd).toBe(0);
  });

  it.each([
    ['gpt-5.4', 'gpt-5.4-fast', 2],
    ['gpt-5.5', 'gpt-5.5-fast', 2.5],
  ])('prices %s as Codex Fast mode at the documented multiplier', (baseModel, aliasModel, multiplier) => {
    const tokenBuckets = [
      { inputTokens: 1_000_000, outputTokens: 0, cacheWriteTokens: 0, cacheReadTokens: 0 },
      { inputTokens: 0, outputTokens: 1_000_000, cacheWriteTokens: 0, cacheReadTokens: 0 },
      { inputTokens: 0, outputTokens: 0, cacheWriteTokens: 1_000_000, cacheReadTokens: 0 },
      { inputTokens: 0, outputTokens: 0, cacheWriteTokens: 0, cacheReadTokens: 1_000_000 },
    ];

    for (const bucket of tokenBuckets) {
      const basePrice = estimateUsageCost(usageEvent({ model: baseModel, ...bucket }));
      const aliasPrice = estimateUsageCost(usageEvent({ model: aliasModel, ...bucket }));

      expect(basePrice.warning).toBeUndefined();
      expect(aliasPrice.warning).toBeUndefined();
      expect(aliasPrice.costUsd).toBe(basePrice.costUsd * multiplier);
    }
  });
});

describe('pricing snapshot updater', () => {
  it('derives OpenAI fast aliases from fetched base model rates', () => {
    const tempRoot = mkdtempSync(join(tmpdir(), 'prtokens-pricing-'));
    const tempScriptsDir = join(tempRoot, 'scripts');
    const tempPricingDir = join(tempRoot, 'src', 'pricing');
    mkdirSync(tempScriptsDir, { recursive: true });
    mkdirSync(tempPricingDir, { recursive: true });

    const scriptPath = join(tempScriptsDir, 'update-pricing-snapshot.mjs');
    const preloaderPath = join(tempRoot, 'mock-fetch.mjs');
    const snapshotPath = join(tempPricingDir, 'litellm-snapshot.json');

    copyFileSync(join(projectRoot, 'scripts', 'update-pricing-snapshot.mjs'), scriptPath);
    writeFileSync(
      preloaderPath,
      `globalThis.fetch = async () => ({
        ok: true,
        status: 200,
        statusText: 'OK',
        json: async () => ({
          'gpt-5.4': {
            input_cost_per_token: 0.000009,
            output_cost_per_token: 0.00008,
            cache_creation_input_token_cost: 0.000001,
            cache_read_input_token_cost: 0.0000009,
          },
          'gpt-5.5': {
            input_cost_per_token: 0.000011,
            output_cost_per_token: 0.00009,
            cache_read_input_token_cost: 0.0000011,
          },
        }),
      });\n`,
    );

    execFileSync(process.execPath, ['--import', preloaderPath, scriptPath], { cwd: tempRoot, stdio: 'pipe' });

    const snapshot = JSON.parse(readFileSync(snapshotPath, 'utf8')) as Record<string, unknown>;

    expect(snapshot['gpt-5.4-fast']).toEqual(snapshot['gpt-5.4']);
    expect(snapshot['gpt-5.5-fast']).toEqual(snapshot['gpt-5.5']);
    expect(snapshot['gpt-5.4-fast']).toEqual({
      inputUsdPerMillion: 9,
      outputUsdPerMillion: 80,
      cacheWriteUsdPerMillion: 1,
      cacheReadUsdPerMillion: 0.9,
    });
    expect(snapshot['gpt-5.5-fast']).toEqual({
      inputUsdPerMillion: 11,
      outputUsdPerMillion: 90,
      cacheWriteUsdPerMillion: 0,
      cacheReadUsdPerMillion: 1.1,
    });
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

  it('combines source-reported costs with token estimates for remaining usage', () => {
    const priced = priceAttributionResult(
      attributionResult({
        buckets: [
          bucket({
            inputTokens: 2_000_000,
            outputTokens: 200_000,
            cacheWriteTokens: 20_000,
            cacheReadTokens: 200_000,
            models: ['claude-sonnet-4-6'],
            sourceCostUsd: 9,
            sourceCostTokenTotals: {
              inputTokens: 1_000_000,
              outputTokens: 100_000,
              cacheWriteTokens: 10_000,
              cacheReadTokens: 100_000,
            },
          }),
        ],
      }),
    );

    expect(priced.buckets[0].costUsd).toBeCloseTo(13.5675, 10);
    expect(priced.buckets[0].warning).toBeUndefined();
    expect(priced.totalCostUsd).toBeCloseTo(13.5675, 10);
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
