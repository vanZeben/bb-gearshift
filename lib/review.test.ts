import { describe, expect, it } from "vitest";
import { buildReview, formatReview, type Review } from "./review";
import { DEFAULT_POLICY } from "./policy";
import type { DecisionRow } from "./store";

const NOW = Date.UTC(2026, 10, 20, 12);
const DAY = 86_400_000;
let n = 0;
const r = (o: Partial<DecisionRow> = {}): DecisionRow => ({
  id: ++n, at: NOW - 1000 * n, thread_id: "t1", project_id: null, provider_id: "claude-code", initiator: "user", attempt: "start-turn", action: "shift", reason: "",
  tier: "small", score: 3, confidence: "high", signals: "[]", chars: 1, fingerprint: null, requested_model: "opus", requested_effort: "high", routed_model: "sonnet",
  routed_effort: "medium", routed_label: "Sonnet", routed_service_tier: null, baseline_model: "opus", context_tokens: null, latency_ms: null, queued_message_id: null,
  amend_status: null, turn_id: null, input_tokens: null, output_tokens: null, cache_read_tokens: null, cache_write_tokens: null, cost_usd: null, baseline_cost_usd: null, ...o,
});
const many = (k: number, o: Partial<DecisionRow> | ((i: number) => Partial<DecisionRow>)) => Array.from({ length: k }, (_, i) => r(typeof o === "function" ? o(i) : o));
const build = (rows: DecisionRow[], days = 30): Review => buildReview(rows, DEFAULT_POLICY, { days, now: NOW });
const xl = (extra: Partial<DecisionRow> = {}): Partial<DecisionRow> => ({ tier: "xlarge", score: 13, routed_model: "opus", routed_label: "Opus", routed_effort: "xhigh", ...extra });

describe("window and counts", () => {
  it("keeps only start-turn rows inside the window", () => {
    const rows = [r(), r({ at: NOW - 2 * DAY }), r({ at: NOW - 40 * DAY }), r({ attempt: "join-turn", action: "skip", tier: null }), r({ at: NOW + DAY })];
    const rv = build(rows, 7);
    expect(rv.counts.total).toBe(2);
    expect(rv.period.days).toBe(7);
    expect(rv.period.from).toBe(new Date(NOW - 7 * DAY).toISOString());
    expect(build(rows, 90).counts.total).toBe(3);
  });
  it("counts every action", () => {
    const rv = build([r(), r({ action: "keep" }), r({ action: "hold" }), r({ action: "manual", tier: null }), r({ action: "skip", tier: null }), r({ action: "off", tier: null })]);
    expect(rv.counts).toEqual({ total: 6, shift: 1, keep: 1, hold: 1, manual: 1, skip: 1, off: 1 });
  });
  it("handles no data", () => {
    const rv = build([]);
    expect(rv.tiers).toEqual([]);
    expect(rv.holds.n).toBe(0);
    expect(rv.hints).toEqual([]);
    expect(formatReview(rv)).toMatch(/No routed messages/);
  });
});

describe("per-tier stats", () => {
  const rows = [
    ...many(3, (i) => ({ tier: "small", score: 3 + (i % 2), output_tokens: [100, 200, 5000][i], signals: '["question"]', cost_usd: 0.5 })),
    r({ tier: "large", score: 10, signals: '["build","question"]', output_tokens: null }),
    r({ action: "manual", tier: "small" }),
  ];
  const rv = build(rows);
  it("reports counts, share, score, percentiles and cost per tier", () => {
    expect(rv.tiers.map((t) => t.tier)).toEqual(["small", "large"]);
    const s = rv.tiers[0]!;
    expect(s).toMatchObject({ n: 3, share: 0.75, avgScore: 3.33, outputP50: 200, outputP90: 5000, turnsWithUsage: 3, costUsd: 1.5 });
    expect(s.smallOutputShare).toBeCloseTo(0.667, 3);
    expect(rv.tiers[1]).toMatchObject({ n: 1, outputP50: null, smallOutputShare: null });
  });
  it("lists the top signals", () => {
    expect(rv.tiers[0]!.topSignals).toEqual([{ signal: "question", count: 3 }]);
    expect(rv.tiers[1]!.topSignals.map((x) => x.signal)).toEqual(["build", "question"]);
  });
  it("groups gears", () => {
    expect(rv.gears[0]).toMatchObject({ label: "Sonnet", effort: "medium", n: 4 });
  });
});

