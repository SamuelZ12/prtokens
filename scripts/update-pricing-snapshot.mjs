// Regenerates src/pricing/litellm-snapshot.json from LiteLLM's published pricing
// database, keeping every Claude entry (bare, dated, Bedrock, and Vertex id forms).
// Usage: npm run update-pricing

import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const SOURCE_URL = 'https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json';
const SNAPSHOT_PATH = fileURLToPath(new URL('../src/pricing/litellm-snapshot.json', import.meta.url));

// Used only when the model is missing upstream; never overrides LiteLLM data.
const FALLBACK_RATES = {
  // Claude Mythos 5 is gated to Project Glasswing and priced identically to Claude Fable 5.
  'claude-mythos-5': {
    inputUsdPerMillion: 10,
    outputUsdPerMillion: 50,
    cacheWriteUsdPerMillion: 12.5,
    cacheReadUsdPerMillion: 1,
  },
  // OpenCode emits these aliases; rates mirror the fetched LiteLLM gpt-5.4/gpt-5.5 base entries.
  'gpt-5.4-fast': {
    inputUsdPerMillion: 2.5,
    outputUsdPerMillion: 15,
    cacheWriteUsdPerMillion: 0,
    cacheReadUsdPerMillion: 0.25,
  },
  'gpt-5.5-fast': {
    inputUsdPerMillion: 5,
    outputUsdPerMillion: 30,
    cacheWriteUsdPerMillion: 0,
    cacheReadUsdPerMillion: 0.5,
  },
};

const response = await fetch(SOURCE_URL);
if (!response.ok) {
  throw new Error(`Failed to fetch LiteLLM pricing: ${response.status} ${response.statusText}`);
}
const source = await response.json();

const snapshot = {};
for (const [model, entry] of Object.entries(source)) {
  if (!shouldIncludeModel(model)) {
    continue;
  }

  const inputUsdPerMillion = perMillion(entry?.input_cost_per_token);
  const outputUsdPerMillion = perMillion(entry?.output_cost_per_token);
  if (inputUsdPerMillion === undefined || outputUsdPerMillion === undefined) {
    continue;
  }

  const isClaude = model.toLowerCase().includes('claude');
  snapshot[model] = {
    inputUsdPerMillion,
    outputUsdPerMillion,
    cacheWriteUsdPerMillion: perMillion(entry.cache_creation_input_token_cost) ?? (isClaude ? round(inputUsdPerMillion * 1.25) : 0),
    cacheReadUsdPerMillion: perMillion(entry.cache_read_input_token_cost) ?? (isClaude ? round(inputUsdPerMillion * 0.1) : 0),
  };
}

for (const [model, rates] of Object.entries(FALLBACK_RATES)) {
  snapshot[model] ??= rates;
}

const sorted = Object.fromEntries(
  Object.entries(snapshot).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
);

writeFileSync(SNAPSHOT_PATH, `${JSON.stringify(sorted, null, 2)}\n`);
console.log(`Wrote ${Object.keys(sorted).length} models to ${SNAPSHOT_PATH}`);

function shouldIncludeModel(model) {
  const normalized = model.toLowerCase();
  if (normalized.includes('claude')) return true;
  if (!normalized.startsWith('gpt-5')) return false;
  return (
    normalized.includes('codex') ||
    normalized.includes('fast') ||
    normalized.includes('mini') ||
    normalized.includes('nano') ||
    /^gpt-5(\.\d+)?$/.test(normalized)
  );
}

function perMillion(costPerToken) {
  if (typeof costPerToken !== 'number' || !Number.isFinite(costPerToken)) {
    return undefined;
  }

  return round(costPerToken * 1_000_000);
}

function round(value) {
  return Number(value.toPrecision(12));
}
