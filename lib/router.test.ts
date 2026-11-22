import { describe, expect, it } from "vitest";
import { biasTier, decide, switchSaves, type DecideInput } from "./router";
import { classify } from "./classify";
import { CLAUDE_CATALOG, compiledDefault, compiledWith } from "./fixtures";

// The existing rules are tested with the downshift bias off so each keeps testing what it names; the bias has its own block below.
const NO_BIAS = { routing: { downshiftBias: false } };
const unbiased = compiledWith(NO_BIAS);
const base = (o: Partial<DecideInput> = {}): DecideInput => ({
  enabled: true, text: "fix the typo in the README", providerId: "claude-code", attempt: "start-turn", initiator: "user",
  requested: { model: "claude-opus-5-5", effort: "high" }, modelSource: null, current: null, contextTokens: null,
  catalog: CLAUDE_CATALOG, policy: unbiased, ...o,
});
const BIG_BUILD = "build a plugin with a composer toggle, an analytics page and a settings editor, with tests and a PR";

describe("rules in order", () => {
  it("0: skip patterns win over everything, even off", () => {
    const d = decide(base({ text: "<system-reminder>x", enabled: false }));
    expect(d).toMatchObject({ action: "skip", reason: "System message", needsAmend: false });
  });
  it("1: off", () => {
    expect(decide(base({ enabled: false }))).toMatchObject({ action: "off", reason: "Gearshift is off for this thread" });
  });
  it("2: join-turn", () => expect(decide(base({ attempt: "join-turn" })).action).toBe("skip"));
  it("3: system retry", () => expect(decide(base({ initiator: "system" })).action).toBe("skip"));
  it("4: agent messages follow the policy switch", () => {
    expect(decide(base({ initiator: "agent" })).action).toBe("shift");
    const off = compiledWith({ routing: { routeAgentMessages: false } });
    expect(decide(base({ initiator: "agent", policy: off })).action).toBe("skip");
    expect(decide(base({ initiator: "user", policy: off })).action).toBe("shift");
  });
  it("5: no catalog", () => {
    expect(decide(base({ catalog: null }))).toMatchObject({ action: "skip", reason: "Model list unavailable for claude-code" });
    expect(decide(base({ catalog: [] })).action).toBe("skip");
  });
  it("6: a named family wins, over a manual pick too", () => {
    const d = decide(base({ text: "use haiku for this", modelSource: "explicit" }));
    expect(d).toMatchObject({ action: "shift", reason: "You asked for Haiku 5.5", needsAmend: true });
    expect(d.gear!.model).toBe("claude-haiku-5-5");
    expect(decide(base({ text: "use opus please", requested: { model: "claude-opus-5-5", effort: "high" } })).action).toBe("keep");
  });
  it("6: an unknown family falls through", () => {
    expect(decide(base({ text: "use gemini to fix the typo" })).action).toBe("shift");
  });
  it("7: manual picks, unless the policy says otherwise", () => {
    expect(decide(base({ modelSource: "explicit" }))).toMatchObject({ action: "manual", gear: null, needsAmend: false });
    expect(decide(base({ modelSource: "client-preference" })).action).toBe("shift");
    const ignore = compiledWith({ routing: { respectManualPicks: false } });
    expect(decide(base({ modelSource: "explicit", policy: ignore })).action).toBe("shift");
  });
  it("8: continuation holds the current gear", () => {
    const cur = { model: "claude-sonnet-5-5", effort: "high" };
    const d = decide(base({ text: "go ahead", current: cur }));
    expect(d).toMatchObject({ action: "hold", reason: "Continuing on Sonnet 5.5", needsAmend: true });
    expect(d.gear).toMatchObject({ model: "claude-sonnet-5-5", effort: "high" });
    const same = decide(base({ text: "go ahead", current: cur, requested: cur }));
    expect(same).toMatchObject({ action: "keep", needsAmend: false });
  });
  it("8: continuation on a fresh thread routes by tier", () => {
    expect(decide(base({ text: "continue", current: null })).tier).toBe("small");
  });
  it("9: an unresolvable gear skips", () => {
    const only = CLAUDE_CATALOG.filter((m) => m.id.includes("opus"));
    expect(decide(base({ text: "thanks", catalog: only }))).toMatchObject({ action: "skip", reason: "No model for trivial on claude-code" });
  });
  it("11: keep when already on the tier's gear", () => {
    const d = decide(base({ text: BIG_BUILD, requested: { model: "claude-opus-5-5", effort: "xhigh" } }));
    expect(d).toMatchObject({ action: "keep", tier: "xlarge", needsAmend: false });
  });
  it("12: shift with a reason naming tier, signals and gear", () => {
    const d = decide(base());
    expect(d).toMatchObject({ action: "shift", tier: "small", needsAmend: true });
    expect(d.gear).toMatchObject({ model: "claude-sonnet-5-5", effort: "medium" });
    expect(d.reason).toBe("Small task (change) → Sonnet 5.5 · Medium");
  });
  it("12: the reason uses the same tier and effort labels as the UI", () => {
    const d = decide(base({ text: BIG_BUILD }));
    expect(d.reason).toMatch(/^X-large task \(.+\) → Opus 5\.5 · XHigh$/);
  });
});

