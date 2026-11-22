import { describe, expect, it } from "vitest";
import { CLAUDE_CATALOG } from "./fixtures";
import { DEFAULT_POLICY, type Policy } from "./policy";
import { applyReplaySets, formatReplay, parseReplaySet, replayDecisions, type Replay } from "./replay";
import type { DecisionRow } from "./store";

const NOW = Date.UTC(2026, 10, 20, 12);
const DAY = 86_400_000;
const OPUS = "claude-opus-5-5", SONNET = "claude-sonnet-5-5";
let n = 0;
/** A routed Sonnet medium decision for a small message; override what the test cares about. */
const r = (o: Partial<DecisionRow> = {}): DecisionRow => ({
  id: ++n, at: NOW - 5 * DAY + n * 60_000, thread_id: "t1", project_id: null, provider_id: "claude-code", initiator: "user", attempt: "start-turn", action: "shift", reason: "",
  tier: "small", score: 4, confidence: "high", signals: "[]", chars: 1, fingerprint: null, requested_model: OPUS, requested_effort: "xhigh", routed_model: SONNET,
  routed_effort: "medium", routed_label: "Sonnet 5.5", routed_service_tier: null, baseline_model: OPUS, context_tokens: null, latency_ms: null, queued_message_id: null,
  amend_status: null, turn_id: null, input_tokens: null, output_tokens: null, cache_read_tokens: null, cache_write_tokens: null, cost_usd: null, baseline_cost_usd: null, ...o,
});
const many = (k: number, o: Partial<DecisionRow> | ((i: number) => Partial<DecisionRow>)) => Array.from({ length: k }, (_, i) => r(typeof o === "function" ? o(i) : o));
const catalogs = { "claude-code": CLAUDE_CATALOG };
const replay = (rows: DecisionRow[], policy: Policy = DEFAULT_POLICY, extra: { catalogs?: Record<string, typeof CLAUDE_CATALOG | null>; days?: number; edits?: string[] } = {}): Replay =>
  replayDecisions(rows, policy, { days: extra.days ?? 30, now: NOW, catalogs: extra.catalogs ?? catalogs, edits: extra.edits });
const edit = (...sets: string[]): Policy => {
  const res = applyReplaySets(DEFAULT_POLICY, DEFAULT_POLICY, sets.map((s) => parseReplaySet(s) as { path: string; value: string }));
  if ("error" in res) throw new Error(res.error);
  return res.policy;
};
/** A held message on a long Opus xhigh thread: recorded under the old rule (whole gear kept). */
const held = (o: Partial<DecisionRow> = {}): Partial<DecisionRow> => ({
  action: "hold", hold_kind: "gear", tier: "small", score: 4, routed_model: OPUS, routed_label: "Opus 5.5", routed_effort: "xhigh",
  current_model: OPUS, current_effort: "xhigh", context_tokens: 100_000, ...o,
});
/** Turns on a model the user asked for by name: never replayed, but they count towards the output averages. */
const samples = (effort: string, output: number, k = 5) => many(k, (i) => ({
  thread_id: `sample-${effort}-${i}`, action: "keep", reason: "You asked for Opus 5.5", routed_model: OPUS, routed_label: "Opus 5.5", routed_effort: effort,
  output_tokens: output, input_tokens: 1000, cache_read_tokens: 0, cache_write_tokens: 0, cost_usd: 0.1,
}));

