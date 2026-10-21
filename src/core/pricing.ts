/**
 * API list prices in USD per million tokens (Anthropic first-party, as of 2026-10).
 * Cache writes cost 1.25x input (5 min TTL) or 2x input (1 h TTL); cache reads 0.1x input unless listed.
 * Used both for real API spend and for the "API equivalent" shown to subscription users.
 */
export interface ModelPrice {
  input: number;
  output: number;
  cacheRead?: number;
  /** Higher rates once a single request's prompt exceeds `threshold` tokens. */
  longContext?: { threshold: number; input: number; output: number };
}

const PRICES: Record<string, ModelPrice> = {
  "claude-fable-5-1": { input: 10, output: 50, cacheRead: 0.25 },
  "claude-mythos-5-1": { input: 10, output: 50, cacheRead: 0.25 },
  "claude-fable-5": { input: 10, output: 50 },
  "claude-mythos-5": { input: 10, output: 50 },
  "claude-opus-5-5": { input: 4, output: 20, cacheRead: 0.2 },
  "claude-opus-5": { input: 5, output: 25 },
  "claude-opus-4-8": { input: 5, output: 25 },
  "claude-opus-4-7": { input: 5, output: 25 },
  "claude-opus-4-6": { input: 5, output: 25 },
  "claude-opus-4-5": { input: 5, output: 25 },
  "claude-opus-4-1": { input: 15, output: 75 },
  "claude-opus-4": { input: 15, output: 75 },
  "claude-sonnet-5-5": { input: 2, output: 10, cacheRead: 0.2 },
  "claude-sonnet-5": { input: 2, output: 10 },
  "claude-sonnet-4-6": { input: 3, output: 15 },
  "claude-sonnet-4-5": { input: 3, output: 15 },
  "claude-sonnet-4": { input: 3, output: 15 },
  "claude-3-7-sonnet": { input: 3, output: 15 },
  "claude-haiku-5-5": { input: 0.1, output: 0.5, longContext: { threshold: 100_000, input: 0.5, output: 2.5 } },
  "claude-haiku-4-5": { input: 1, output: 5 },
  "claude-3-5-haiku": { input: 0.8, output: 4 },

  // OpenAI (Codex). "cacheRead" is OpenAI's cached-input price. As of 2026-10: gpt-6.1-sol from
  // OpenAI's announcement; gpt-6-sol and gpt-6-astra from price aggregators (verify on openai.com/api/pricing).
  "gpt-6.1-sol": { input: 2, output: 10, cacheRead: 0.1, longContext: { threshold: 272_000, input: 4, output: 15 } },
  "gpt-6-sol": { input: 2, output: 10, cacheRead: 0.2, longContext: { threshold: 272_000, input: 4, output: 15 } },
  "gpt-6-astra": { input: 10, output: 50, cacheRead: 1 },
};

/** Unknown models are priced like their family's mid-tier model so new releases still count toward the budget. */
export const FALLBACK_MODEL = "claude-sonnet-5-5";
const OPENAI_FALLBACK = "gpt-6.1-sol";

export interface TokenUsage {
  input: number;
  output: number;
  cacheWrite5m: number;
  cacheWrite1h: number;
  cacheRead: number;
}

export const ZERO_USAGE: TokenUsage = { input: 0, output: 0, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0 };

/** Normalize provider-prefixed ids ("us.anthropic.claude-…", "claude-…@2025…", "claude-…[1m]"). */
export function normalizeModel(model: string): string {
  const m = model.toLowerCase();
  const start = m.indexOf("claude-");
  return (start >= 0 ? m.slice(start) : m).replace(/[@[].*$/, "");
}

export function priceFor(model: string): { key: string; price: ModelPrice; known: boolean } {
  const id = normalizeModel(model);
  let best: string | undefined;
  for (const key of Object.keys(PRICES)) {
    if ((id === key || id.startsWith(`${key}-`)) && (!best || key.length > best.length)) best = key;
  }
  return best
    ? { key: best, price: PRICES[best]!, known: true }
    : { key: fallbackFor(id), price: PRICES[fallbackFor(id)]!, known: false };
}

export function costUsd(model: string, u: TokenUsage, opts: { fast?: boolean } = {}): number {
  const { price } = priceFor(model);
  let input = price.input;
  let output = price.output;
  let cacheRead = price.cacheRead ?? price.input * 0.1;
  const promptTokens = u.input + u.cacheWrite5m + u.cacheWrite1h + u.cacheRead;
  if (price.longContext && promptTokens > price.longContext.threshold) {
    cacheRead *= price.longContext.input / price.input;
    input = price.longContext.input;
    output = price.longContext.output;
  }
  const usd =
    (u.input * input + u.cacheWrite5m * input * 1.25 + u.cacheWrite1h * input * 2 + u.cacheRead * cacheRead + u.output * output) /
    1_000_000;
  // Fast mode is billed at 2x standard rates.
  return opts.fast ? usd * 2 : usd;
}

function fallbackFor(id: string): string {
  return /^(gpt|o\d|codex)/.test(id) ? OPENAI_FALLBACK : FALLBACK_MODEL;
}
