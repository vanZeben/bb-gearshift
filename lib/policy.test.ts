import { describe, expect, it } from "vitest";
import { DEFAULT_POLICY, TIERS, unsafeRegexReason, compilePolicy, diffOverrides, ladderFor, mergePolicy, removeOverridePath, resolvePolicy, validatePolicy, type Policy } from "./policy";

const merge = (o: Record<string, unknown>) => mergePolicy(DEFAULT_POLICY, o);

describe("DEFAULT_POLICY", () => {
  it("is valid and compiles", () => {
    expect(validatePolicy(DEFAULT_POLICY)).toEqual([]);
    expect(() => compilePolicy(DEFAULT_POLICY)).not.toThrow();
    expect(TIERS).toEqual(["trivial", "small", "medium", "large", "xlarge"]);
  });
  it("is not mutated by merges", () => {
    const before = JSON.stringify(DEFAULT_POLICY);
    merge({ routing: { holdAboveTokens: 1 }, scoring: { classes: [{ id: "large", enabled: false }] }, gears: { codex: null } });
    expect(JSON.stringify(DEFAULT_POLICY)).toBe(before);
  });
});

describe("mergePolicy", () => {
  it("deep merges plain objects", () => {
    const p = merge({ routing: { holdAboveTokens: 0 } });
    expect(p.routing).toEqual({ ...DEFAULT_POLICY.routing, holdAboveTokens: 0 });
  });
  it("replaces arrays and scalars", () => {
    const p = merge({ skipPatterns: ["^x"], baselineModel: "claude-opus-5-5", scoring: { trivial: { patterns: ["^ok$"] } } });
    expect(p.skipPatterns).toEqual(["^x"]);
    expect(p.baselineModel).toBe("claude-opus-5-5");
    expect(p.scoring.trivial.patterns).toEqual(["^ok$"]);
    expect(p.scoring.trivial.maxChars).toBe(60);
  });
  it("merges classes by id, field by field", () => {
    const p = merge({ scoring: { classes: [{ id: "risk", add: 5 }] } });
    const risk = p.scoring.classes.find((c) => c.id === "risk")!;
    expect(risk.add).toBe(5);
    expect(risk.label).toBe("risk");
    expect(risk.patterns).toEqual(DEFAULT_POLICY.scoring.classes.find((c) => c.id === "risk")!.patterns);
    expect(p.scoring.classes).toHaveLength(DEFAULT_POLICY.scoring.classes.length);
  });
  it("disables a class and appends new ids", () => {
    const p = merge({ scoring: { classes: [{ id: "large", enabled: false }, { id: "mine", label: "mine", patterns: ["foo"], add: 2 }] } });
    expect(p.scoring.classes.find((c) => c.id === "large")!.enabled).toBe(false);
    expect(p.scoring.classes.at(-1)).toEqual({ id: "mine", label: "mine", patterns: ["foo"], add: 2 });
    expect(compilePolicy(p).classes.some((c) => c.id === "large")).toBe(false);
  });
  it("replaces gears and prices whole, null deletes", () => {
    const p = merge({
      gears: { codex: { small: { model: "x" }, medium: null }, "claude-code": null, custom: { large: { model: "@large" } } },
      prices: { "claude-haiku-4-5": { input: 9, output: 9 }, "claude-opus-4": null, "my-model": { input: 1, output: 2 } },
      serviceTierMultipliers: { fast: null, priority: 3 },
    });
    expect(p.gears.codex!.small).toEqual({ model: "x" });
    expect(p.gears.codex!.medium).toBeUndefined();
    expect(p.gears.codex!.large).toEqual(DEFAULT_POLICY.gears.codex!.large);
    expect(p.gears["claude-code"]).toBeUndefined();
    expect(p.gears.custom).toEqual({ large: { model: "@large" } });
    expect(p.prices["claude-haiku-4-5"]).toEqual({ input: 9, output: 9 });
    expect(p.prices["claude-opus-4"]).toBeUndefined();
    expect(p.prices["my-model"]).toEqual({ input: 1, output: 2 });
    expect(p.serviceTierMultipliers).toEqual({ priority: 3 });
  });
});