describe("re-banding", () => {
  const rows = many(3, (i) => ({ thread_id: `t${i}`, score: 4, tier: "small", cost_usd: 0.5, input_tokens: 10, output_tokens: 10 }));
  // Score 5 stays inside medium (4-8) when small shrinks to 3-3: score 4 would be medium's bottom point and lean back down.
  const mid = many(3, (i) => ({ thread_id: `t${i}`, score: 5, tier: "small", cost_usd: 0.5, input_tokens: 10, output_tokens: 10 }));
  it("is a no-op under the default policy for rows recorded under it", () => {
    const rp = replay(rows);
    expect(rp.rows).toBe(3);
    expect(rp.changes.tierMoves).toBe(0);
    expect(rp.delta.costUsd).toBe(0);
    expect(rp.after.tiers).toEqual(rp.before.tiers);
  });
  it("re-tiers recorded scores under --set tiers.*", () => {
    const rp = replay(mid, edit("tiers.small.max=3"));
    expect(rp.before.tiers).toEqual([{ tier: "small", n: 3, share: 1 }]);
    expect(rp.after.tiers).toEqual([{ tier: "medium", n: 3, share: 1 }]);
    expect(rp.changes.tierMoves).toBe(3);
    expect(rp.after.gears[0]!.gear).toBe("Sonnet 5.5 · High");
    expect(rp.changes.effortHigher).toBe(3);
  });
  it("keeps the tier of a row with no score", () => {
    const rp = replay([r({ score: null, tier: "large" })], edit("tiers.small.max=3"));
    expect(rp.after.tiers.map((t) => t.tier)).toEqual(["large"]);
  });
  it("ignores rows outside the window, join-turn rows and unrouted actions", () => {
    const rp = replay([r(), r({ at: NOW - 40 * DAY }), r({ attempt: "join-turn", action: "skip", tier: null }), r({ action: "manual", tier: "small" }), r({ action: "skip", tier: null })], DEFAULT_POLICY, { days: 7 });
    expect(rp.rows).toBe(1);
  });
});

describe("holds", () => {
  it("lowers the effort of a held Opus xhigh message to its own tier and estimates a lower cost", () => {
    // Opus 5.5: $4 in, $20 out, $0.2 cache read per million. 1k + 2k out + 99k read = $0.0638 before.
    const rows = [...samples("xhigh", 4000), ...samples("medium", 1000),
      r(held({ input_tokens: 1000, output_tokens: 2000, cache_read_tokens: 99_000, cache_write_tokens: 0, cost_usd: 0.0638 }))];
    const rp = replay(rows);
    expect(rp.changes.holdKinds).toEqual({ effort: 1 });
    expect(rp.changes.effortLower).toBe(1);
    expect(rp.changes.modelChanges).toBe(0);
    expect(rp.after.gears.map((g) => g.gear)).toContain("Opus 5.5 · Medium");
    // Output scales by the window's own averages for Opus: medium 1000, xhigh (5 samples of 4000 and this turn's 2000) 3667.
    // 2000 → 545 tokens, so 1k in + 545 out + 99k read = $0.0347.
    expect(rp.delta.costUsd).toBeCloseTo(0.0347 - 0.0638, 4);
    expect(rp.effortUnestimated).toBe(0);
    expect(rp.before.held).toBe(1);
    expect(rp.after.held).toBe(1);
    expect(rp.notReplayed).toEqual({ "model named in the message": 10 });
  });
  it("leaves output unchanged, and says so, with fewer than five samples", () => {
    const rows = [...samples("xhigh", 4000, 4), ...samples("medium", 1000, 4),
      r(held({ input_tokens: 1000, output_tokens: 2000, cache_read_tokens: 99_000, cache_write_tokens: 0, cost_usd: 0.0638 }))];
    const rp = replay(rows);
    expect(rp.changes.effortLower).toBe(1);
    expect(rp.effortUnestimated).toBe(1);
    expect(rp.delta.costUsd).toBe(0);
    expect(formatReplay(rp)).toMatch(/1 effort changes had too little data/);
  });
  it("keeps the whole gear when holdEffortFollowsMessage is off", () => {
    const rp = replay([r(held({ input_tokens: 1, output_tokens: 1, cost_usd: 1 }))], edit("routing.holdEffortFollowsMessage=false"));
    expect(rp.changes.holdKinds).toEqual({ gear: 1 });
    expect(rp.changes.effortLower).toBe(0);
    expect(rp.delta.costUsd).toBe(0);
  });
  it("stops holding when holdAboveTokens is raised above the context", () => {
    const rp = replay([r(held())], edit("routing.holdAboveTokens=200000"));
    expect(rp.before.held).toBe(1);
    expect(rp.after.held).toBe(0);
    expect(rp.after.gears[0]!.gear).toBe("Sonnet 5.5 · Medium");
  });
  it("prices cached context as cache writes when a held trivial message moves model", () => {
    // Haiku 5.5: $0.1 in, $0.5 out, cache write $0.125 per million. 1k in + 500 out + 99k written = $0.012725.
    const rp = replay([r(held({ tier: "trivial", score: 1, input_tokens: 1000, output_tokens: 500, cache_read_tokens: 99_000, cache_write_tokens: 0, cost_usd: 0.0638 }))]);
    expect(rp.changes.holdKinds).toEqual({ downshift: 1 });
    expect(rp.changes.modelChanges).toBe(1);
    expect(rp.after.held).toBe(0);
    expect(rp.after.gears[0]!.gear).toBe("Haiku 5.5 · Low");
    expect(rp.after.costUsd).toBeCloseTo(0.0127, 4); // reads would be $0.0013
  });
  it("reads the gear a thread was on from rows before the window", () => {
    const rows = [r({ at: NOW - 60 * DAY, routed_model: OPUS, routed_label: "Opus 5.5", routed_effort: "xhigh", tier: "xlarge", score: 13 }),
      r(held({ current_model: null, current_effort: null, action: "shift", hold_kind: null }))];
    const rp = replay(rows, DEFAULT_POLICY, { days: 7 });
    expect(rp.rows).toBe(1);
    expect(rp.changes.holdKinds).toEqual({ effort: 1 });
  });
  it("uses the gear the replay gave the previous message, not the recorded one", () => {
    const rows = [r({ tier: "xlarge", score: 13, routed_model: OPUS, routed_label: "Opus 5.5", routed_effort: "xhigh" }),
      r({ action: "hold", hold_kind: "gear", tier: "large", score: 10, routed_model: OPUS, routed_label: "Opus 5.5", routed_effort: "xhigh", context_tokens: 100_000, current_model: OPUS, current_effort: "xhigh" })];
    const rp = replay(rows, edit("gears.claude-code.xlarge.effort=medium"));
    // The first message now runs Opus medium, so the held one has nothing higher to keep: it runs the large gear.
    expect(rp.after.gears.map((g) => g.gear).sort()).toEqual(["Opus 5.5 · High", "Opus 5.5 · Medium"]);
  });
});