describe("rule 10: hold above tokens", () => {
  const opusHigh = { model: "claude-opus-5-5", effort: "high" };
  const opusXhigh = { model: "claude-opus-5-5", effort: "xhigh" };
  const gearOnly = compiledWith({ routing: { holdEffortFollowsMessage: false } });
  it("keeps the model but lowers the effort to the message's own tier", () => {
    const d = decide(base({ text: "thanks", current: opusHigh, contextTokens: 120_000, requested: opusHigh }));
    expect(d).toMatchObject({ action: "hold", holdKind: "effort", needsAmend: true });
    expect(d.gear).toMatchObject({ model: "claude-opus-5-5", effort: "low" });
    expect(d.reason).toBe("Holding Opus 5.5, effort High → Low for a trivial task: a 120k-token context would be re-read uncached on another model");
  });
  it("keeps the whole gear when holdEffortFollowsMessage is off", () => {
    const d = decide(base({ text: "thanks", current: opusHigh, contextTokens: 120_000, requested: { model: "claude-sonnet-5-5", effort: "medium" }, policy: gearOnly }));
    expect(d).toMatchObject({ action: "hold", holdKind: "gear", needsAmend: true });
    expect(d.gear).toMatchObject({ model: "claude-opus-5-5", effort: "high" });
    expect(d.reason).toBe("Holding Opus 5.5: a 120k-token context would be re-read uncached");
  });
  it("hold needs no amend when the request already is the held gear", () => {
    expect(decide(base({ text: "thanks", current: opusHigh, contextTokens: 120_000, requested: opusHigh, policy: gearOnly }))).toMatchObject({ action: "hold", needsAmend: false });
    const low = { model: "claude-opus-5-5", effort: "low" };
    expect(decide(base({ text: "thanks", current: opusHigh, contextTokens: 120_000, requested: low }))).toMatchObject({ action: "hold", holdKind: "effort", needsAmend: false });
  });
  it("evaluates every held message on its own: a large one keeps Opus at the large effort", () => {
    const d = decide(base({ text: "redesign the plugin", current: opusXhigh, contextTokens: 355_000, requested: opusXhigh }));
    expect(d).toMatchObject({ action: "hold", holdKind: "effort", tier: "large" });
    expect(d.gear).toMatchObject({ model: "claude-opus-5-5", effort: "high" });
  });
  it("a small message on a held Opus thread stays on Opus when switching costs more", () => {
    const d = decide(base({ current: opusXhigh, contextTokens: 355_000, requested: opusXhigh }));
    expect(d).toMatchObject({ action: "hold", holdKind: "effort", tier: "small" });
    expect(d.gear).toMatchObject({ model: "claude-opus-5-5", effort: "medium" });
  });
  it("never raises the effort through a hold", () => {
    const opusLow = { model: "claude-opus-5-5", effort: "low" };
    const d = decide(base({ current: opusLow, contextTokens: 355_000, requested: opusLow }));
    expect(d).toMatchObject({ action: "hold", holdKind: "gear", needsAmend: false });
    expect(d.gear!.effort).toBe("low");
  });
  it("large and x-large never drop below medium effort under a hold", () => {
    const p = compiledWith({ ...NO_BIAS, gears: { "claude-code": { large: { model: "opus", effort: "low" } } } });
    const d = decide(base({ text: "redesign the plugin", current: opusXhigh, contextTokens: 355_000, requested: opusXhigh, policy: p }));
    expect(d).toMatchObject({ action: "hold", holdKind: "effort" });
    expect(d.gear!.effort).toBe("medium");
  });
  it("a trivial message moves to the cheaper model when that beats holding, re-read included", () => {
    // 80k on Haiku 5.5 (under its 100k long-context band) costs less to write than Opus costs to read plus Opus output.
    const d = decide(base({ text: "thanks", current: opusHigh, contextTokens: 80_000, requested: opusHigh }));
    expect(d).toMatchObject({ action: "shift", holdKind: "downshift", needsAmend: true });
    expect(d.gear!.model).toBe("claude-haiku-5-5");
    expect(d.reason).toContain("cheaper than holding Opus 5.5 even with the 80k-token context re-read uncached");
  });
  it("continuations keep the whole gear", () => {
    const d = decide(base({ text: "go ahead", current: opusXhigh, contextTokens: 355_000, requested: { model: "claude-sonnet-5-5", effort: "medium" } }));
    expect(d).toMatchObject({ action: "hold", holdKind: "continuation" });
    expect(d.gear).toMatchObject({ model: "claude-opus-5-5", effort: "xhigh" });
  });
  it("downshifts below the threshold", () => {
    const d = decide(base({ text: "thanks", current: opusHigh, contextTokens: 10_000 }));
    expect(d).toMatchObject({ action: "shift", holdKind: null });
    expect(d.gear!.model).toBe("claude-haiku-5-5");
  });
  it("always upshifts", () => {
    const cur = { model: "claude-haiku-5-5", effort: "low" };
    const d = decide(base({ text: BIG_BUILD, current: cur, contextTokens: 500_000, requested: cur }));
    expect(d.action).toBe("shift");
    expect(d.gear!.model).toBe("claude-opus-5-5");
  });
  it("0 disables holding; the threshold is configurable", () => {
    const off = compiledWith({ routing: { holdAboveTokens: 0 } });
    expect(decide(base({ text: "thanks", current: opusHigh, contextTokens: 900_000, policy: off }))).toMatchObject({ action: "shift", holdKind: null });
    const low = compiledWith({ routing: { holdAboveTokens: 1000 } });
    expect(decide(base({ current: opusHigh, contextTokens: 1000, policy: low })).holdKind).toBe("downshift"); // a tiny context is cheap to re-read
    expect(decide(base({ current: opusHigh, contextTokens: 999, policy: low })).holdKind).toBe(null);
  });
  it("needs a current gear and a known context size", () => {
    expect(decide(base({ text: "thanks", current: null, contextTokens: 900_000 })).action).toBe("shift");
    expect(decide(base({ text: "thanks", current: opusHigh, contextTokens: null })).action).toBe("shift");
  });
});

