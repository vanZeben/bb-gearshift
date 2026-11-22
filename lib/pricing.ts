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

/** The rates that apply to a prompt of this many tokens (input + cache reads + cache writes). */
export function ratesAt(price: Price, promptTokens: number): Required<Pick<Price, "input" | "output" | "cacheRead" | "cacheWrite">> {
  const p = price.longContext && promptTokens > price.longContext.aboveTokens ? price.longContext : price;
  return { input: p.input, output: p.output, cacheRead: p.cacheRead ?? p.input * 0.1, cacheWrite: p.cacheWrite ?? p.input * 1.25 };
}

/** Cost of a turn. `serviceTier` applies the policy's multiplier (missing tier = 1). */
export function costUsd(usage: Usage, price: Price | null, multiplier = 1): number | null {
  if (!price) return null;
  const { input, output, cacheRead, cacheWrite } = ratesAt(price, usage.inputTokens + usage.cacheReadTokens + usage.cacheWriteTokens);
  const dollars =
    usage.inputTokens * input +
    usage.outputTokens * output +
    usage.cacheReadTokens * cacheRead +
    usage.cacheWriteTokens * cacheWrite;
  return (dollars / 1_000_000) * multiplier;
}

export function tierMultiplier(policy: Pick<Policy, "serviceTierMultipliers">, serviceTier: string | null | undefined): number {
  return serviceTier ? policy.serviceTierMultipliers[serviceTier] ?? 1 : 1;
}
