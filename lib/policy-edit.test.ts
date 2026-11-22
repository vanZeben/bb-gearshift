import { describe, expect, it } from "vitest";
import { applyPolicyEdit, type PolicyEdit } from "./policy-edit";
import { DEFAULT_POLICY, diffOverrides, mergePolicy, validatePolicy, type Policy } from "./policy";

const D = DEFAULT_POLICY;
const ok = (edit: PolicyEdit, eff: Policy = D) => {
  const r = applyPolicyEdit(eff, D, edit);
  if ("error" in r) throw new Error(r.error);
  expect(validatePolicy(r.policy)).toEqual([]);
  return r;
};
const err = (edit: PolicyEdit, eff: Policy = D) => {
  const r = applyPolicyEdit(eff, D, edit);
  if (!("error" in r)) throw new Error("expected an error");
  return r.error;
};
const set = (path: string, value: string): PolicyEdit => ({ op: "set", path, value });
const unset = (path: string): PolicyEdit => ({ op: "unset", path });

describe("applyPolicyEdit: tiers", () => {
  it("keeps bands contiguous when max moves", () => {
    const r = ok(set("tiers.large.max", "12"));
    expect(r.policy.tiers.large).toEqual({ min: 9, max: 12 });
    expect(r.policy.tiers.xlarge.min).toBe(13);
    expect(r.before).toBe("11");
    expect(r.after).toBe("12");
  });
  it("moves the previous band's max when min moves", () => {
    const r = ok(set("tiers.xlarge.min", "14"));
    expect(r.policy.tiers.large.max).toBe(13);
    expect(r.policy.tiers.xlarge.min).toBe(14);
  });
  it("rejects an edit that empties a band", () => {
    expect(err(set("tiers.large.max", "8"))).toMatch(/empty/);
    expect(err(set("tiers.medium.min", "9"))).toMatch(/empty/);
  });
  it("rejects a first band that does not start at 0 and fractions", () => {
    expect(err(set("tiers.trivial.min", "1"))).toMatch(/start at 0/);
    expect(err(set("tiers.large.max", "11.5"))).toMatch(/whole/);
  });
  it("unset restores the default band edge", () => {
    const moved = ok(set("tiers.large.max", "12")).policy;
    const r = ok(unset("tiers.large.max"), moved);
    expect(r.policy.tiers).toEqual(D.tiers);
  });
});

describe("applyPolicyEdit: gears", () => {
  it("edits an existing provider gear", () => {
    const r = ok(set("gears.claude-code.xlarge.effort", "high"));
    expect(r.policy.gears["claude-code"]!.xlarge!.effort).toBe("high");
  });
  it("creates the provider row from * when it does not exist", () => {
    const r = ok(set("gears.acme.xlarge.effort", "medium"));
    expect(r.policy.gears.acme!.xlarge).toEqual({ ...D.gears["*"]!.xlarge, effort: "medium" });
    expect(Object.keys(r.policy.gears.acme!)).toEqual(["xlarge"]);
    expect(diffOverrides(D, r.policy)).toEqual({ gears: { acme: { xlarge: { model: "@large", effort: "medium" } } } });
  });
  it("edits the * row and model", () => {
    expect(ok(set("gears.*.large.model", "@medium")).policy.gears["*"]!.large!.model).toBe("@medium");
  });
  it("clears optional strings with empty or null", () => {
    expect(ok(set("gears.claude-code.large.effort", "")).policy.gears["claude-code"]!.large!.effort).toBeUndefined();
    expect(ok(set("gears.claude-code.large.serviceTier", "null")).policy.gears["claude-code"]!.large!.serviceTier).toBeUndefined();
    expect(ok(set("gears.claude-code.large.serviceTier", "fast")).policy.gears["claude-code"]!.large!.serviceTier).toBe("fast");
  });
  it("rejects an empty model", () => {
    expect(err(set("gears.claude-code.large.model", ""))).toMatch(/empty/);
  });
  it("unset restores the default, or removes a row the defaults lack", () => {
    const changed = ok(set("gears.claude-code.large.effort", "low")).policy;
    expect(ok(unset("gears.claude-code.large.effort"), changed).policy.gears["claude-code"]).toEqual(D.gears["claude-code"]);
    const custom = ok(set("gears.acme.xlarge.effort", "medium")).policy;
    expect(ok(unset("gears.acme.xlarge.model"), custom).policy.gears.acme).toBeUndefined();
  });
});