describe("continuation", () => {
  it("keeps the thread's replayed gear, not the recorded one", () => {
    const rows = [
      r({ tier: "xlarge", score: 13, routed_model: OPUS, routed_label: "Opus 5.5", routed_effort: "xhigh" }),
      r({ action: "hold", hold_kind: "continuation", reason: "Continuing on Opus 5.5", tier: "trivial", score: 1, routed_model: OPUS, routed_label: "Opus 5.5", routed_effort: "xhigh",
        current_model: OPUS, current_effort: "xhigh", context_tokens: 100_000 }),
    ];
    const rp = replay(rows, edit("gears.claude-code.xlarge.effort=high"));
    expect(rp.after.gears).toEqual([{ gear: "Opus 5.5 · High", n: 2, costUsd: 0 }]);
    expect(rp.changes.holdKinds).toEqual({ continuation: 1 });
    expect(rp.before.held).toBe(1);
    expect(rp.after.held).toBe(1);
  });
  it("is recognised from an old row's reason when it has no hold kind", () => {
    const rp = replay([r({ action: "hold", reason: "Continuing on Opus 5.5", tier: "trivial", score: 1, routed_model: OPUS, routed_label: "Opus 5.5", routed_effort: "xhigh", current_model: OPUS, current_effort: "xhigh", requested_model: SONNET, requested_effort: "medium" })]);
    expect(rp.changes.holdKinds).toEqual({ continuation: 1 });
    expect(rp.after.gears[0]!.gear).toBe("Opus 5.5 · XHigh");
  });
});

