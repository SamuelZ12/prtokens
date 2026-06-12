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
};

const response = await fetch(SOURCE_URL);
if (!response.ok) {
  throw new Error(`Failed to fetch LiteLLM pricing: ${response.status} ${response.statusText}`);
}
const source = await response.json();

const snapshot = {};
for (const [model, entry] of Object.entries(source)) {
  if (!model.toLowerCase().includes('claude')) {
    continue;
  }

  const inputUsdPerMillion = perMillion(entry?.input_cost_per_token);
  const outputUsdPerMillion = perMillion(entry?.output_cost_per_token);
  if (inputUsdPerMillion === undefined || outputUsdPerMillion === undefined) {
    continue;
  }

  snapshot[model] = {
    inputUsdPerMillion,
    outputUsdPerMillion,
    // Anthropic's standard cache multipliers (1.25x write, 0.1x read) when LiteLLM omits them.
    cacheWriteUsdPerMillion: perMillion(entry.cache_creation_input_token_cost) ?? round(inputUsdPerMillion * 1.25),
    cacheReadUsdPerMillion: perMillion(entry.cache_read_input_token_cost) ?? round(inputUsdPerMillion * 0.1),
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

function perMillion(costPerToken) {
  if (typeof costPerToken !== 'number' || !Number.isFinite(costPerToken)) {
    return undefined;
  }

  return round(costPerToken * 1_000_000);
}

function round(value) {
  return Number(value.toPrecision(12));
}