describe("validatePolicy", () => {
  it("reports a bad regex with the class id in the path", () => {
    const errs = validatePolicy(merge({ scoring: { classes: [{ id: "large", patterns: ["ok", "fine", "(unclosed"] }] } }));
    expect(errs).toHaveLength(1);
    expect(errs[0]!.path).toBe("scoring.classes[large].patterns[2]");
    expect(errs[0]!.message).toMatch(/regular expression|Invalid/i);
  });
  it("checks every pattern list", () => {
    const paths = validatePolicy(merge({ skipPatterns: ["("], explicitModel: { pattern: "[" }, scoring: { files: { pattern: "*" }, components: { groups: { backend: "(" } } } })).map((e) => e.path);
    expect(paths).toEqual(expect.arrayContaining(["skipPatterns[0]", "explicitModel.pattern", "scoring.files.pattern", "scoring.components.groups.backend"]));
  });
  it("rejects non-contiguous bands", () => {
    const errs = validatePolicy(merge({ tiers: { small: { min: 4, max: 5 } } }));
    expect(errs.map((e) => e.path)).toContain("tiers.small.min");
  });
  it("rejects a first band that does not start at 0 and inverted bands", () => {
    expect(validatePolicy(merge({ tiers: { trivial: { min: 1, max: 2 } } })).map((e) => e.path)).toContain("tiers.trivial.min");
    expect(validatePolicy(merge({ tiers: { medium: { min: 6, max: 5 } } })).map((e) => e.path)).toContain("tiers.medium.max");
  });
  it("rejects negative numbers and out-of-range scores", () => {
    const paths = validatePolicy(merge({ routing: { holdAboveTokens: -1 }, scoring: { classes: [{ id: "risk", add: 101 }] }, prices: { x: { input: -1, output: 1 } } })).map((e) => e.path);
    expect(paths).toEqual(expect.arrayContaining(["routing.holdAboveTokens", "scoring.classes[risk].add", "prices.x.input"]));
  });
  it("rejects an unknown class id or role in signalRoles", () => {
    const errs = validatePolicy(merge({ signalRoles: { nope: ["research"], research: ["ghost"] } }));
    expect(errs).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: "signalRoles.nope", message: expect.stringMatching(/Unknown scoring class/) }),
      expect.objectContaining({ path: "signalRoles.research", message: expect.stringMatching(/Unknown role "ghost"/) }),
    ]));
  });
  it("reports schema errors with a dotted path", () => {
    const errs = validatePolicy(merge({ routing: { defaultOn: "yes" } }));
    expect(errs[0]!.path).toBe("routing.defaultOn");
  });
});

describe("roles and signalRoles", () => {
  it("defaults drop lead/triage/digest/writing and map research and investigation signals", () => {
    for (const r of ["lead", "triage", "digest", "writing"]) expect(DEFAULT_POLICY.roles[r]).toBeUndefined();
    expect(DEFAULT_POLICY.signalRoles).toEqual({ research: ["research"], investigation: ["explore"] });
  });
  it("merges added and removed roles and replaces a signal's list", () => {
    const x = merge({ roles: { scout: { gears: { "*": { model: "@small", effort: "low" } }, budget: { trivial: 1, small: 2, medium: 3, large: 4, xlarge: 5 } }, review: null }, signalRoles: { research: ["research", "scout"], investigation: null } });
    expect(x.roles.scout).toBeDefined();
    expect(x.roles.review).toBeUndefined();
    expect(x.signalRoles).toEqual({ research: ["research", "scout"] });
  });
  it("diffs only the changed signalRoles", () => {
    const x = merge({ signalRoles: { investigation: ["explore", "qa"] } });
    expect(diffOverrides(DEFAULT_POLICY, x)).toEqual({ signalRoles: { investigation: ["explore", "qa"] } });
  });
});

describe("resolvePolicy", () => {
  it("falls back to defaults and keeps the errors when invalid", () => {
    const r = resolvePolicy({ tiers: { small: { min: 9, max: 9 } } });
    expect(r.effective).toBe(DEFAULT_POLICY);
    expect(r.errors.length).toBeGreaterThan(0);
  });
  it("returns the merged policy when valid", () => {
    const r = resolvePolicy({ routing: { holdAboveTokens: 5 } });
    expect(r.errors).toEqual([]);
    expect(r.effective.routing.holdAboveTokens).toBe(5);
  });
});

describe("ladderFor", () => {
  it("uses the provider's tiers, falling back to *", () => {
    const l = ladderFor(DEFAULT_POLICY, "claude-code");
    expect(l.trivial).toEqual({ model: "haiku", effort: "low" });
    expect(ladderFor(DEFAULT_POLICY, "someone-else").medium).toEqual({ model: "@medium", effort: "medium" });
    const p = merge({ gears: { codex: { large: null } } });
    expect(ladderFor(p, "codex").large).toEqual(DEFAULT_POLICY.gears["*"]!.large);
  });
});

