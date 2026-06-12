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
  buckets: PricedAttributionBucket[];
  uncommittedTail?: PricedAttributionBucket;
  totalCostUsd: number;
  warnings?: string[];
};

const pricing = JSON.parse(
  readFileSync(new URL('./pricing/litellm-snapshot.json', import.meta.url), 'utf8'),
) as Record<string, PricingRates>;

export function estimateUsageCost(event: UsageEvent): UsageCostEstimate {
  return estimateTokenCost(event.model, event);
}

export function priceAttributionResult(result: AttributionResult): PricedAttributionResult {
  const buckets = result.buckets.map(priceBucket);
  const uncommittedTail = result.uncommittedTail === undefined ? undefined : priceBucket(result.uncommittedTail);
  const allPricedBuckets = uncommittedTail === undefined ? buckets : [...buckets, uncommittedTail];
  const warnings = allPricedBuckets.flatMap((bucket) => (bucket.warning === undefined ? [] : [bucket.warning]));

  return {
    ...result,
    buckets,
    uncommittedTail,
    totalCostUsd: allPricedBuckets.reduce((total, bucket) => total + bucket.costUsd, 0),
    ...(warnings.length > 0 ? { warnings } : {}),
  };
}

function priceBucket(bucket: AttributionBucket): PricedAttributionBucket {
  const pricingModel = [...bucket.models].sort()[0] ?? 'unknown-model';
  const estimate = estimateTokenCost(pricingModel, bucket);

  return {
    ...bucket,
    costUsd: estimate.costUsd,
    pricingModel,
    ...(estimate.warning === undefined ? {} : { warning: estimate.warning }),
  };
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

  return {
    costUsd:
      (tokens.inputTokens / 1_000_000) * rates.inputUsdPerMillion +
      (tokens.outputTokens / 1_000_000) * rates.outputUsdPerMillion +
      (tokens.cacheWriteTokens / 1_000_000) * rates.cacheWriteUsdPerMillion +
      (tokens.cacheReadTokens / 1_000_000) * rates.cacheReadUsdPerMillion,
    pricedTokens,
    label: 'estimated at API rates',
  };
}