describe("what cannot be replayed", () => {
  it("counts a provider without a catalog as not replayed and keeps its cost", () => {
    const rows = [r({ provider_id: "other", score: 5, cost_usd: 0.5, input_tokens: 10, output_tokens: 10 }), r({ provider_id: "gone", score: 5, cost_usd: 0.25 })];
    const rp = replay(rows, edit("tiers.small.max=3"), { catalogs: { other: null, ...catalogs } });
    expect(rp.rows).toBe(2);
    expect(rp.replayed).toBe(0);
    expect(rp.notReplayed).toEqual({ "no model list for other": 1, "no model list for gone": 1 });
    expect(rp.before.costUsd).toBe(0.75);
    expect(rp.after.costUsd).toBe(0.75);
    expect(rp.after.gears).toEqual([{ gear: "Sonnet 5.5 · Medium", n: 2, costUsd: 0.75 }]);
    expect(rp.after.tiers[0]!.tier).toBe("medium"); // bands still apply to the score
  });
  it("keeps a model the message named", () => {
    const rp = replay([r({ reason: "You asked for Haiku 5.5", routed_model: "claude-haiku-5-5", routed_label: "Haiku 5.5", routed_effort: "low" })], edit("gears.claude-code.small.effort=high"));
    expect(rp.notReplayed).toEqual({ "model named in the message": 1 });
    expect(rp.after.gears[0]!.gear).toBe("Haiku 5.5 · Low");
  });
  it("prices turns moved to an unpriced model at their recorded cost and says so", () => {
    const policy: Policy = { ...edit("gears.claude-code.small.model=acme-mystery"), prices: {} };
    const cat = [...CLAUDE_CATALOG, { id: "acme-mystery", displayName: "Mystery", isDefault: false, efforts: ["medium"], defaultEffort: "medium", serviceTiers: [] }];
    const rp = replay([r({ cost_usd: 0.5, input_tokens: 10, output_tokens: 10 })], policy, { catalogs: { "claude-code": cat } });
    expect(rp.changes.modelChanges).toBe(1);
    expect(rp.unpriced).toBe(1);
    expect(rp.delta.costUsd).toBe(0);
    expect(formatReplay(rp)).toMatch(/1 turns moved to a model with no price/);
  });
});

describe("applyReplaySets", () => {
  const apply = (...sets: string[]) => applyReplaySets(DEFAULT_POLICY, DEFAULT_POLICY, sets.map((s) => parseReplaySet(s) as { path: string; value: string }));
  it("sets the routing switches a replay can try", () => {
    const res = apply("routing.holdAboveTokens=30000", "routing.holdEffortFollowsMessage=off");
    expect("policy" in res && res.policy.routing).toMatchObject({ holdAboveTokens: 30000, holdEffortFollowsMessage: false });
    const on = apply("routing.holdEffortFollowsMessage=yes");
    expect("policy" in on && on.policy.routing.holdEffortFollowsMessage).toBe(true);
  });
  it("sets routing.downshiftBias", () => {
    const off = apply("routing.downshiftBias=false");
    expect("policy" in off && off.policy.routing.downshiftBias).toBe(false);
    const on = apply("routing.downshiftBias=false", "routing.downshiftBias=on");
    expect("policy" in on && on.policy.routing.downshiftBias).toBe(true);
    expect(apply("routing.downshiftBias=maybe")).toEqual({ error: expect.stringMatching(/routing\.downshiftBias takes true or false/) });
  });
  it("rejects bad values for them", () => {
    for (const v of ["", "-1", "1.5", "lots"]) expect(apply(`routing.holdAboveTokens=${v}`)).toEqual({ error: expect.stringMatching(/routing\.holdAboveTokens takes a whole number/) });
    expect(apply("routing.holdEffortFollowsMessage=maybe")).toEqual({ error: expect.stringMatching(/takes true or false/) });
  });
  it("rejects other routing paths", () => {
    expect(apply("routing.routeNotes=false")).toEqual({ error: expect.stringMatching(/not replayable/) });
  });
  it("delegates policy paths to the policy editor and surfaces its error", () => {
    const ok = apply("tiers.small.max=3");
    expect("policy" in ok && ok.policy.tiers.medium.min).toBe(4);
    const bad = apply("scoring.nope=3");
    expect(bad).toEqual({ error: expect.stringMatching(/Unknown path "scoring\.nope"/) });
    expect(apply("tiers.small.max=abc")).toEqual({ error: expect.stringMatching(/takes a number/) });
  });
  it("does not change the policy it was given", () => {
    const before = JSON.stringify(DEFAULT_POLICY);
    apply("routing.holdAboveTokens=1", "tiers.small.max=3");
    expect(JSON.stringify(DEFAULT_POLICY)).toBe(before);
  });
});

describe("parseReplaySet", () => {
  it("splits at the first =", () => {
    expect(parseReplaySet("tiers.small.max=3")).toEqual({ path: "tiers.small.max", value: "3" });
    expect(parseReplaySet("explicitModel.pattern=a=b")).toEqual({ path: "explicitModel.pattern", value: "a=b" });
    expect(parseReplaySet("routing.holdAboveTokens=")).toEqual({ path: "routing.holdAboveTokens", value: "" });
  });
  it("rejects a missing path or =", () => {
    expect(parseReplaySet("tiers.small.max")).toEqual({ error: expect.stringMatching(/path=value/) });
    expect(parseReplaySet("=3")).toEqual({ error: expect.stringMatching(/path=value/) });
  });
});

