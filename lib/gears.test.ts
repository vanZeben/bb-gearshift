import { describe, expect, it } from "vitest";
import { clampEffort, gearWeight, resolveGear, resolveModel, sizeClass, toCatalog } from "./gears";
import { DEFAULT_POLICY, TIERS, ladderFor, mergePolicy } from "./policy";
import { CLAUDE_CATALOG, CODEX_CATALOG, GENERIC_CATALOG, TIERED_GEARS } from "./fixtures";

const TIERED_POLICY = mergePolicy(DEFAULT_POLICY, { gears: TIERED_GEARS });

describe("sizeClass", () => {
  it("reads size words from names", () => {
    expect(sizeClass({ id: "claude-haiku-5-5", displayName: "Haiku 5.5" })).toBe("small");
    expect(sizeClass({ id: "gpt-6-mini", displayName: "GPT-6 mini" })).toBe("small");
    expect(sizeClass({ id: "claude-opus-5-5", displayName: "Opus 5.5" })).toBe("large");
    expect(sizeClass({ id: "claude-sonnet-5-5", displayName: "Sonnet" })).toBe("medium");
    expect(sizeClass({ id: "acme-flash-2", displayName: "" })).toBe("small");
  });
});

describe("Claude-like catalog", () => {
  const ladder = ladderFor(DEFAULT_POLICY, "claude-code");
  const tiered = ladderFor(TIERED_POLICY, "claude-code");
  it("resolves families newest first", () => {
    expect(resolveModel("opus", CLAUDE_CATALOG)!.id).toBe("claude-opus-5-5");
    expect(resolveModel("sonnet", CLAUDE_CATALOG)!.id).toBe("claude-sonnet-5-5");
    expect(resolveModel("haiku", CLAUDE_CATALOG)!.id).toBe("claude-haiku-5-5");
    expect(resolveModel("fable", CLAUDE_CATALOG)!.id).toBe("claude-fable-5-2");
    expect(resolveModel("claude-haiku-4-5-20251001", CLAUDE_CATALOG)!.id).toBe("claude-haiku-4-5-20251001");
    expect(resolveModel("gemini", CLAUDE_CATALOG)).toBeNull();
  });
  it("maps the default ladder: the lead stays on the capable model and only effort scales", () => {
    const efforts = ["low", "medium", "high", "high", "xhigh"];
    TIERS.forEach((t, i) => {
      expect(resolveGear(ladder[t], CLAUDE_CATALOG)).toMatchObject({ model: "claude-opus-5-5", effort: efforts[i] });
    });
  });
  it("maps the tiered ladder (pre-0.5 default) onto cheaper models on the lower tiers", () => {
    expect(resolveGear(tiered.trivial, CLAUDE_CATALOG)).toMatchObject({ model: "claude-haiku-5-5", effort: "low" });
    expect(resolveGear(tiered.small, CLAUDE_CATALOG)).toMatchObject({ model: "claude-sonnet-5-5", effort: "medium" });
    expect(resolveGear(tiered.medium, CLAUDE_CATALOG)).toMatchObject({ model: "claude-sonnet-5-5", effort: "high" });
    expect(resolveGear(tiered.large, CLAUDE_CATALOG)).toMatchObject({ model: "claude-opus-5-5", effort: "high" });
    expect(resolveGear(tiered.xlarge, CLAUDE_CATALOG)).toMatchObject({ model: "claude-opus-5-5", effort: "xhigh" });
  });
  it("clamps effort to what the model supports", () => {
    const old = CLAUDE_CATALOG[4]!;
    expect(clampEffort("medium", old)).toBe("low");
    expect(resolveGear({ model: "claude-haiku-4-5-20251001", effort: "xhigh" }, CLAUDE_CATALOG)!.effort).toBe("low");
  });
  it("never picks a provider-specific level implicitly", () => {
    const opus = CLAUDE_CATALOG[0]!;
    expect(clampEffort("max", opus)).toBe("xhigh");
    expect(clampEffort("xhigh", opus)).toBe("xhigh");
    expect(clampEffort("ultracode", opus)).toBe("ultracode"); // exact request still honoured
    const odd = { ...opus, efforts: ["low", "ultracode"], defaultEffort: "low" };
    expect(clampEffort("high", odd)).toBe("low");
    expect(clampEffort(undefined, opus)).toBeNull();
  });
});

