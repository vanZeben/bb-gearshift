// Prices come from the policy. They are API-equivalent USD per million tokens: many users
// run providers on a subscription, where a turn has no per-token bill, and the same tokens
// priced at public API rates are the fairest common unit for comparing models.
import type { Policy, Price } from "./policy";

export type { Price };

export interface Usage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

/** The price of the longest key the model id equals or starts with (case-insensitive). Null when none. */
export function priceFor(model: string, prices: Policy["prices"]): Price | null {
  const id = model.toLowerCase();
  let best: string | null = null;
  for (const key of Object.keys(prices)) {
    const k = key.toLowerCase();
    if ((id === k || id.startsWith(k)) && (best === null || k.length > best.length)) best = key;
  }
  return best === null ? null : prices[best]!;
}

/** Cost of a turn. `serviceTier` applies the policy's multiplier (missing tier = 1). */
export function costUsd(usage: Usage, price: Price | null, multiplier = 1): number | null {
  if (!price) return null;
  const cacheRead = price.cacheRead ?? price.input * 0.1;
  const cacheWrite = price.cacheWrite ?? price.input * 1.25;
  const dollars =
    usage.inputTokens * price.input +
    usage.outputTokens * price.output +
    usage.cacheReadTokens * cacheRead +
    usage.cacheWriteTokens * cacheWrite;
  return (dollars / 1_000_000) * multiplier;
}

export function tierMultiplier(policy: Pick<Policy, "serviceTierMultipliers">, serviceTier: string | null | undefined): number {
  return serviceTier ? policy.serviceTierMultipliers[serviceTier] ?? 1 : 1;
}