describe("switchSaves", () => {
  const p = compiledDefault.policy;
  const opus = { model: "claude-opus-5-5", effort: "high" };
  it("prices the uncached write on the new model against a cached read on the old one", () => {
    expect(switchSaves(p, opus, { model: "claude-haiku-5-5", serviceTier: null }, 80_000)).toBe(true);
    expect(switchSaves(p, opus, { model: "claude-haiku-5-5", serviceTier: null }, 355_000)).toBe(false); // Haiku's long-context rates
    expect(switchSaves(p, opus, { model: "claude-sonnet-5-5", serviceTier: null }, 80_000)).toBe(false);
  });
  it("counts the service tier multiplier and refuses unknown prices", () => {
    expect(switchSaves(p, { ...opus, serviceTier: "fast" }, { model: "claude-sonnet-5-5", serviceTier: null }, 20_000)).toBe(true);
    expect(switchSaves(p, opus, { model: "acme-1", serviceTier: null }, 80_000)).toBe(false);
  });
});

describe("service tier", () => {
  const fast = compiledWith({ ...NO_BIAS, gears: { "claude-code": { large: { model: "opus", effort: "high", serviceTier: "fast" } } } });
  it("is amended when the model lists it", () => {
    const d = decide(base({ text: "redesign the plugin", policy: fast, requested: { model: "claude-opus-5-5", effort: "high", serviceTier: "default" } }));
    expect(d).toMatchObject({ action: "shift", needsAmend: true });
    expect(d.gear!.serviceTier).toBe("fast");
  });
  it("keeps the composer's tier when the gear sets none", () => {
    const d = decide(base({ requested: { model: "claude-sonnet-5-5", effort: "medium", serviceTier: "fast" } }));
    expect(d).toMatchObject({ action: "keep", needsAmend: false });
  });
});

