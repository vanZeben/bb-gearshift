import { describe, expect, it } from "vitest";
import { decide, type DecideInput } from "./router";
import { CLAUDE_CATALOG, compiledDefault, compiledWith } from "./fixtures";

const base = (o: Partial<DecideInput> = {}): DecideInput => ({
  enabled: true, text: "fix the typo in the README", providerId: "claude-code", attempt: "start-turn", initiator: "user",
  requested: { model: "claude-opus-5-5", effort: "high" }, modelSource: null, current: null, contextTokens: null,
  catalog: CLAUDE_CATALOG, policy: compiledDefault, ...o,
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
    expect(d.reason).toBe("Small task (change) → Sonnet 5.5 · medium");
  });
});

describe("rule 10: hold above tokens", () => {
  const opusHigh = { model: "claude-opus-5-5", effort: "high" };
  it("holds instead of downshifting a big context", () => {
    const d = decide(base({ text: "thanks", current: opusHigh, contextTokens: 120_000, requested: { model: "claude-sonnet-5-5", effort: "medium" } }));
    expect(d).toMatchObject({ action: "hold", needsAmend: true });
    expect(d.gear).toMatchObject({ model: "claude-opus-5-5", effort: "high" });
    expect(d.reason).toBe("Holding Opus 5.5: a 120k-token context would be re-read uncached");
  });
  it("hold needs no amend when the request already is the current gear", () => {
    const d = decide(base({ text: "thanks", current: opusHigh, contextTokens: 120_000, requested: opusHigh }));
    expect(d).toMatchObject({ action: "hold", needsAmend: false });
  });
  it("downshifts below the threshold", () => {
    const d = decide(base({ text: "thanks", current: opusHigh, contextTokens: 10_000 }));
    expect(d.action).toBe("shift");
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
    expect(decide(base({ text: "thanks", current: opusHigh, contextTokens: 900_000, policy: off })).action).toBe("shift");
    const low = compiledWith({ routing: { holdAboveTokens: 1000 } });
    expect(decide(base({ text: "thanks", current: opusHigh, contextTokens: 1000, policy: low })).action).toBe("hold");
  });
  it("needs a current gear and a known context size", () => {
    expect(decide(base({ text: "thanks", current: null, contextTokens: 900_000 })).action).toBe("shift");
    expect(decide(base({ text: "thanks", current: opusHigh, contextTokens: null })).action).toBe("shift");
  });
});

describe("service tier", () => {
  const fast = compiledWith({ gears: { "claude-code": { large: { model: "opus", effort: "high", serviceTier: "fast" } } } });
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