describe("formatReplay", () => {
  it("renders tier shares, the cost delta, hold counts and what is estimated", () => {
    const rows = many(4, (i) => ({ thread_id: `t${i}`, score: 5, cost_usd: 2, input_tokens: 1_000_000, output_tokens: 0 }));
    const text = formatReplay(replay(rows, edit("tiers.small.max=3"), { edits: ["tiers.small.max=3"] }));
    expect(text).toMatch(/Gearshift replay: last 30 days/);
    expect(text).toMatch(/Under the current policy with: tiers\.small\.max=3/);
    expect(text).toMatch(/- Small: 4 \(100%\) → 0 \(0%\)/);
    expect(text).toMatch(/- Medium: 0 \(0%\) → 4 \(100%\)/);
    expect(text).toMatch(/Cost \(estimated\)\n- before \$8\.00 → after \$8\.00: \$0\.00/);
    expect(text).toMatch(/- held: 0 → 0/);
    expect(text).toMatch(/4 tier moves/);
    expect(text).toMatch(/What is estimated\n- Messages are not stored/);
    expect(text).toMatch(/Sonnet 5\.5 · High: 4 messages/);
  });
  it("shows a signed percentage when the cost moves", () => {
    const rp = replay([...samples("xhigh", 4000), ...samples("medium", 1000), r(held({ input_tokens: 1000, output_tokens: 2000, cache_read_tokens: 99_000, cache_write_tokens: 0, cost_usd: 0.0638 }))]);
    expect(formatReplay(rp)).toMatch(/: -\$0\.03 \(-/);
  });
  it("says so when there is nothing to replay", () => {
    expect(formatReplay(replay([]))).toMatch(/No routed messages in this period/);
  });
  it("names the current rule when nothing is edited", () => {
    expect(formatReplay(replay([r()]))).toMatch(/Under the current policy \(and the current hold rule\)/);
  });
});

describe("downshift bias", () => {
  const T = DEFAULT_POLICY.tiers;
  const off = (): Policy => edit("routing.downshiftBias=false");
  /** A large message at the bottom of its band, recorded before the bias existed (tier = scored tier). */
  const bottom = (o: Partial<DecisionRow> = {}) => r({ tier: "large", score: T.large.min, confidence: "high", routed_model: OPUS, routed_label: "Opus 5.5", routed_effort: "high", ...o });

  it("moves a row at the bottom of its band one tier lower, from the recorded score", () => {
    const rp = replay([bottom()]);
    expect(rp.before.tiers).toEqual([{ tier: "large", n: 1, share: 1 }]);
    expect(rp.after.tiers).toEqual([{ tier: "medium", n: 1, share: 1 }]);
    expect(rp.changes.tierMoves).toBe(1);
    expect(rp.after.gears[0]!.gear).toBe("Sonnet 5.5 · High");
  });
  it("moves a low-confidence row mid-band, and ignores a null or unknown confidence", () => {
    const mid = T.large.min + 1;
    expect(replay([bottom({ score: mid, confidence: "low" })]).after.tiers[0]!.tier).toBe("medium");
    expect(replay([bottom({ score: mid, confidence: "high" })]).after.tiers[0]!.tier).toBe("large");
    expect(replay([bottom({ score: mid, confidence: null })]).after.tiers[0]!.tier).toBe("large");
    expect(replay([bottom({ score: mid, confidence: "weird" })]).after.tiers[0]!.tier).toBe("large");
  });
  it("moves at most one tier and never moves trivial", () => {
    expect(replay([bottom({ confidence: "low" })]).after.tiers[0]!.tier).toBe("medium");
    expect(replay([r({ tier: "trivial", score: 0, confidence: "low", routed_model: "claude-haiku-5-5", routed_label: "Haiku 5.5", routed_effort: "low" })]).after.tiers[0]!.tier).toBe("trivial");
  });
  it("does not bias twice: a row recorded with the bias already carries the lower tier", () => {
    // Recorded after the change: tier is the biased one (medium), scored_tier the one the score gave (large).
    const rp = replay([bottom({ tier: "medium", scored_tier: "large", routed_model: SONNET, routed_label: "Sonnet 5.5", routed_effort: "high" })]);
    expect(rp.before.tiers).toEqual([{ tier: "medium", n: 1, share: 1 }]);
    expect(rp.after.tiers).toEqual([{ tier: "medium", n: 1, share: 1 }]);
    expect(rp.changes.tierMoves).toBe(0);
    expect(rp.lowerGear.n).toBe(0);
  });
  it("--set routing.downshiftBias=false puts the row back on its scored tier", () => {
    const rp = replay([bottom({ tier: "medium", scored_tier: "large", routed_model: SONNET, routed_label: "Sonnet 5.5", routed_effort: "high" })], off(), { edits: ["routing.downshiftBias=false"] });
    expect(rp.after.tiers).toEqual([{ tier: "large", n: 1, share: 1 }]);
    expect(rp.changes.tierMoves).toBe(1);
    expect(rp.after.gears[0]!.gear).toBe("Opus 5.5 · High");
    expect(rp.lowerGear.n).toBe(0);
  });
  it("replays the bias through a hold and never upshifts", () => {
    const thread = { thread_id: "held", context_tokens: 100_000, current_model: OPUS, current_effort: "xhigh" };
    const rp = replay([bottom({ ...thread, action: "hold", hold_kind: "gear", routed_effort: "xhigh" })]);
    expect(rp.after.tiers[0]!.tier).toBe("medium");
    expect(rp.after.gears.map((g) => g.gear)).toEqual(["Opus 5.5 · High"]); // medium's effort on the held model, down from xhigh
  });

  describe("lower gear", () => {
    const priced = { input_tokens: 1_000_000, output_tokens: 0, cost_usd: 4 };
    it("counts turns that run on a lower gear than they recorded, with cost and the top turns", () => {
      const rows = [bottom({ thread_id: "a", ...priced }), bottom({ thread_id: "b", ...priced, cost_usd: 8, input_tokens: 2_000_000 }), r({ thread_id: "c", score: 4, cost_usd: 1, input_tokens: 10, output_tokens: 10 })];
      const rp = replay(rows);
      expect(rp.lowerGear.n).toBe(2);
      expect(rp.lowerGear.costBefore).toBe(12);
      expect(rp.lowerGear.costAfter).toBeLessThan(12);
      expect(rp.lowerGear.top.map((t) => t.threadId)).toEqual(["b", "a"]); // biggest saving first
      expect(rp.lowerGear.top[0]).toMatchObject({ tierBefore: "large", tierAfter: "medium", gearBefore: "Opus 5.5 · High", gearAfter: "Sonnet 5.5 · High", costBefore: 8 });
      const text = formatReplay(rp);
      expect(text).toMatch(/Lower gear: 2 turns run on a lower gear than they recorded, \$12\.00 → \$/);
      expect(text).toMatch(/- #\d+ b: Large → Medium, Opus 5\.5 · High → Sonnet 5\.5 · High, \$8\.00 → \$/);
    });
    it("counts the same model on a lower effort", () => {
      // Medium tier gear is Sonnet at the default effort; a recorded Sonnet xhigh turn drops to it.
      const rp = replay([r({ tier: "medium", score: 7, routed_effort: "xhigh", cost_usd: 1, input_tokens: 10, output_tokens: 10 })]);
      expect(rp.lowerGear.n).toBe(1);
      expect(rp.lowerGear.top[0]).toMatchObject({ gearBefore: "Sonnet 5.5 · XHigh", gearAfter: "Sonnet 5.5 · High" });
    });
    it("does not count a higher or an unchanged gear, nor anything with the bias off", () => {
      expect(replay([r()]).lowerGear.n).toBe(0);
      expect(replay([r({ tier: "small", score: 4, routed_effort: "low" })]).lowerGear.n).toBe(0); // low → medium is higher
      expect(replay([bottom()], off()).lowerGear.n).toBe(0);
    });
    it("lists at most ten turns but counts them all", () => {
      const rp = replay(many(12, (i) => ({ ...bottom({ thread_id: `t${i}` }) })));
      expect(rp.lowerGear.n).toBe(12);
      expect(rp.lowerGear.top).toHaveLength(10);
      expect(formatReplay(rp)).toMatch(/…and 2 more/);
    });
    it("says so when nothing runs lower, and notes how the bias is replayed", () => {
      const text = formatReplay(replay([r()]));
      expect(text).toMatch(/Lower gear: no turn runs on a lower gear/);
      expect(text).toMatch(/downshift bias is replayed from that score and the stored confidence/);
    });
  });
});