describe("holds", () => {
  it("summarises cost share, context and held gears", () => {
    const rv = build([
      ...many(2, { action: "hold", tier: "xlarge", routed_label: "Opus", routed_effort: "xhigh", cost_usd: 3, context_tokens: 100_000 }),
      r({ action: "shift", cost_usd: 2 }),
    ]);
    expect(rv.holds).toMatchObject({ n: 2, costUsd: 6, shareOfCost: 0.75, avgContextTokens: 100_000 });
    expect(rv.holds.gears).toEqual([{ gear: "Opus · XHigh", n: 2 }]);
    expect(formatReview(rv)).toMatch(/hold keeps the gear/);
  });
  it("is zero-safe without cost", () => {
    expect(build([r({ action: "hold" })]).holds).toMatchObject({ n: 1, shareOfCost: 0, avgContextTokens: null });
  });
});

describe("manual picks", () => {
  it("groups by tier, model and effort", () => {
    const rv = build([
      ...many(2, { action: "manual", tier: "large", requested_model: "sonnet", requested_effort: "medium" }),
      r({ action: "manual", tier: "large", requested_model: "opus", requested_effort: "high" }),
      r({ action: "manual", tier: "small", requested_model: "haiku", requested_effort: null }),
      r({ action: "manual", tier: null, requested_model: "opus", requested_effort: "low" }),
    ]);
    expect(rv.manualPicks).toEqual([
      { tier: "small", model: "haiku", effort: null, n: 1 },
      { tier: "large", model: "sonnet", effort: "medium", n: 2 },
      { tier: "large", model: "opus", effort: "high", n: 1 },
      { tier: "unclassified", model: "opus", effort: "low", n: 1 },
    ]);
  });
});

describe("overkill and underkill", () => {
  const rows = [
    r({ tier: "large", output_tokens: 300, thread_id: "a", at: NOW - 5000 }),
    r({ tier: "xlarge", output_tokens: 1499, thread_id: "b", at: NOW - 1000 }),
    r({ tier: "large", output_tokens: 1500, thread_id: "no-boundary" }),
    r({ tier: "large", output_tokens: null, thread_id: "no-usage" }),
    r({ tier: "medium", output_tokens: 10, thread_id: "medium" }),
    r({ tier: "small", output_tokens: 10_001, thread_id: "u1", cost_usd: 4 }),
    r({ tier: "trivial", output_tokens: 10_000, thread_id: "no-boundary2" }),
    r({ action: "manual", tier: "large", output_tokens: 10, thread_id: "manual" }),
  ];
  const rv = build(rows);
  it("lists large/x-large turns with small output, newest first", () => {
    expect(rv.overkill.map((x) => x.threadId)).toEqual(["b", "a"]);
    expect(rv.overkill[0]).toMatchObject({ tier: "xlarge", outputTokens: 1499, gear: "Sonnet · Medium" });
    expect(rv.overkill[0]!.at).toBe(new Date(NOW - 1000).toISOString());
  });
  it("lists trivial/small turns with big output", () => {
    expect(rv.underkill.map((x) => x.threadId)).toEqual(["u1"]);
    expect(rv.underkill[0]!.costUsd).toBe(4);
  });
  it("caps lists at 15", () => {
    expect(build(many(20, { tier: "large", output_tokens: 5 })).overkill).toHaveLength(15);
  });
});

describe("signal precision", () => {
  it("measures small-output share per signal in large/x-large rows", () => {
    const rv = build([
      r({ tier: "large", signals: '["build","refactor"]', output_tokens: 100 }),
      r({ tier: "large", signals: '["build"]', output_tokens: 9000 }),
      r({ tier: "xlarge", signals: '["build"]', output_tokens: 200 }),
      r({ tier: "small", signals: '["question"]', output_tokens: 50 }),
    ]);
    expect(rv.signalPrecision).toEqual([
      { signal: "build", n: 3, shareOfLargeRows: 1, smallOutputShare: 0.667 },
      { signal: "refactor", n: 1, shareOfLargeRows: 0.333, smallOutputShare: 1 },
    ]);
  });
  it("tolerates bad signal JSON", () => {
    expect(build([r({ tier: "large", signals: "oops" })]).signalPrecision).toEqual([]);
  });
});