describe("downshift bias", () => {
  const pol = compiledDefault.policy;
  const t = pol.tiers;
  const opusHigh = { model: "claude-opus-5-5", effort: "high" };
  const biased = compiledDefault; // the default policy has the bias on

  it("is on by default", () => expect(pol.routing.downshiftBias).toBe(true));

  describe("biasTier", () => {
    it("moves the bottom point of a band one tier lower", () => {
      expect(biasTier("large", t.large.min, "high", pol)).toMatchObject({ tier: "medium", biased: true });
      expect(biasTier("small", t.small.min, "medium", pol)).toMatchObject({ tier: "trivial", biased: true });
      expect(biasTier("xlarge", t.xlarge.min, "high", pol)).toMatchObject({ tier: "large", biased: true });
    });
    it("leaves the rest of the band alone", () => {
      expect(biasTier("large", t.large.min + 1, "high", pol)).toMatchObject({ tier: "large", biased: false });
      expect(biasTier("large", t.large.max, "high", pol)).toMatchObject({ tier: "large", biased: false });
    });
    it("moves a low-confidence message one tier lower wherever its score sits", () => {
      expect(biasTier("large", t.large.min + 1, "low", pol)).toMatchObject({ tier: "medium", biased: true });
      expect(biasTier("medium", t.medium.max, "low", pol)).toMatchObject({ tier: "small", biased: true });
    });
    it("never moves trivial", () => {
      expect(biasTier("trivial", t.trivial.min, "low", pol)).toEqual({ tier: "trivial", biased: false, why: "" });
    });
    it("moves at most one tier even when both conditions apply", () => {
      expect(biasTier("large", t.large.min, "low", pol).tier).toBe("medium");
      expect(biasTier("xlarge", t.xlarge.min, "low", pol).tier).toBe("large");
    });
    it("does nothing with the setting off, and ignores an unknown confidence or a missing score", () => {
      expect(biasTier("large", t.large.min, "low", compiledWith(NO_BIAS).policy)).toMatchObject({ tier: "large", biased: false });
      expect(biasTier("large", null, null, pol).biased).toBe(false);
      expect(biasTier("large", t.large.min + 1, "surprise", pol).biased).toBe(false);
    });
    it("explains why it leaned", () => {
      expect(biasTier("large", t.large.min, "high", pol).why).toBe(`score ${t.large.min} is the bottom of large`);
      expect(biasTier("large", t.large.min + 1, "low", pol).why).toBe("no clear signal");
    });
  });

  // A message at the bottom of its band, and one with no clear signal mid-band (a long message with no scoring words).
  const BAND_MIN = "redesign the plugin";
  const NO_SIGNAL = "the weather today is nice and I was thinking about what we talked about yesterday regarding the thing ".repeat(12);
  const bandMin = { text: BAND_MIN, c: classify(BAND_MIN, biased) };
  const lowConf = { text: NO_SIGNAL, c: classify(NO_SIGNAL, biased) };

  it("decide: a message at the bottom of its band runs one tier lower, and says so", () => {
    const { text, c } = bandMin;
    expect([c.tier, c.score, c.confidence]).toEqual(["large", t.large.min, "medium"]);
    const d = decide(base({ text, policy: biased }));
    expect(d.tier).toBe("medium");
    expect(d.scoredTier).toBe(c.tier);
    expect(d.reason).toContain(`(leaning lower: score ${c.score} is the bottom of ${c.tier})`);
    const off = decide(base({ text }));
    expect(off.tier).toBe(c.tier);
    expect(off.scoredTier).toBe(c.tier);
    expect(off.reason).not.toContain("leaning lower");
  });

  it("decide: a message with no clear signal runs one tier lower", () => {
    const { text, c } = lowConf;
    expect([c.tier, c.confidence]).toEqual(["small", "low"]);
    expect(c.score).toBeGreaterThan(t.small.min);
    const d = decide(base({ text, policy: biased }));
    expect(d.scoredTier).toBe("small");
    expect(d.tier).toBe("trivial");
    expect(d.reason).toContain("(leaning lower: no clear signal)");
    expect(decide(base({ text })).tier).toBe(c.tier);
  });

  it("decide: trivial stays trivial and a clear mid-band message is untouched", () => {
    const d = decide(base({ text: "thanks", policy: biased }));
    expect(d).toMatchObject({ tier: "trivial", scoredTier: "trivial" });
    expect(d.reason).not.toContain("leaning lower");
    const big = decide(base({ text: BIG_BUILD, policy: biased }));
    expect(big.scoredTier).toBe(big.tier);
  });

  it("decide: explicit family requests, manual picks and continuations are not biased", () => {
    const text = NO_SIGNAL;
    const fam = decide(base({ text: `use opus for this: ${text}`, policy: biased }));
    expect(fam.reason).toBe("You asked for Opus 5.5");
    expect(fam.scoredTier).toBe(fam.tier);
    const manual = decide(base({ text, policy: biased, modelSource: "explicit" }));
    expect(manual.action).toBe("manual");
    expect(manual.scoredTier).toBe(manual.tier);
    const cont = decide(base({ text: "go ahead", current: opusHigh, policy: biased, requested: { model: "claude-sonnet-5-5", effort: "medium" } }));
    expect(cont).toMatchObject({ action: "hold", holdKind: "continuation" });
    expect(cont.scoredTier).toBe(cont.tier);
    expect(cont.reason).not.toContain("leaning lower");
  });

  it("decide: the hold rule runs on the biased tier and never upshifts", () => {
    const { text } = lowConf;
    const h = decide(base({ text, policy: biased, current: opusHigh, requested: opusHigh, contextTokens: 120_000 }));
    expect(h).toMatchObject({ action: "hold", tier: "trivial", scoredTier: "small" });
    expect(h.gear).toMatchObject({ model: "claude-opus-5-5", effort: "low" }); // the trivial effort, not small's
    expect(h.reason).toContain("(leaning lower: no clear signal)");
    // A thread already below the biased tier's gear is not lifted by it.
    const low = { model: "claude-haiku-5-5", effort: "low" };
    const u = decide(base({ text: BAND_MIN, policy: biased, current: low, requested: low, contextTokens: 120_000 }));
    expect(u.tier).toBe("medium");
    expect(u.action).toBe("shift"); // the biased tier is still above what the thread runs: a hold never blocks an upshift
    expect(u.gear!.model).toBe("claude-sonnet-5-5");
  });

  it("decide: the large effort floor applies to what stays large, not to a message the bias moved to medium", () => {
    const xh = { model: "claude-opus-5-5", effort: "xhigh" };
    const p = { gears: { "claude-code": { large: { model: "opus", effort: "low" }, medium: { model: "opus", effort: "low" } } } } as const;
    const moved = decide(base({ text: BAND_MIN, policy: compiledWith(p), current: xh, requested: xh, contextTokens: 355_000 }));
    expect(moved).toMatchObject({ action: "hold", tier: "medium", scoredTier: "large" });
    expect(moved.gear!.effort).toBe("low");
    const kept = decide(base({ text: BAND_MIN, policy: compiledWith({ ...p, ...NO_BIAS }), current: xh, requested: xh, contextTokens: 355_000 }));
    expect(kept).toMatchObject({ action: "hold", tier: "large" });
    expect(kept.gear!.effort).toBe("medium");
  });
});
