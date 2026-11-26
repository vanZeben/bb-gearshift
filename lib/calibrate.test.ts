import { describe, expect, it } from "vitest";
import { calibrate, formatCalibration, isDownshift, MIN_SAMPLES, outcomes, wilsonLower } from "./calibrate";
import { CLAUDE_CATALOG } from "./fixtures";
import { DEFAULT_POLICY, mergePolicy } from "./policy";
import type { DecisionRow } from "./store";

const NOW = Date.UTC(2026, 10, 26, 12);
const HOUR = 3_600_000;
const catalogs = { "claude-code": CLAUDE_CATALOG };
let n = 0;
const r = (o: Partial<DecisionRow> = {}): DecisionRow => {
  n++;
  return {
    id: n, at: NOW - HOUR * n, thread_id: `t${n}`, project_id: null, provider_id: "claude-code", initiator: "user", attempt: "start-turn", action: "shift", reason: "",
    tier: "small", scored_tier: "small", score: 4, confidence: "high", signals: "[]", chars: 1, fingerprint: `f${n}`, requested_model: null, requested_effort: null,
    routed_model: "claude-opus-5-5", routed_effort: "medium", routed_label: "Opus 5.5", routed_service_tier: null, baseline_model: null, context_tokens: null, latency_ms: null,
    queued_message_id: null, amend_status: null, turn_id: null, input_tokens: 100, output_tokens: 500, cache_read_tokens: 0, cache_write_tokens: 0, cost_usd: 0.01, baseline_cost_usd: null, ...o,
  };
};
const many = (k: number, o: Partial<DecisionRow>) => Array.from({ length: k }, () => r(o));
const run = (rows: DecisionRow[], policy = DEFAULT_POLICY) => calibrate(rows, policy, { days: 30, now: NOW, catalogs });
const opus = (effort: string) => ({ model: "claude-opus-5-5", effort });

describe("isDownshift", () => {
  it("needs cheaper on one axis and heavier on none", () => {
    const p = DEFAULT_POLICY, c = CLAUDE_CATALOG;
    expect(isDownshift(opus("low"), opus("medium"), p, c)).toBe(true);
    expect(isDownshift({ model: "claude-sonnet-5-5", effort: "medium" }, opus("medium"), p, c)).toBe(true);
    expect(isDownshift({ model: "claude-sonnet-5-5", effort: "high" }, opus("medium"), p, c)).toBe(false);
    expect(isDownshift(opus("medium"), opus("medium"), p, c)).toBe(false);
    expect(isDownshift(opus("high"), opus("medium"), p, c)).toBe(false);
  });
});

describe("outcomes", () => {
  it("marks re-sent messages and heavier hand-picks right after as bad", () => {
    const a = r({ thread_id: "x", at: NOW, fingerprint: "same" });
    const a2 = r({ thread_id: "x", at: NOW + 60_000, fingerprint: "same" });
    const b = r({ thread_id: "y", at: NOW, routed_effort: "low" });
    const b2 = r({ thread_id: "y", at: NOW + 60_000, action: "manual", routed_model: null, requested_model: "claude-opus-5-5", requested_effort: "high" });
    const c = r({ thread_id: "z", at: NOW, routed_effort: "low" });
    const c2 = r({ thread_id: "z", at: NOW + 60 * 60_000, action: "manual", routed_model: null, requested_model: "claude-opus-5-5", requested_effort: "high" });
    const d = r({ output_tokens: null });
    const v = outcomes([a, a2, b, b2, c, c2, d], DEFAULT_POLICY, catalogs);
    expect(v.get(a.id)).toBe("retried");
    expect(v.get(b.id)).toBe("corrected");
    expect(v.get(c.id)).toBe("good");
    expect(v.get(d.id)).toBe("unknown");
  });
});