describe("serviceTier", () => {
  it("is applied only when the resolved model lists it", () => {
    expect(resolveGear({ model: "opus", effort: "high", serviceTier: "fast" }, CLAUDE_CATALOG)!.serviceTier).toBe("fast");
    expect(resolveGear({ model: "sonnet", effort: "high", serviceTier: "fast" }, CLAUDE_CATALOG)!.serviceTier).toBeNull();
    expect(resolveGear({ model: "opus", effort: "high" }, CLAUDE_CATALOG)!.serviceTier).toBeNull();
  });
  it("toCatalog keeps service tiers", () => {
    const cat = toCatalog([{ id: "a", supportedServiceTiers: [{ id: "fast" }, { id: "default" }] }, { id: "b" }]);
    expect(cat[0]!.serviceTiers).toEqual(["fast", "default"]);
    expect(cat[1]!.serviceTiers).toEqual([]);
    expect(cat[1]!.displayName).toBe("b");
  });
});

describe("Codex-like catalog", () => {
  const ladder = ladderFor(DEFAULT_POLICY, "codex");
  const tiered = ladderFor(TIERED_POLICY, "codex");
  it("uses the default model at every tier", () => {
    for (const t of TIERS) expect(resolveGear(ladder[t], CODEX_CATALOG)!.model).toBe("gpt-6");
    expect(resolveGear(ladder.trivial, CODEX_CATALOG)).toMatchObject({ model: "gpt-6", effort: "low" });
    expect(resolveGear(ladder.xlarge, CODEX_CATALOG)).toMatchObject({ model: "gpt-6", effort: "xhigh" });
  });
  it("tiered: uses -mini for trivial and small and the default for the rest", () => {
    expect(resolveGear(tiered.trivial, CODEX_CATALOG)).toMatchObject({ model: "gpt-6-mini", effort: "low" });
    expect(resolveGear(tiered.small, CODEX_CATALOG)!.model).toBe("gpt-6-mini");
    expect(resolveGear(tiered.medium, CODEX_CATALOG)!.model).toBe("gpt-6");
    expect(resolveGear(tiered.xlarge, CODEX_CATALOG)).toMatchObject({ model: "gpt-6", effort: "xhigh" });
  });
  it("a plain family word prefers the non-mini model", () => {
    expect(resolveModel("gpt-6", CODEX_CATALOG)!.id).toBe("gpt-6");
    expect(resolveModel("mini", CODEX_CATALOG)!.id).toBe("gpt-6-mini");
  });
});

describe("generic size classes", () => {
  const ladder = ladderFor(DEFAULT_POLICY, "some-acp");
  const tiered = ladderFor(TIERED_POLICY, "some-acp");
  it("default: every tier resolves to the large size class and only effort scales", () => {
    const efforts = ["low", "medium", "medium", "high", "xhigh"];
    TIERS.forEach((t, i) => {
      expect(ladder[t].model).toBe("@large");
      expect(resolveGear(ladder[t], GENERIC_CATALOG)).toMatchObject({ model: "acme-ultra-2", effort: efforts[i] });
    });
  });
  it("tiered: maps tiers onto small/medium/large", () => {
    expect(resolveGear(tiered.trivial, GENERIC_CATALOG)!.model).toBe("acme-flash-2");
    expect(resolveGear(tiered.medium, GENERIC_CATALOG)!.model).toBe("acme-core-2");
    expect(resolveGear(tiered.large, GENERIC_CATALOG)!.model).toBe("acme-ultra-2");
    expect(resolveGear(tiered.xlarge, GENERIC_CATALOG)!.model).toBe("acme-ultra-2");
  });
  it("falls back to the nearest class when one is missing", () => {
    const onlyMedium = GENERIC_CATALOG.filter((m) => m.id === "acme-core-2");
    expect(resolveGear(tiered.trivial, onlyMedium)!.model).toBe("acme-core-2");
    expect(resolveGear(tiered.large, onlyMedium)!.model).toBe("acme-core-2");
    expect(resolveGear(tiered.large, [])).toBeNull();
    expect(resolveGear(ladder.large, onlyMedium)!.model).toBe("acme-core-2");
  });
});

describe("gearWeight", () => {
  const ladder = ladderFor(TIERED_POLICY, "claude-code");
  it("orders models by ladder position, then effort", () => {
    const w = (m: string, e: string) => gearWeight(m, e, ladder, CLAUDE_CATALOG);
    expect(w("claude-haiku-5-5", "low")).toBeLessThan(w("claude-sonnet-5-5", "medium"));
    expect(w("claude-sonnet-5-5", "high")).toBeLessThan(w("claude-opus-5-5", "high"));
    expect(w("claude-opus-5-5", "medium")).toBeLessThan(w("claude-opus-5-5", "xhigh"));
    expect(w("unknown-large-model-pro", "high")).toBeGreaterThan(w("claude-haiku-5-5", "low"));
  });
});
