import { readFileSync } from 'node:fs';
import type { AttributionBucket, AttributionResult, UsageEvent } from './types.js';

interface PricingRates {
  inputUsdPerMillion: number;
  outputUsdPerMillion: number;
  cacheWriteUsdPerMillion: number;
  cacheReadUsdPerMillion: number;
}

interface PriceableTokens {
  inputTokens: number;
  outputTokens: number;
  cacheWriteTokens: number;
  cacheReadTokens: number;
}

export interface UsageCostEstimate {
  costUsd: number;
  pricedTokens: PriceableTokens;
  label?: 'estimated at API rates';
  warning?: string;
}

export type PricedAttributionBucket = AttributionBucket & {
  costUsd: number;
  pricingModel: string;
  warning?: string;
};

export type PricedAttributionResult = AttributionResult & {
  preFirstCommit?: PricedAttributionBucket;
  buckets: PricedAttributionBucket[];
  uncommittedTail?: PricedAttributionBucket;
  totalCostUsd: number;
  warnings?: string[];
};

const pricing = loadPricing();

const codexFastModeMultipliers: Record<string, number> = {
  'gpt-5.4-fast': 2,
  'gpt-5.5-fast': 2.5,
};

export function estimateUsageCost(event: UsageEvent): UsageCostEstimate {
  return estimateTokenCost(event.model, event);
}

export function priceAttributionResult(result: AttributionResult): PricedAttributionResult {
  const preFirstCommit = result.preFirstCommit === undefined ? undefined : priceBucket(result.preFirstCommit);
  const buckets = result.buckets.map(priceBucket);
  const uncommittedTail = result.uncommittedTail === undefined ? undefined : priceBucket(result.uncommittedTail);
  const allPricedBuckets = [
    ...(preFirstCommit === undefined ? [] : [preFirstCommit]),
    ...buckets,
    ...(uncommittedTail === undefined ? [] : [uncommittedTail]),
  ];
  const warnings = [
    ...new Set(allPricedBuckets.flatMap((bucket) => (bucket.warning === undefined ? [] : [bucket.warning]))),
  ];

  return {
    ...result,
    preFirstCommit,
    buckets,
    uncommittedTail,
    totalCostUsd: allPricedBuckets.reduce((total, bucket) => total + bucket.costUsd, 0),
    ...(warnings.length > 0 ? { warnings } : {}),
  };
}

function priceBucket(bucket: AttributionBucket): PricedAttributionBucket {
  const sortedModels = [...bucket.models].sort();
  const pricingModel = sortedModels[0] ?? '';

  if (isZeroTokens(bucket)) {
    return {
      ...bucket,
      costUsd: 0,
      pricingModel,
    };
  }

  if (sortedModels.length > 1) {
    const perModelEstimate = estimateModelTokenTotals(bucket, sortedModels);
    if (perModelEstimate !== undefined) {
      return {
        ...bucket,
        costUsd: perModelEstimate.costUsd,
        pricingModel,
        ...(perModelEstimate.warning === undefined ? {} : { warning: perModelEstimate.warning }),
      };
    }

    return {
      ...bucket,
      costUsd: 0,
      pricingModel,
      warning: `Cannot price mixed-model bucket (${sortedModels.join(', ')}) without per-model token totals.`,
    };
  }

  const estimate = estimateTokenCost(pricingModel, bucket);

  return {
    ...bucket,
    costUsd: estimate.costUsd,
    pricingModel,
    ...(estimate.warning === undefined ? {} : { warning: estimate.warning }),
  };
}

function estimateModelTokenTotals(
  bucket: AttributionBucket,
  sortedModels: string[],
): { costUsd: number; warning?: string } | undefined {
  if (bucket.modelTokenTotals === undefined || sortedModels.some((model) => bucket.modelTokenTotals?.[model] === undefined)) {
    return undefined;
  }

  const estimates = sortedModels.map((model) => estimateTokenCost(model, bucket.modelTokenTotals![model]));
  const warnings = [...new Set(estimates.flatMap((estimate) => (estimate.warning === undefined ? [] : [estimate.warning])))];

  return {
    costUsd: estimates.reduce((total, estimate) => total + estimate.costUsd, 0),
    ...(warnings.length > 0 ? { warning: warnings.join(' ') } : {}),
  };
}

function isZeroTokens(tokens: PriceableTokens): boolean {
  return (
    tokens.inputTokens === 0 &&
    tokens.outputTokens === 0 &&
    tokens.cacheWriteTokens === 0 &&
    tokens.cacheReadTokens === 0
  );
}

function loadPricing(): Record<string, PricingRates> {
  const parsed = JSON.parse(readFileSync(new URL('./pricing/litellm-snapshot.json', import.meta.url), 'utf8')) as unknown;

  if (!isRecord(parsed)) {
    throw new Error('Invalid bundled pricing snapshot.');
  }

  const validated: Record<string, PricingRates> = {};

  for (const [model, rates] of Object.entries(parsed)) {
    if (!isPricingRates(rates)) {
      throw new Error(`Invalid bundled pricing for ${model}.`);
    }

    validated[model] = rates;
  }

  return validated;
}

function isPricingRates(value: unknown): value is PricingRates {
  return (
    isRecord(value) &&
    Number.isFinite(value.inputUsdPerMillion) &&
    Number.isFinite(value.outputUsdPerMillion) &&
    Number.isFinite(value.cacheWriteUsdPerMillion) &&
    Number.isFinite(value.cacheReadUsdPerMillion)
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function estimateTokenCost(model: string, tokens: PriceableTokens): UsageCostEstimate {
  const pricedTokens = {
    inputTokens: tokens.inputTokens,
    outputTokens: tokens.outputTokens,
    cacheWriteTokens: tokens.cacheWriteTokens,
    cacheReadTokens: tokens.cacheReadTokens,
  };
  const rates = pricing[model];

  if (rates === undefined) {
    return {
      costUsd: 0,
      pricedTokens,
      warning: `No bundled pricing for ${model}; counted tokens without dollar cost.`,
    };
  }

  const multiplier = codexFastModeMultipliers[model] ?? 1;
  const baseCostUsd =
    (tokens.inputTokens / 1_000_000) * rates.inputUsdPerMillion +
    (tokens.outputTokens / 1_000_000) * rates.outputUsdPerMillion +
    (tokens.cacheWriteTokens / 1_000_000) * rates.cacheWriteUsdPerMillion +
    (tokens.cacheReadTokens / 1_000_000) * rates.cacheReadUsdPerMillion;

  return {
    costUsd: baseCostUsd * multiplier,
    pricedTokens,
    label: 'estimated at API rates',
  };
}