describe("calibrate", () => {
  it("proposes the cheapest gear with good outcomes for the class", () => {
    const rows = [...many(10, { routed_effort: "medium" }), ...many(12, { routed_effort: "low" })];
    const c = run(rows);
    expect(c.proposals).toHaveLength(1);
    expect(c.proposals[0]!.tier).toBe("small");
    expect(c.proposals[0]!.sets).toEqual([{ path: "gears.claude-code.small.effort", value: "low" }]);
    expect(formatCalibration(c)).toContain("bb gearshift replay --set gears.claude-code.small.effort=low");
  });

  it("learns from the scored tier, so downshift-bias turns count for the class they came from", () => {
    const rows = many(12, { tier: "trivial", scored_tier: "small", routed_effort: "low" });
    expect(run(rows).proposals[0]?.tier).toBe("small");
  });

  it("never upshifts, and reports a weak current gear instead", () => {
    const rows: DecisionRow[] = [];
    for (let i = 0; i < 10; i++) {
      const t = `w${i}`;
      rows.push(r({ thread_id: t, at: NOW - i * HOUR, routed_effort: "medium" }));
      if (i < 4) rows.push(r({ thread_id: t, at: NOW - i * HOUR + 60_000, action: "manual", routed_model: null, requested_model: "claude-opus-5-5", requested_effort: "high", tier: "small", scored_tier: "small" }));
    }
    rows.push(...many(12, { routed_effort: "high" }));
    const c = run(rows);
    expect(c.proposals).toEqual([]);
    expect(c.weak.map((w) => w.tier)).toContain("small");
  });

  it("needs enough samples and good enough outcomes", () => {
    expect(run(many(MIN_SAMPLES - 1, { routed_effort: "low" })).proposals).toEqual([]);
    const rows: DecisionRow[] = [];
    for (let i = 0; i < 12; i++) {
      rows.push(r({ thread_id: `b${i}`, at: NOW - i * HOUR, routed_effort: "low", fingerprint: `g${i}` }));
      if (i % 2) rows.push(r({ thread_id: `b${i}`, at: NOW - i * HOUR + 30_000, routed_effort: "medium", fingerprint: `g${i}` }));
    }
    const c = run(rows);
    expect(c.proposals).toEqual([]);
    expect(c.classes.find((x) => x.tier === "small")?.note).toMatch(/did not keep good enough/);
  });

  it("keeps large work at medium effort or more", () => {
    const c = run(many(20, { tier: "large", scored_tier: "large", routed_effort: "low" }));
    expect(c.proposals.find((p) => p.tier === "large")?.to.effort).toBeUndefined();
    // Medium is Opus high on the default ladder, so large can only reach medium effort once medium does.
    expect(run(many(20, { tier: "large", scored_tier: "large", routed_effort: "medium" })).proposals).toEqual([]);
    const ok = run([...many(20, { tier: "medium", scored_tier: "medium", routed_effort: "medium" }), ...many(20, { tier: "large", scored_tier: "large", routed_effort: "medium" })]);
    expect(ok.proposals.find((p) => p.tier === "large")?.to.effort).toBe("medium");
  });

  it("never drops a tier below the tier beneath it", () => {
    // trivial stays at Opus low; a small-tier proposal of Haiku low would sit below it on the model axis.
    const policy = mergePolicy(DEFAULT_POLICY, {});
    const c = run(many(12, { routed_model: "claude-haiku-5-5", routed_effort: "low", routed_label: "Haiku 5.5" }), policy);
    expect(c.proposals).toEqual([]);
  });

  it("skips providers without a catalog", () => {
    const c = calibrate(many(12, { provider_id: "codex", routed_effort: "low" }), DEFAULT_POLICY, { days: 30, now: NOW, catalogs: {} });
    expect(c.uncalibrated).toEqual([{ providerId: "codex", reason: "no model catalog" }]);
    expect(c.proposals).toEqual([]);
  });

  it("wilson bound is conservative", () => {
    expect(wilsonLower(10, 10)).toBeGreaterThan(0.7);
    expect(wilsonLower(5, 5)).toBeLessThan(0.7);
    expect(wilsonLower(0, 0)).toBe(0);
  });
});
