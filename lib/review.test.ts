import { describe, expect, it } from "vitest";
import { buildReview, formatReview, HINT_MIN_ROWS, reviewThreadIds, SMALL_OUTPUT_TOKENS, withTitles, type Review } from "./review";
import { DEFAULT_POLICY, mergePolicy } from "./policy";
import { TIERED_GEARS } from "./fixtures";

// The lower-gear suggestions need a different gear per tier, so they run on the pre-0.5 tiered ladder.
const TIERED_POLICY = mergePolicy(DEFAULT_POLICY, { gears: TIERED_GEARS });
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

describe("hold origins", () => {
  // Ids are explicit so origins are easy to read; `at` grows with the id.
  const at = (id: number) => NOW - 10 * DAY + id * 1000;
  const row = (id: number, o: Partial<DecisionRow> = {}) => r({ id, at: at(id), thread_id: "t1", ...o });
  const held = (id: number, o: Partial<DecisionRow> = {}) => row(id, { action: "hold", ...xl({ output_tokens: 300, cost_usd: 2 }), ...o });

  it("flags held overkill rows and reads the inherited gear from current_model/current_effort", () => {
    const rv = build([row(1, xl({ action: "keep" })), held(2, { hold_kind: "gear", hold_origin_id: 1, current_model: "Opus 5.5", current_effort: "xhigh" }), row(3, { tier: "large", output_tokens: 10 })]);
    const turn = rv.overkill.find((t) => t.id === 2)!;
    expect(turn).toMatchObject({ held: true, holdKind: "gear", inheritedGear: "Opus 5.5 · XHigh", holdOriginId: 1 });
    expect(rv.overkill.find((t) => t.id === 3)).toMatchObject({ held: false, holdKind: null, inheritedGear: null, holdOriginId: null });
    expect(formatReview(rv)).toContain("held (gear) from #1 on Opus 5.5 · XHigh");
  });
  it("flags held underkill rows", () => {
    const rv = build([row(1, xl({ action: "keep" })), row(2, { action: "hold", tier: "small", output_tokens: 20_000, hold_kind: "effort", hold_origin_id: 1 })]);
    expect(rv.underkill[0]).toMatchObject({ id: 2, held: true, holdKind: "effort", holdOriginId: 1 });
  });
  it("falls back to the origin row's routed gear when there is no current gear", () => {
    const rv = build([row(1, xl({ action: "keep" })), held(2, { hold_origin_id: 1 })]);
    expect(rv.overkill.find((t) => t.id === 2)).toMatchObject({ inheritedGear: "Opus · XHigh", holdKind: null });
  });
  it("leaves the inherited gear null when neither the current gear nor the origin row is known", () => {
    const turn = build([held(2, { hold_origin_id: 99 })]).overkill[0]!;
    expect(turn).toMatchObject({ holdOriginId: 99, inheritedGear: null });
  });
  it("derives the origin for legacy rows from the newest earlier gear-setting row of the same thread", () => {
    const rv = build([
      row(1, xl({ action: "shift" })),
      row(2, { thread_id: "other", action: "shift" }),
      row(3, { action: "skip", tier: null }),
      row(4, { attempt: "join-turn", action: "keep" }),
      held(5),
    ]);
    expect(rv.overkill[0]).toMatchObject({ id: 5, holdOriginId: 1, inheritedGear: "Opus · XHigh" });
  });
  it("treats a manual pick as the origin", () => {
    const rv = build([row(1, { action: "manual", tier: null, requested_model: "opus", requested_effort: "max" }), held(2)]);
    expect(rv.overkill[0]).toMatchObject({ holdOriginId: 1, inheritedGear: "opus · Max" });
  });
  it("follows a chain of legacy holds back to the row that set the gear", () => {
    const rv = build([row(1, xl({ action: "keep" })), held(2), held(3), held(4)]);
    expect(rv.holds.topOrigins).toHaveLength(1);
    expect(rv.holds.topOrigins[0]).toMatchObject({ originId: 1, heldTurns: 3, heldCostUsd: 6 });
    expect(rv.overkill.map((t) => t.holdOriginId)).toEqual([1, 1, 1]);
  });
  it("prefers the stored origin over deriving one, and has none to derive without an earlier row", () => {
    const rv = build([row(1, xl({ action: "keep" })), row(2, xl({ action: "shift" })), held(3, { hold_origin_id: 1 }), held(7, { thread_id: "lonely" })]);
    expect(rv.overkill.find((t) => t.id === 3)!.holdOriginId).toBe(1);
    expect(rv.overkill.find((t) => t.id === 7)!.holdOriginId).toBeNull();
    expect(rv.holds.topOrigins.map((o) => o.originId)).toEqual([1]);
  });
  it("ranks origins by held cost and caps the list", () => {
    const rv = build([
      row(1, xl({ action: "keep", thread_id: "a" })), row(2, xl({ action: "keep", thread_id: "b", tier: "large" })),
      held(3, { thread_id: "a", hold_origin_id: 1, cost_usd: 1 }), held(4, { thread_id: "b", hold_origin_id: 2, cost_usd: 5 }), held(5, { thread_id: "b", hold_origin_id: 2, cost_usd: 1 }),
    ]);
    expect(rv.holds.topOrigins).toEqual([
      { originId: 2, threadId: "b", at: new Date(at(2)).toISOString(), gear: "Opus · XHigh", tier: "large", heldTurns: 2, heldCostUsd: 6 },
      { originId: 1, threadId: "a", at: new Date(at(1)).toISOString(), gear: "Opus · XHigh", tier: "xlarge", heldTurns: 1, heldCostUsd: 1 },
    ]);
    const many20 = Array.from({ length: 20 }, (_, i) => held(100 + i, { thread_id: `x${i}`, hold_origin_id: 500 + i }));
    expect(build(many20).holds.topOrigins).toHaveLength(15);
  });
  it("reports an origin outside the window or missing from the rows with no date or gear", () => {
    const rv = build([row(1, xl({ action: "keep", at: NOW - 60 * DAY })), held(2, { hold_origin_id: 1 }), held(3, { thread_id: "t2", hold_origin_id: 404 })]);
    expect(rv.holds.topOrigins.find((o) => o.originId === 404)).toEqual({ originId: 404, threadId: "t2", at: null, gear: null, tier: null, heldTurns: 1, heldCostUsd: 2 });
    expect(rv.holds.topOrigins.find((o) => o.originId === 1)).toMatchObject({ at: new Date(NOW - 60 * DAY).toISOString(), gear: "Opus · XHigh" });
    expect(formatReview(rv)).toContain("#404 (outside this period)");
  });
  it("counts hold kinds with cost, naming rows without a kind unknown", () => {
    const rv = build([
      held(1, { hold_kind: "gear", cost_usd: 3 }), held(2, { hold_kind: "gear", cost_usd: 1 }), held(3, { hold_kind: "effort", cost_usd: 1 }),
      held(4, { hold_kind: "continuation", cost_usd: 0.5 }), held(5, { cost_usd: 0.25 }),
    ]);
    expect(rv.holds.kinds).toEqual([
      { kind: "gear", n: 2, costUsd: 4 }, { kind: "effort", n: 1, costUsd: 1 }, { kind: "continuation", n: 1, costUsd: 0.5 }, { kind: "unknown", n: 1, costUsd: 0.25 },
    ]);
    expect(formatReview(rv)).toContain("hold kinds: gear 2 ($4.00), effort 1 ($1.00)");
  });
  it("counts downshifts separately from holds", () => {
    const rv = build([row(1, { action: "shift", hold_kind: "downshift" }), row(2, { action: "shift", hold_kind: "downshift" }), row(3, { action: "shift" }), held(4)]);
    expect(rv.holds.downshifts).toBe(2);
    expect(rv.holds.n).toBe(1);
    expect(formatReview(rv)).toContain("2 holds were waived for a cheaper model");
  });
  it("lists top origins in the formatted holds section", () => {
    const text = formatReview(build([row(1, xl({ action: "keep" })), held(2, { hold_origin_id: 1 })]));
    expect(text).toContain("Top hold origins");
    expect(text).toMatch(/- #1 \d{4}-\d\d-\d\d \d\d:\d\dZ thread t1 xlarge on Opus · XHigh: 1 held turn, \$2\.00/);
  });
  it("points the hold-cost hint at holdEffortFollowsMessage and the origin turns", () => {
    const h = build([...many(5, { action: "hold", cost_usd: 2 }), ...many(5, { cost_usd: 2 })]).hints.find((x) => x.id === "hold-cost");
    expect(h?.message).toMatch(/holdEffortFollowsMessage/);
    expect(h?.message).toMatch(/origins/);
  });
});

describe("policy stamp", () => {
  const CHANGED = NOW - 3 * DAY;
  const rows = [
    ...many(3, { policy_rev: "aaaa" }), ...many(2, { policy_rev: "bbbb", action: "hold" }), ...many(4, { policy_rev: null }), r({ policy_rev: "bbbb", action: "manual", tier: null }), r({ policy_rev: "cccc", action: "skip", tier: null }),
  ];
  const rv = buildReview(rows, DEFAULT_POLICY, { days: 30, now: NOW, policyRev: "aaaa", policyChangedAt: CHANGED });
  it("counts routed decisions under an earlier policy and without a stamp", () => {
    expect(rv.policy).toMatchObject({ rev: "aaaa", changedAt: new Date(CHANGED).toISOString(), routedDecisions: 9, olderDecisions: 2, unstampedDecisions: 4 });
  });
  it("prints a note under Current policy", () => {
    const text = formatReview(rv);
    expect(text).toContain("Policy last changed 2026-11-17 12:00Z; 2 of 9 decisions in the window were made under an earlier policy; 4 have no stamp (made before stamping)");
    expect(text.indexOf("Policy last changed")).toBeGreaterThan(text.indexOf("Current policy"));
  });
  it("hints when the policy changed inside the window, and not when it changed before it", () => {
    expect(rv.hints.map((h) => h.id)).toContain("policy-changed");
    const old = buildReview(rows, DEFAULT_POLICY, { days: 30, now: NOW, policyRev: "aaaa", policyChangedAt: NOW - 90 * DAY });
    expect(old.hints.map((h) => h.id)).not.toContain("policy-changed");
    expect(buildReview(rows, DEFAULT_POLICY, { days: 30, now: NOW, policyRev: "aaaa", policyChangedAt: null }).hints.map((h) => h.id)).not.toContain("policy-changed");
  });
  it("defaults to no stamp info without options, and omits the note when there is nothing to say", () => {
    const plain = build([r({ policy_rev: "aaaa" })]);
    expect(plain.policy).toMatchObject({ rev: null, changedAt: null, olderDecisions: 0, unstampedDecisions: 0 });
    expect(formatReview(plain)).not.toMatch(/Policy last changed|no stamp|earlier policy/);
  });
});

describe("thread titles", () => {
  const rv = build([
    r({ tier: "large", output_tokens: 10, thread_id: "t1", id: 1 }), r({ tier: "xlarge", output_tokens: 10, thread_id: "t2", id: 2 }),
    r({ tier: "small", output_tokens: 20_000, thread_id: "t3", id: 3 }),
    r({ id: 4, thread_id: "t1", action: "keep", tier: "xlarge", output_tokens: 5000 }), r({ id: 5, thread_id: "t4", action: "hold", tier: "xlarge", output_tokens: 5000, hold_origin_id: 9, cost_usd: 1 }),
  ]);
  it("lists each thread once across overkill, underkill and top origins", () => {
    expect(reviewThreadIds(rv).sort()).toEqual(["t1", "t2", "t3", "t4"]);
  });
  it("sets titles on matching entries without changing the input", () => {
    const out = withTitles(rv, { t1: "Fix login", t3: "Big refactor", t4: "Held thread", unknown: "x", toString: "nope" });
    expect(out.overkill.find((t) => t.threadId === "t1")!.threadTitle).toBe("Fix login");
    expect(out.overkill.find((t) => t.threadId === "t2")!.threadTitle).toBeUndefined();
    expect(out.underkill[0]!.threadTitle).toBe("Big refactor");
    expect(out.holds.topOrigins[0]!.threadTitle).toBe("Held thread");
    expect(rv.overkill.every((t) => t.threadTitle === undefined)).toBe(true);
  });
  it("prints the title after the thread id, and the id alone without one", () => {
    const text = formatReview(withTitles(rv, { t1: "Fix login" }));
    expect(text).toContain('thread t1 "Fix login"');
    expect(text).toMatch(/thread t2 xlarge/);
    expect(formatReview(rv)).not.toContain('"Fix login"');
  });
  it("ignores inherited property names as thread ids", () => {
    const odd = build([r({ tier: "large", output_tokens: 10, thread_id: "constructor" })]);
    expect(withTitles(odd, {}).overkill[0]!.threadTitle).toBeUndefined();
  });
});

describe("lower gear", () => {
  // Medium-tier rows by default: score 7 is mid-band, high confidence, big output, so nothing matches until a test sets it.
  const base = (o: Partial<DecisionRow> = {}): DecisionRow => r({ tier: "medium", score: 7, confidence: "high", output_tokens: 5000, routed_model: "sonnet", routed_effort: "high", routed_label: "Sonnet", cost_usd: 1, ...o });
  const lowerOf = (rows: DecisionRow[], policy = TIERED_POLICY) => buildReview(rows, policy, { days: 30, now: NOW }).lowerGear;

  it("is empty when nothing matches", () => {
    expect(lowerOf([base(), base({ tier: "trivial", score: 1, output_tokens: 10 })])).toEqual({ n: 0, costUsd: 0, shareOfCost: 0, byReason: [], turns: [] });
    expect(formatReview(build([base()]))).toContain("Lower gear would likely fit");
    expect(formatReview(build([base()]))).toMatch(/Lower gear would likely fit[^\n]*\n- none/);
  });

  describe("small-output", () => {
    it("flags tiers above trivial with output under the small threshold and suggests the next lower gear", () => {
      const lg = lowerOf([base({ tier: "large", score: 10, output_tokens: 100 }), base({ tier: "small", score: 4, output_tokens: SMALL_OUTPUT_TOKENS - 1 })]);
      expect(lg.turns.map((t) => [t.tier, t.reasons, t.suggestedGear]).sort()).toEqual([
        ["large", ["small-output"], "sonnet · high"],
        ["small", ["small-output"], "haiku · low"],
      ]);
    });
    it("skips trivial rows, rows at the threshold, rows without usage and unrouted rows", () => {
      const lg = lowerOf([
        base({ tier: "trivial", score: 1, output_tokens: 10 }), base({ output_tokens: SMALL_OUTPUT_TOKENS }), base({ output_tokens: null }),
        base({ action: "manual", output_tokens: 10 }), base({ action: "skip", tier: null, output_tokens: 10 }),
      ]);
      expect(lg.n).toBe(0);
    });
  });

  describe("held-above-tier", () => {
    const held = (o: Partial<DecisionRow> = {}) => base({ action: "hold", tier: "small", score: 4, routed_model: "claude-opus-5-5", routed_effort: "xhigh", ...o });
    it("flags a hold that ran on a bigger model than its own tier's gear and suggests that tier's gear", () => {
      const t = lowerOf([held()]).turns[0]!;
      expect(t).toMatchObject({ reasons: ["held-above-tier"], suggestedGear: "sonnet · medium", held: true });
    });
    it("on the same model, compares effort", () => {
      expect(lowerOf([base({ action: "hold", routed_model: "claude-sonnet-5-5", routed_effort: "xhigh" })]).turns[0]!.reasons).toEqual(["held-above-tier"]);
      expect(lowerOf([base({ action: "hold", routed_model: "claude-sonnet-5-5", routed_effort: "high" })]).n).toBe(0);
      expect(lowerOf([base({ action: "hold", routed_model: "claude-sonnet-5-5", routed_effort: null })]).n).toBe(0);
    });
    it("ignores a hold on a smaller or equal class than its gear", () => {
      expect(lowerOf([base({ action: "hold", tier: "large", score: 10, routed_model: "claude-sonnet-5-5", routed_effort: "high" })]).n).toBe(0);
      expect(lowerOf([base({ action: "hold", tier: "large", score: 10, routed_model: "claude-haiku-5-5", routed_effort: "low" })]).n).toBe(0);
    });
    it("covers gear, continuation and unknown hold kinds, not effort holds or other actions", () => {
      const n = (o: Partial<DecisionRow>) => lowerOf([held(o)]).n;
      expect([n({ hold_kind: "gear" }), n({ hold_kind: "continuation" }), n({ hold_kind: null }), n({})]).toEqual([1, 1, 1, 1]);
      expect(n({ hold_kind: "effort" })).toBe(0);
      expect(n({ action: "keep" })).toBe(0);
      expect(n({ routed_model: null })).toBe(0);
    });
    it("compares size classes for @-class specs and never counts @default", () => {
      const withSmall = (spec: string): typeof DEFAULT_POLICY => ({ ...TIERED_POLICY, gears: { ...TIERED_POLICY.gears, "*": { ...TIERED_POLICY.gears["*"], small: { model: spec, effort: "medium" } } } });
      const row = held({ provider_id: "other" });
      expect(lowerOf([row], withSmall("@small")).turns[0]!.suggestedGear).toBe("@small · medium");
      expect(lowerOf([row], withSmall("@large")).n).toBe(0);
      expect(lowerOf([row], withSmall("@default")).n).toBe(0);
    });
  });

  describe("borderline", () => {
    it("flags a score at the bottom of its band and suggests the next lower tier's gear", () => {
      const t = lowerOf([base({ score: DEFAULT_POLICY.tiers.medium.min })]).turns[0]!;
      expect(t).toMatchObject({ reasons: ["borderline"], suggestedGear: "sonnet · medium" });
      expect(lowerOf([base({ score: DEFAULT_POLICY.tiers.medium.min + 1 })]).n).toBe(0);
    });
    it("flags low confidence at any score", () => {
      expect(lowerOf([base({ confidence: "low" })]).turns[0]!.reasons).toEqual(["borderline"]);
    });
    it("cannot move the lowest tier lower", () => {
      expect(lowerOf([base({ tier: "trivial", score: 0, confidence: "low" })]).n).toBe(0);
    });
    it("leaves a row the bias already moved down, but still flags one whose scored tier matches", () => {
      const biased = base({ score: 6 }) as DecisionRow & { scored_tier?: string | null };
      biased.scored_tier = "large";
      expect(lowerOf([biased]).n).toBe(0);
      const same = base({ score: 6 }) as DecisionRow & { scored_tier?: string | null };
      same.scored_tier = "medium";
      expect(lowerOf([same]).n).toBe(1);
      const unset = base({ score: 6 }) as DecisionRow & { scored_tier?: string | null };
      unset.scored_tier = null;
      expect(lowerOf([unset]).n).toBe(1);
    });
  });

  describe("counting", () => {
    const all = () => base({ action: "hold", score: 6, confidence: "low", output_tokens: 100, routed_model: "claude-opus-5-5", routed_effort: "xhigh", cost_usd: 3 });
    it("counts a row once and lists every reason, preferring the lower tier's gear", () => {
      const lg = lowerOf([all(), base({ score: 6, cost_usd: 1 })]);
      expect(lg.n).toBe(2);
      expect(lg.costUsd).toBe(4);
      expect(lg.turns.find((t) => t.costUsd === 3)).toMatchObject({ reasons: ["small-output", "held-above-tier", "borderline"], suggestedGear: "sonnet · medium" });
      expect(lg.byReason).toEqual([
        { reason: "borderline", n: 2, costUsd: 4 }, { reason: "held-above-tier", n: 1, costUsd: 3 }, { reason: "small-output", n: 1, costUsd: 3 },
      ]);
    });
    it("reports the cost share of all routed cost", () => {
      const lg = lowerOf([base({ score: 6, cost_usd: 2 }), base({ cost_usd: 3 }), base({ cost_usd: 3 }), base({ action: "manual", cost_usd: 100 })]);
      expect(lg.shareOfCost).toBe(0.25);
      expect(lowerOf([base({ score: 6 })]).shareOfCost).toBe(1);
      expect(lowerOf([base({ score: 6, cost_usd: null })]).shareOfCost).toBe(0);
    });
    it("lists the newest first and caps the list while counting all", () => {
      const rows = Array.from({ length: 20 }, (_, i) => base({ id: 1000 + i, at: NOW - (20 - i) * 1000, score: 6 }));
      const lg = lowerOf(rows);
      expect(lg.n).toBe(20);
      expect(lg.turns).toHaveLength(15);
      expect(lg.turns[0]!.id).toBe(1019);
    });
  });

  describe("hint", () => {
    const hintOf = (rows: DecisionRow[]) => build(rows).hints.find((h) => h.id === "lower-gear");
    const pad = (k: number, cost: number) => many(k, { tier: "medium", score: 7, confidence: "high", output_tokens: 5000, cost_usd: cost });
    it("fires with enough rows and a cost share above 30%", () => {
      const rows = [...many(HINT_MIN_ROWS, { tier: "large", score: 10, output_tokens: 100, cost_usd: 2 }), ...pad(3, 2)];
      const h = hintOf(rows)!;
      expect(h.evidence).toMatchObject({ n: HINT_MIN_ROWS, shareOfCost: 0.625, topReason: "small-output", tier: "large" });
      expect(h.message).toMatch(/gears\.<provider>\.large\.effort/);
      expect(h.message).toContain("bb gearshift replay --set tiers.large.min=10");
    });
    it("stays quiet under the row minimum or at 30% of cost", () => {
      expect(hintOf([...many(HINT_MIN_ROWS - 1, { tier: "large", score: 10, output_tokens: 100, cost_usd: 5 }), ...pad(1, 1)])).toBeUndefined();
      expect(hintOf([...many(HINT_MIN_ROWS, { tier: "large", score: 10, output_tokens: 100, cost_usd: 3 }), ...pad(35, 1)])).toBeUndefined();
    });
    it("points at the lever for the top reason", () => {
      const heldRows = many(HINT_MIN_ROWS, { action: "hold", tier: "small", score: 4, output_tokens: 5000, routed_model: "claude-opus-5-5", routed_effort: "xhigh", cost_usd: 2 });
      expect(hintOf(heldRows)!.message).toMatch(/holdEffortFollowsMessage/);
      const edge = many(HINT_MIN_ROWS, { tier: "medium", score: 6, output_tokens: 5000, cost_usd: 2 });
      expect(hintOf(edge)!.message).toMatch(/downshiftBias.*tiers\.medium\.min.*replay --set tiers\.medium\.min=7/);
    });
  });

  describe("titles and format", () => {
    const rows = [base({ id: 1, thread_id: "tl", score: 6, cost_usd: 2 }), base({ id: 2, thread_id: "tm", action: "hold", tier: "small", score: 4, routed_model: "claude-opus-5-5", routed_effort: "xhigh", cost_usd: 1 })];
    const rv = buildReview(rows, TIERED_POLICY, { days: 30, now: NOW });
    it("lists lower-gear threads for title lookup and tags them", () => {
      expect(reviewThreadIds(rv).sort()).toEqual(["tl", "tm"]);
      const out = withTitles(rv, { tl: "Edge case", tm: "Held on big" });
      expect(out.lowerGear.turns.map((t) => t.threadTitle).sort()).toEqual(["Edge case", "Held on big"]);
      expect(rv.lowerGear.turns.every((t) => t.threadTitle === undefined)).toBe(true);
    });
    it("prints the summary, reasons and turns with the suggestion after the overkill and underkill lists", () => {
      const text = formatReview(withTitles(rv, { tl: "Edge case" }));
      expect(text.indexOf("Lower gear would likely fit")).toBeGreaterThan(text.indexOf("Possible underkill"));
      expect(text).toContain("- 2 messages, $3.00 (100% of cost)");
      expect(text).toContain("- reasons: borderline 1 ($2.00), held-above-tier 1 ($1.00)");
      expect(text).toMatch(/- #1 .* thread tl "Edge case" medium score 6 .* on Sonnet · High, output 5000, \$2\.00 → try sonnet · medium \(borderline\)/);
      expect(text).toMatch(/- #2 .* held, .* → try sonnet · medium \(held-above-tier\)/);
    });
  });
});