describe("diffOverrides", () => {
  const cases: Record<string, Record<string, unknown>> = {
    none: {},
    scalar: { routing: { holdAboveTokens: 10, defaultOn: false }, baselineModel: "m" },
    arrays: { skipPatterns: ["^a", "^b"], scoring: { length: [{ overChars: 100, add: 1 }] } },
    classes: { scoring: { classes: [{ id: "risk", add: 4, label: "danger" }, { id: "large", enabled: false }, { id: "new", label: "n", patterns: ["z"], floor: 4 }] } },
    gears: { gears: { codex: { small: { model: "x", effort: "low", serviceTier: "fast" }, xlarge: null }, "claude-code": null, extra: { medium: { model: "@default" } } } },
    prices: { prices: { "claude-haiku-4-5": { input: 3, output: 4 }, "claude-opus-4": null, fresh: { input: 1, output: 1, cacheRead: 0.5 } }, serviceTierMultipliers: { fast: null, priority: 4 } },
    roles: { roles: { scout: { gears: { "*": { model: "@small", effort: "low" } }, budget: { trivial: 1, small: 2, medium: 3, large: 4, xlarge: 5 } }, qa: null }, teams: { medium: { roles: ["implement", "scout"] } } },
    signalRoles: { signalRoles: { research: ["research", "review"], investigation: null, risk: ["qa"] } },
    groups: { scoring: { components: { cap: 2, groups: { extra: "\\bfoo\\b" } } }, tiers: { trivial: { min: 0, max: 3 }, small: { min: 4, max: 5 } } },
  };
  for (const [name, o] of Object.entries(cases)) {
    it(`round-trips: ${name}`, () => {
      const x: Policy = mergePolicy(DEFAULT_POLICY, o);
      const diff = diffOverrides(DEFAULT_POLICY, x);
      expect(mergePolicy(DEFAULT_POLICY, diff)).toEqual(x);
    });
  }
  it("is empty for the defaults and stores no defaults", () => {
    expect(diffOverrides(DEFAULT_POLICY, DEFAULT_POLICY)).toEqual({});
    expect(diffOverrides(DEFAULT_POLICY, merge({ routing: { holdAboveTokens: 1 } }))).toEqual({ routing: { holdAboveTokens: 1 } });
  });
});

describe("removeOverridePath", () => {
  const o = { gears: { codex: { small: { model: "x" } }, custom: {} }, prices: { a: { input: 1, output: 1 } }, routing: { defaultOn: false } };
  it("drops a path and prunes empty parents", () => {
    expect(removeOverridePath(o, "gears.codex")).toEqual({ gears: { custom: {} }, prices: o.prices, routing: o.routing });
    expect(removeOverridePath({ routing: { defaultOn: false } }, "routing.defaultOn")).toEqual({});
  });
  it("null clears everything and the input is untouched", () => {
    expect(removeOverridePath(o, null)).toEqual({});
    expect(removeOverridePath(o, "prices")).not.toHaveProperty("prices");
    expect(o.prices).toBeDefined();
  });
});

describe("regex safety", () => {
  it("accepts every built-in pattern", () => {
    expect(validatePolicy(DEFAULT_POLICY)).toEqual([]);
  });
  it.each(["(\\w+)+", "(a|a)*", "(.*)+", "\\w+\\w+", ".*.*x", "(a|ab)+$"])("rejects %s", (src) => {
    const errors = validatePolicy({ ...DEFAULT_POLICY, skipPatterns: [src] });
    expect(errors[0]?.path).toBe("skipPatterns[0]");
    expect(errors[0]?.message).toMatch(/slow/);
  });
  it("rejects patterns over 500 characters", () => {
    expect(validatePolicy({ ...DEFAULT_POLICY, skipPatterns: ["a".repeat(501)] })[0]?.message).toMatch(/500/);
  });
  it("accepts the default leading-acknowledgement patterns and checks overrides at their own path", () => {
    expect(DEFAULT_POLICY.scoring.trivial.leading.length).toBeGreaterThan(0);
    expect(validatePolicy(DEFAULT_POLICY)).toEqual([]);
    const bad = { ...DEFAULT_POLICY, scoring: { ...DEFAULT_POLICY.scoring, trivial: { ...DEFAULT_POLICY.scoring.trivial, leading: ["(\\w+)+"] } } };
    expect(validatePolicy(bad)[0]?.path).toBe("scoring.trivial.leading[0]");
  });
  it("keeps ordinary groups", () => {
    expect(unsafeRegexReason("\\b(?:fix|add)s?\\b")).toBeNull();
    expect(unsafeRegexReason("(foo|bar)+")).toBeNull();
  });
});
