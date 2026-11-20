import { describe, expect, it } from "vitest";
import { costUsd, priceFor, tierMultiplier } from "./pricing";
import { DEFAULT_POLICY } from "./policy";

const u = { inputTokens: 1_000_000, outputTokens: 1_000_000, cacheReadTokens: 1_000_000, cacheWriteTokens: 1_000_000 };

describe("priceFor", () => {
  const prices = DEFAULT_POLICY.prices;
  it("longest matching key wins", () => {
    expect(priceFor("claude-opus-5-5-20260101", prices)).toEqual(prices["claude-opus-5-5"]);
    expect(priceFor("claude-opus-5-1", prices)).toEqual(prices["claude-opus-5"]);
    expect(priceFor("claude-haiku-4-5-20251001", prices)).toEqual(prices["claude-haiku-4-5"]);
    expect(priceFor("claude-haiku-5-5", prices)).toEqual(prices["claude-haiku-5-5"]);
  });
  it("is case-insensitive and null when unknown", () => {
    expect(priceFor("Claude-Sonnet-5-5", prices)).not.toBeNull();
    expect(priceFor("gpt-6", prices)).toBeNull();
  });
  it("user keys override and extend", () => {
    const merged = { ...prices, "claude-opus-5-5": { input: 1, output: 1 }, "gpt-6": { input: 2, output: 3 } };
    expect(priceFor("claude-opus-5-5", merged)).toEqual({ input: 1, output: 1 });
    expect(priceFor("gpt-6-mini", merged)).toEqual({ input: 2, output: 3 });
  });
});

describe("costUsd", () => {
  it("prices all four token kinds with cache defaults", () => {
    expect(costUsd(u, { input: 2, output: 10 })).toBeCloseTo(2 + 10 + 0.2 + 2.5);
    expect(costUsd(u, { input: 2, output: 10, cacheRead: 1, cacheWrite: 3 })).toBeCloseTo(16);
  });
  it("is null without a price and applies the multiplier", () => {
    expect(costUsd(u, null)).toBeNull();
    expect(costUsd(u, { input: 1, output: 1 }, 2)).toBeCloseTo(2 * costUsd(u, { input: 1, output: 1 })!);
  });
  it("tierMultiplier defaults to 1", () => {
    expect(tierMultiplier(DEFAULT_POLICY, "fast")).toBe(2);
    expect(tierMultiplier(DEFAULT_POLICY, "default")).toBe(1);
    expect(tierMultiplier(DEFAULT_POLICY, null)).toBe(1);
  });
});