describe("applyPolicyEdit: scoring", () => {
  const id = D.scoring.classes[0]!.id;
  it("edits class enabled, floor and add with typed parsing", () => {
    expect(ok(set(`scoring.classes.${id}.enabled`, "false")).policy.scoring.classes[0]!.enabled).toBe(false);
    expect(ok(set(`scoring.classes.${id}.enabled`, "off")).policy.scoring.classes[0]!.enabled).toBe(false);
    expect(ok(set(`scoring.classes.${id}.floor`, "4")).policy.scoring.classes[0]!.floor).toBe(4);
    expect(ok(set(`scoring.classes.${id}.add`, "2")).policy.scoring.classes[0]!.add).toBe(2);
  });
  it("rejects bad types and out-of-range values", () => {
    expect(err(set(`scoring.classes.${id}.enabled`, "maybe"))).toMatch(/true or false/);
    expect(err(set(`scoring.classes.${id}.floor`, "lots"))).toMatch(/number/);
    expect(err(set(`scoring.classes.${id}.floor`, "500"))).toMatch(/floor/);
    expect(err(set("scoring.question.score", ""))).toMatch(/number/);
  });
  it("unset on a class field restores the default", () => {
    const changed = ok(set(`scoring.classes.${id}.floor`, "7")).policy;
    expect(ok(unset(`scoring.classes.${id}.floor`), changed).policy.scoring.classes[0]!.floor).toBe(D.scoring.classes[0]!.floor);
  });
  it("edits scalar fields", () => {
    expect(ok(set("scoring.question.score", "2")).policy.scoring.question.score).toBe(2);
    expect(ok(set("scoring.trivial.maxChars", "40")).policy.scoring.trivial.maxChars).toBe(40);
    expect(ok(set("scoring.continuation.maxChars", "50")).policy.scoring.continuation.maxChars).toBe(50);
    expect(ok(set("scoring.components.cap", "3")).policy.scoring.components.cap).toBe(3);
    expect(ok(set("scoring.components.addPerExtraGroup", "2")).policy.scoring.components.addPerExtraGroup).toBe(2);
    expect(ok(set("scoring.files.atLeast", "5")).policy.scoring.files.atLeast).toBe(5);
    expect(ok(set("scoring.files.add", "1")).policy.scoring.files.add).toBe(1);
    expect(ok(set("scoring.unmatchedScore", "2")).policy.scoring.unmatchedScore).toBe(2);
  });
  it("unset restores a scalar default", () => {
    const changed = ok(set("scoring.unmatchedScore", "1")).policy;
    expect(ok(unset("scoring.unmatchedScore"), changed).policy.scoring.unmatchedScore).toBe(D.scoring.unmatchedScore);
  });
});

describe("applyPolicyEdit: patterns", () => {
  const id = D.scoring.classes[0]!.id;
  it("adds and removes a pattern", () => {
    const added = ok({ op: "add-pattern", classId: id, pattern: "\\bzzz\\b" });
    expect(added.policy.scoring.classes[0]!.patterns.at(-1)).toBe("\\bzzz\\b");
    const removed = ok({ op: "remove-pattern", classId: id, pattern: "\\bzzz\\b" }, added.policy);
    expect(removed.policy.scoring.classes[0]!.patterns).toEqual(D.scoring.classes[0]!.patterns);
  });
  it("rejects duplicates, missing patterns, unknown classes and unsafe or invalid regexes", () => {
    const existing = D.scoring.classes[0]!.patterns[0]!;
    expect(err({ op: "add-pattern", classId: id, pattern: existing })).toMatch(/already/);
    expect(err({ op: "remove-pattern", classId: id, pattern: "nope" })).toMatch(/no such pattern/);
    expect(err({ op: "add-pattern", classId: "nope", pattern: "x" })).toMatch(/Unknown scoring class/);
    expect(err({ op: "add-pattern", classId: id, pattern: "(" })).toBeTruthy();
    expect(err({ op: "add-pattern", classId: id, pattern: "(a+)+$" })).toBeTruthy();
    expect(err({ op: "add-pattern", classId: id, pattern: " " })).toMatch(/empty/);
  });
});

describe("applyPolicyEdit: roles and unknown paths", () => {
  it("edits a role budget in spend tokens", () => {
    expect(ok(set("roles.implement.budget.large", "500000")).policy.roles.implement!.budget.large).toBe(500000);
    expect(err(set("roles.implement.budget.large", "-1"))).toBeTruthy();
    expect(err(set("roles.nope.budget.large", "1"))).toMatch(/Unknown role/);
  });
  it("rejects unknown and locked paths, listing the valid ones", () => {
    for (const p of ["nope", "tiers.huge.min", "tiers.large.mid", "prices.x.input", "routing.defaultOn", "baselineModel", "teams.large.roles", "gears.x.large", "scoring.classes.action.patterns"]) {
      expect(err(set(p, "1"))).toMatch(/Unknown path[\s\S]*Valid paths/);
    }
    expect(err(unset("nope"))).toMatch(/Unknown path/);
    expect(err(set("scoring.classes.nope.floor", "3"))).toMatch(/Unknown scoring class/);
  });
  it("never mutates its input and round-trips through diffOverrides", () => {
    const before = JSON.stringify(D);
    const r = ok(set("tiers.large.max", "12"));
    expect(JSON.stringify(D)).toBe(before);
    expect(mergePolicy(D, diffOverrides(D, r.policy))).toEqual(r.policy);
  });
});
