import { describe, expect, it } from "vitest";
import {
  formatDay,
  formatEffort,
  formatGear,
  formatMs,
  formatPercent,
  formatRelativeTime,
  formatTokens,
  formatUsd,
  shortModel,
  truncate,
} from "./format";

describe("format", () => {
  it("formats gears", () => {
    expect(formatGear("Sonnet 5.5", "high")).toBe("Sonnet 5.5 · High");
    expect(formatGear("Haiku", null)).toBe("Haiku");
    expect(formatGear(null, "low")).toBeNull();
    expect(formatEffort("xhigh")).toBe("XHigh");
  });
  it("formats money", () => {
    expect(formatUsd(0)).toBe("$0.00");
    expect(formatUsd(0.004)).toBe("<$0.01");
    expect(formatUsd(1.234)).toBe("$1.23");
    expect(formatUsd(1234.5)).toBe("$1,235");
    expect(formatUsd(null)).toBe("n/a");
  });
  it("formats tokens, percent and ms", () => {
    expect(formatTokens(950)).toBe("950");
    expect(formatTokens(1500)).toBe("1.5k");
    expect(formatTokens(45000)).toBe("45k");
    expect(formatTokens(2_500_000)).toBe("2.5M");
    expect(formatPercent(1, 3)).toBe("33%");
    expect(formatPercent(1, 0)).toBe("0%");
    expect(formatMs(120)).toBe("120 ms");
    expect(formatMs(1500)).toBe("1.5 s");
    expect(formatMs(null)).toBe("n/a");
  });
  it("formats relative time", () => {
    const now = 1_000_000_000;
    expect(formatRelativeTime(now - 1000, now)).toBe("just now");
    expect(formatRelativeTime(now - 5 * 60_000, now)).toBe("5 min ago");
    expect(formatRelativeTime(now - 3 * 3_600_000, now)).toBe("3 h ago");
  });
  it("handles text helpers", () => {
    expect(truncate("abcdef", 4)).toBe("abc…");
    expect(truncate("abc", 4)).toBe("abc");
    expect(shortModel("claude-opus-4-1-20250805")).toBe("claude-opus-4-1");
    expect(formatDay("2026-11-20")).toMatch(/20/);
  });
});

import { formatContribution, formatContributions } from "./format";

describe("contributions", () => {
  it("formats each kind", () => {
    expect(formatContribution({ label: "large build", kind: "floor", value: 9 })).toBe("large build +9 floor");
    expect(formatContribution({ label: "question", kind: "base", value: 1 })).toBe("question 1");
    expect(formatContribution({ label: "3 areas", kind: "bonus", value: 4 })).toBe("3 areas +4");
  });
  it("joins with middots and tolerates empty", () => {
    expect(
      formatContributions([
        { label: "a", kind: "add", value: 2 },
        { label: "b", kind: "add", value: 1 },
      ]),
    ).toBe("a +2 · b +1");
    expect(formatContributions(undefined)).toBe("");
  });
});