describe("policy section", () => {
  it("shows bands, gears for the providers seen, and holdAboveTokens", () => {
    const rv = build([r({ provider_id: "codex" }), r()]);
    expect(rv.policy.tiers).toEqual(DEFAULT_POLICY.tiers);
    expect(Object.keys(rv.policy.gears).sort()).toEqual(["claude-code", "codex"]);
    expect(rv.policy.gears["claude-code"]!.xlarge).toContain("opus");
    expect(rv.policy.holdAboveTokens).toBe(DEFAULT_POLICY.routing.holdAboveTokens);
  });
  it("falls back to * with no rows", () => {
    expect(Object.keys(build([]).policy.gears)).toEqual(["*"]);
  });
});

describe("hints", () => {
  const ids = (rv: Review) => rv.hints.map((h) => h.id);

  it("xlarge-share fires with many x-large turns that had small output", () => {
    const rows = [...many(5, xl({ output_tokens: 300 })), ...many(5, { tier: "small" })];
    expect(ids(build(rows))).toContain("xlarge-share");
  });
  it("xlarge-share stays quiet when the share is low, output is big, or the sample is tiny", () => {
    expect(ids(build([...many(2, xl({ output_tokens: 300 })), ...many(10, { tier: "small" })]))).not.toContain("xlarge-share");
    expect(ids(build(many(6, xl({ output_tokens: 8000 }))))).not.toContain("xlarge-share");
    expect(ids(build(many(4, xl({ output_tokens: 300 }))))).not.toContain("xlarge-share");
  });

  it("broad-signal fires for a signal in most large rows with small output", () => {
    const rows = [...many(6, { tier: "large", signals: '["build"]', output_tokens: 200 }), ...many(2, { tier: "large", signals: '["other"]', output_tokens: 9000 })];
    const rv = build(rows);
    expect(ids(rv)).toContain("broad-signal:build");
    expect(ids(rv)).not.toContain("broad-signal:other");
  });
  it("broad-signal stays quiet when the signal is rare or its output is big", () => {
    const rare = [...many(2, { tier: "large", signals: '["build"]', output_tokens: 200 }), ...many(8, { tier: "large", signals: '["x"]', output_tokens: 9000 })];
    expect(ids(build(rare))).not.toContain("broad-signal:build");
    expect(ids(build(many(8, { tier: "large", signals: '["build"]', output_tokens: 9000 })))).toEqual([]);
  });

  it("hold-cost fires when holds are over 30% of cost", () => {
    const rows = [...many(5, { action: "hold", cost_usd: 2 }), ...many(5, { cost_usd: 2 })];
    expect(ids(build(rows))).toContain("hold-cost");
  });
  it("hold-cost stays quiet for a small share or few holds", () => {
    expect(ids(build([...many(5, { action: "hold", cost_usd: 1 }), ...many(5, { cost_usd: 5 })]))).not.toContain("hold-cost");
    expect(ids(build([...many(2, { action: "hold", cost_usd: 9 }), r({ cost_usd: 1 })]))).not.toContain("hold-cost");
  });

  it("manual-lower fires when most manual picks in a tier use a lower effort than the gear", () => {
    const rows = many(6, { action: "manual", tier: "xlarge", requested_effort: "medium" });
    const h = build(rows).hints.find((x) => x.id === "manual-lower:xlarge");
    expect(h?.evidence).toMatchObject({ picks: 6, lower: 6 });
  });
  it("manual-lower stays quiet for equal or higher efforts, or few picks", () => {
    expect(ids(build(many(6, { action: "manual", tier: "xlarge", requested_effort: "xhigh" })))).toEqual([]);
    expect(ids(build(many(3, { action: "manual", tier: "xlarge", requested_effort: "low" })))).toEqual([]);
  });
});

describe("formatReview", () => {
  const rows = [
    ...many(6, xl({ output_tokens: 400, cost_usd: 1.2, signals: '["build"]', context_tokens: 50_000, action: "keep" })),
    ...many(2, xl({ action: "hold", cost_usd: 1, output_tokens: 5000 })),
    r({ tier: "small", output_tokens: 20_000, cost_usd: 3 }),
    r({ action: "manual", tier: "xlarge", requested_model: "sonnet", requested_effort: "medium" }),
  ];
  const text = formatReview(build(rows));
  it("has the sections, numbers and no emoji", () => {
    for (const h of ["Tiers", "Gears used", "Holds", "Manual picks", "Possible overkill", "Possible underkill", "Signal precision", "Current policy", "Hints"]) expect(text).toContain(h);
    expect(text).toContain("X-large: 8");
    expect(text).toContain("thread t1");
    expect(text).not.toMatch(/\p{Extended_Pictographic}/u);
  });
});
