import { readFileSync } from 'node:fs';
import type { AttributionBucket, AttributionResult, ModelTokenTotals, UsageEvent } from './types.js';

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
  cacheWrite5mTokens?: number;
  cacheWrite1hTokens?: number;
  cacheReadTokens: number;
}

export interface UsageCostEstimate {
  costUsd: number;
  pricedTokens: PriceableTokens;
  label?: 'estimated at API rates' | 'source reported';
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
  if (event.sourceCostUsd !== undefined) {
    return {
      costUsd: event.sourceCostUsd,
      pricedTokens: priceableTokens(event),
      label: 'source reported',
    };
  }

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

  if (bucket.sourceCostUsd !== undefined) {
    if (bucket.sourceCostTokenTotals === undefined) {
      return {
        ...bucket,
        costUsd: bucket.sourceCostUsd,
        pricingModel,
        warning: 'Cannot estimate remaining tokens for source-priced bucket without source token totals.',
      };
    }

    const remainingTokens = subtractTokens(bucket, bucket.sourceCostTokenTotals);
    if (isZeroTokens(remainingTokens)) {
      return {
        ...bucket,
        costUsd: bucket.sourceCostUsd,
        pricingModel,
      };
    }

    const estimate = estimateBucketTokenCost(
      sortedModels,
      remainingTokens,
      subtractModelTokenTotals(bucket.modelTokenTotals, bucket.sourceCostModelTokenTotals),
    );

    return {
      ...bucket,
      costUsd: bucket.sourceCostUsd + estimate.costUsd,
      pricingModel,
      ...(estimate.warning === undefined ? {} : { warning: estimate.warning }),
    };
  }

  const estimate = estimateBucketTokenCost(sortedModels, bucket, bucket.modelTokenTotals);

  return {
    ...bucket,
    costUsd: estimate.costUsd,
    pricingModel,
    ...(estimate.warning === undefined ? {} : { warning: estimate.warning }),
  };
}

function estimateBucketTokenCost(
  sortedModels: string[],
  tokens: PriceableTokens,
  modelTokenTotals: ModelTokenTotals | undefined,
): { costUsd: number; warning?: string } {
  const pricingModel = sortedModels[0] ?? '';

  if (sortedModels.length <= 1) {
    return estimateTokenCost(pricingModel, tokens);
  }

  const perModelEstimate = estimateModelTokenTotals(modelTokenTotals, sortedModels);
  if (perModelEstimate !== undefined) {
    return perModelEstimate;
  }

  return {
    costUsd: 0,
    warning: `Cannot price mixed-model bucket (${sortedModels.join(', ')}) without per-model token totals.`,
  };
}

function estimateModelTokenTotals(
  modelTokenTotals: ModelTokenTotals | undefined,
  sortedModels: string[],
): { costUsd: number; warning?: string } | undefined {
  if (modelTokenTotals === undefined || sortedModels.some((model) => modelTokenTotals[model] === undefined)) {
    return undefined;
  }

  const estimates = sortedModels
    .map((model) => ({ model, tokens: modelTokenTotals[model] }))
    .filter(({ tokens }) => !isZeroTokens(tokens))
    .map(({ model, tokens }) => estimateTokenCost(model, tokens));
  const warnings = [...new Set(estimates.flatMap((estimate) => (estimate.warning === undefined ? [] : [estimate.warning])))];

  return {
    costUsd: estimates.reduce((total, estimate) => total + estimate.costUsd, 0),
    ...(warnings.length > 0 ? { warning: warnings.join(' ') } : {}),
  };
}

function priceableTokens(tokens: PriceableTokens): PriceableTokens {
  return {
    inputTokens: tokens.inputTokens,
    outputTokens: tokens.outputTokens,
    cacheWriteTokens: tokens.cacheWriteTokens,
    ...(tokens.cacheWrite5mTokens === undefined ? {} : { cacheWrite5mTokens: tokens.cacheWrite5mTokens }),
    ...(tokens.cacheWrite1hTokens === undefined ? {} : { cacheWrite1hTokens: tokens.cacheWrite1hTokens }),
    cacheReadTokens: tokens.cacheReadTokens,
  };
}

function subtractTokens(total: PriceableTokens, covered: PriceableTokens): PriceableTokens {
  return {
    inputTokens: Math.max(0, total.inputTokens - covered.inputTokens),
    outputTokens: Math.max(0, total.outputTokens - covered.outputTokens),
    cacheWriteTokens: Math.max(0, total.cacheWriteTokens - covered.cacheWriteTokens),
    ...subtractOptionalTokens('cacheWrite5mTokens', total, covered),
    ...subtractOptionalTokens('cacheWrite1hTokens', total, covered),
    cacheReadTokens: Math.max(0, total.cacheReadTokens - covered.cacheReadTokens),
  };
}

function subtractOptionalTokens(
  key: 'cacheWrite5mTokens' | 'cacheWrite1hTokens',
  total: PriceableTokens,
  covered: PriceableTokens,
): Partial<Pick<PriceableTokens, 'cacheWrite5mTokens' | 'cacheWrite1hTokens'>> {
  if (total[key] === undefined && covered[key] === undefined) {
    return {};
  }

  const remaining = Math.max(0, (total[key] ?? 0) - (covered[key] ?? 0));
  return key === 'cacheWrite5mTokens' ? { cacheWrite5mTokens: remaining } : { cacheWrite1hTokens: remaining };
}

function subtractModelTokenTotals(
  total: ModelTokenTotals | undefined,
  covered: ModelTokenTotals | undefined,
): ModelTokenTotals | undefined {
  if (total === undefined) {
    return undefined;
  }

  const remaining: ModelTokenTotals = {};
  for (const [model, tokens] of Object.entries(total)) {
    remaining[model] = subtractTokens(
      tokens,
      covered?.[model] ?? { inputTokens: 0, outputTokens: 0, cacheWriteTokens: 0, cacheReadTokens: 0 },
    );
  }
  return remaining;
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
  const pricedTokens = priceableTokens(tokens);
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
    cacheWriteCostUsd(tokens, rates) +
    (tokens.cacheReadTokens / 1_000_000) * rates.cacheReadUsdPerMillion;

  return {
    costUsd: baseCostUsd * multiplier,
    pricedTokens,
    label: 'estimated at API rates',
  };
}

function cacheWriteCostUsd(tokens: PriceableTokens, rates: PricingRates): number {
  if (tokens.cacheWrite5mTokens === undefined && tokens.cacheWrite1hTokens === undefined) {
    return (tokens.cacheWriteTokens / 1_000_000) * rates.cacheWriteUsdPerMillion;
  }

  return (
    ((tokens.cacheWrite5mTokens ?? 0) / 1_000_000) * rates.cacheWriteUsdPerMillion +
    ((tokens.cacheWrite1hTokens ?? 0) / 1_000_000) * rates.inputUsdPerMillion * 2
  );
}
