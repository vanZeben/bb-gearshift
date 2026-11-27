import { describe, expect, it } from "vitest";
import { CLAUDE_CATALOG } from "./fixtures";
import { DEFAULT_POLICY, TIERS, validatePolicy, type Policy, type Tier } from "./policy";
import { policyRev } from "./policy-rev";
import { applySubagentProvider, fallbackRoleName, parseSubagentUpdate, spawnRoleName, subagentRoleName, subagentValues } from "./subagent-provider";
import { resolveRole, roleTarget } from "./team";

const LOCAL = "llama-cpp";
const on = (s: Parameters<typeof applySubagentProvider>[1], installed?: readonly string[] | null) => applySubagentProvider(DEFAULT_POLICY, { subagentProvider: LOCAL, ...s }, installed);
const teamOf = (p: Policy, t: Tier) => p.teams[t].roles;

describe("defaults", () => {
  it("leave the policy byte-for-byte unchanged", () => {
    const before = JSON.stringify(DEFAULT_POLICY);
    const out = applySubagentProvider(DEFAULT_POLICY, { subagentProvider: "", subagentTiers: "small-medium", subagentBudgetCap: 0 });
    expect(out).toBe(DEFAULT_POLICY);
    expect(JSON.stringify(out)).toBe(before);
    expect(policyRev(out)).toBe(policyRev(DEFAULT_POLICY));
  });
  it("ignore the tiers and the cap while no provider is set", () => {
    expect(applySubagentProvider(DEFAULT_POLICY, { subagentTiers: "all", subagentBudgetCap: 64_000 })).toBe(DEFAULT_POLICY);
    expect(applySubagentProvider(DEFAULT_POLICY, {})).toBe(DEFAULT_POLICY);
  });
  it("never mutate the policy they are given", () => {
    const before = JSON.stringify(DEFAULT_POLICY);
    on({ subagentTiers: "all", subagentBudgetCap: 50_000 });
    expect(JSON.stringify(DEFAULT_POLICY)).toBe(before);
  });
});

describe("provider with small and medium tiers", () => {
  const out = on({});
  it("moves implement, qa and verify on small and medium", () => {
    expect(teamOf(out, "small")).toEqual(["implement-sub"]);
    expect(teamOf(out, "medium")).toEqual(["implement-sub", "qa-sub", "verify-sub"]);
  });
  it("leaves the other tiers' teams alone", () => {
    for (const t of ["trivial", "large", "xlarge"] as const) expect(out.teams[t]).toEqual(DEFAULT_POLICY.teams[t]);
  });
  it("keeps the original roles and every role it does not move", () => {
    for (const [name, spec] of Object.entries(DEFAULT_POLICY.roles)) expect(out.roles[name]).toEqual(spec);
    expect(out.roles["review-sub"]).toBeUndefined();
    expect(out.roles["verify-sub"]).toBeDefined();
  });
  it("sends the derived roles to the provider's default model, for any parent provider", () => {
    for (const parent of ["claude-code", "codex", "anything"]) {
      const t = roleTarget(out, "implement-sub", parent, "small");
      expect(t?.providerId).toBe(LOCAL);
      expect(t?.spec.model).toBe("@default");
    }
    // The existing path resolves it against that provider's catalog: the default model wins.
    const r = resolveRole(out, "qa-sub", "claude-code", "medium", new Map([[LOCAL, CLAUDE_CATALOG]]));
    expect(r?.gear?.model).toBe(CLAUDE_CATALOG.find((m) => m.isDefault)!.id);
  });
  it("keeps the role's effort and drops its service tier", () => {
    const base = DEFAULT_POLICY.roles.implement!.gears["*"]!;
    const spec = out.roles["implement-sub"]!.gears["*"]!;
    expect(spec.effort).toBe(base.effort);
    expect(spec.effortMediumUp).toBe(base.effortMediumUp);
    expect(spec).not.toHaveProperty("serviceTier");
  });
  it("keeps the budgets when there is no cap", () => {
    expect(out.roles["implement-sub"]!.budget).toEqual(DEFAULT_POLICY.roles.implement!.budget);
  });
  it("builds a policy that passes validation", () => {
    expect(validatePolicy(out)).toEqual([]);
  });
  it("treats an unknown tiers value as the default", () => {
    expect(on({ subagentTiers: "bogus" })).toEqual(out);
  });
});

describe("provider with all tiers", () => {
  const out = on({ subagentTiers: "all" });
  it("moves every tier that has implement, qa or verify", () => {
    expect(teamOf(out, "small")).toEqual(["implement-sub"]);
    expect(teamOf(out, "medium")).toEqual(["implement-sub", "qa-sub", "verify-sub"]);
    expect(teamOf(out, "large")).toEqual(["implement-sub", "qa-sub", "review"]);
    expect(teamOf(out, "xlarge")).toEqual(["architecture", "implement-sub", "qa-sub", "review"]);
  });
  it("leaves the trivial tier without a team", () => {
    expect(teamOf(out, "trivial")).toEqual([]);
  });
  it("keeps review and architecture on the lead's provider", () => {
    expect(roleTarget(out, "review", "claude-code", "large")?.providerId).toBe("claude-code");
    expect(roleTarget(out, "architecture", "claude-code", "xlarge")?.providerId).toBe("claude-code");
  });
  it("keeps the team summaries", () => {
    for (const t of TIERS) expect(out.teams[t].summary).toBe(DEFAULT_POLICY.teams[t].summary);
  });
  it("builds a policy that passes validation", () => {
    expect(validatePolicy(out)).toEqual([]);
  });
});

describe("budget cap", () => {
  it("clamps every tier of the moved roles down to the cap", () => {
    const out = on({ subagentTiers: "all", subagentBudgetCap: 64_000 });
    for (const r of ["implement", "qa", "verify"]) {
      const clamped = out.roles[subagentRoleName(r)]!.budget;
      for (const t of TIERS) expect(clamped[t]).toBe(Math.min(DEFAULT_POLICY.roles[r]!.budget[t], 64_000));
    }
    expect(out.roles["implement-sub"]!.budget.xlarge).toBe(64_000);
    expect(out.roles["qa-sub"]!.budget.small).toBe(64_000);
    expect(out.roles["qa-sub"]!.budget.trivial).toBe(60_000); // already under the cap: unchanged
  });
  it("never raises a budget above its default", () => {
    const out = on({ subagentBudgetCap: 10_000_000 });
    expect(out.roles["implement-sub"]!.budget).toEqual(DEFAULT_POLICY.roles.implement!.budget);
  });
  it("treats 0 as no cap", () => {
    expect(on({ subagentBudgetCap: 0 }).roles["implement-sub"]!.budget).toEqual(DEFAULT_POLICY.roles.implement!.budget);
  });
  it("treats a negative, fractional-below-one or non-numeric cap as no cap", () => {
    for (const cap of [-5, 0.5, Number.NaN, Number.POSITIVE_INFINITY, "64000" as unknown as number]) {
      expect(on({ subagentBudgetCap: cap }).roles["implement-sub"]!.budget).toEqual(DEFAULT_POLICY.roles.implement!.budget);
    }
  });
  it("rounds a fractional cap down to whole tokens", () => {
    expect(on({ subagentBudgetCap: 64_000.9 }).roles["implement-sub"]!.budget.medium).toBe(64_000);
  });
  it("leaves the roles it did not move at their own budgets", () => {
    const out = on({ subagentTiers: "all", subagentBudgetCap: 1_000 });
    for (const r of ["implement", "qa", "verify", "review", "architecture", "research", "explore"]) expect(out.roles[r]!.budget).toEqual(DEFAULT_POLICY.roles[r]!.budget);
    expect(out.roles["review"]!.budget.large).toBe(300_000);
  });
  it("is ignored with no provider: the lead's roles keep their budgets", () => {
    expect(applySubagentProvider(DEFAULT_POLICY, { subagentBudgetCap: 1_000 })).toBe(DEFAULT_POLICY);
  });
  it("shows in the spawn target the guard reads", () => {
    const out = on({ subagentBudgetCap: 64_000 });
    expect(roleTarget(out, "implement-sub", "claude-code", "medium")?.budget).toBe(64_000);
    expect(roleTarget(out, "implement", "claude-code", "medium")?.budget).toBe(360_000);
  });
});

describe("fail open", () => {
  it("returns the same policy for an empty or blank provider", () => {
    for (const p of ["", "   ", "\n"]) expect(applySubagentProvider(DEFAULT_POLICY, { subagentProvider: p, subagentTiers: "all", subagentBudgetCap: 64_000 })).toBe(DEFAULT_POLICY);
  });
  it("returns the same policy for a provider that is not installed", () => {
    expect(on({ subagentTiers: "all", subagentBudgetCap: 64_000 }, ["claude-code", "codex"])).toBe(DEFAULT_POLICY);
  });
  it("uses the provider when the installed list names it, ignoring surrounding spaces", () => {
    const out = applySubagentProvider(DEFAULT_POLICY, { subagentProvider: `  ${LOCAL} ` }, ["claude-code", LOCAL]);
    expect(roleTarget(out, "implement-sub", "claude-code", "medium")?.providerId).toBe(LOCAL);
  });
  it("trusts the setting when the installed list is unknown", () => {
    expect(on({}, null)).not.toBe(DEFAULT_POLICY);
    expect(on({}, undefined)).not.toBe(DEFAULT_POLICY);
  });
  it("returns the same policy for a non-string provider", () => {
    expect(applySubagentProvider(DEFAULT_POLICY, { subagentProvider: 42 as unknown as string })).toBe(DEFAULT_POLICY);
  });
  it("returns the same policy when the tiers have no role to move", () => {
    const bare: Policy = { ...DEFAULT_POLICY, teams: { ...DEFAULT_POLICY.teams, small: { summary: "", roles: ["review"] }, medium: { summary: "", roles: [] } } };
    expect(applySubagentProvider(bare, { subagentProvider: LOCAL })).toBe(bare);
  });
  it("leaves a role alone when the user already defined the derived name", () => {
    const mine = { gears: { "*": { model: "mine" } }, budget: DEFAULT_POLICY.roles.qa!.budget };
    const custom: Policy = { ...DEFAULT_POLICY, roles: { ...DEFAULT_POLICY.roles, "qa-sub": mine } };
    const out = applySubagentProvider(custom, { subagentProvider: LOCAL });
    expect(out.roles["qa-sub"]).toBe(mine);
    expect(teamOf(out, "medium")).toEqual(["implement-sub", "qa", "verify-sub"]);
  });
});

describe("role name helpers", () => {
  const out = on({});
  const allowed = teamOf(out, "medium");
  it("map a base role to its derived copy while the copy is in the team", () => {
    expect(spawnRoleName("qa", allowed, DEFAULT_POLICY)).toBe("qa-sub");
    expect(spawnRoleName("qa-sub", allowed, DEFAULT_POLICY)).toBe("qa-sub");
    expect(spawnRoleName("qa", teamOf(DEFAULT_POLICY, "medium"), DEFAULT_POLICY)).toBe("qa");
    expect(spawnRoleName("explore", allowed, DEFAULT_POLICY)).toBe("explore");
  });
  it("leave a -sub role that the user defined alone", () => {
    const own: Policy = { ...DEFAULT_POLICY, roles: { ...DEFAULT_POLICY.roles, "qa-sub": DEFAULT_POLICY.roles.qa! } };
    expect(spawnRoleName("qa", ["qa", "qa-sub"], own)).toBe("qa");
    expect(fallbackRoleName("qa-sub", own)).toBeNull();
  });
  it("name the base role to fall back to, only for derived roles", () => {
    expect(fallbackRoleName("qa-sub", DEFAULT_POLICY)).toBe("qa");
    expect(fallbackRoleName("qa", DEFAULT_POLICY)).toBeNull();
    expect(fallbackRoleName("ghost-sub", DEFAULT_POLICY)).toBeNull();
  });
});

describe("parseSubagentUpdate and subagentValues", () => {
  it("accepts any subset of the three keys and trims the provider", () => {
    expect(parseSubagentUpdate({})).toEqual({ values: {} });
    expect(parseSubagentUpdate({ provider: "  codex " })).toEqual({ values: { provider: "codex" } });
    expect(parseSubagentUpdate({ provider: "" })).toEqual({ values: { provider: "" } });
    expect(parseSubagentUpdate({ tiers: "all", budgetCap: 0 })).toEqual({ values: { tiers: "all", budgetCap: 0 } });
  });
  it("names the field that is wrong", () => {
    expect(parseSubagentUpdate({ provider: 1 })).toEqual({ error: expect.stringMatching(/^provider /) });
    expect(parseSubagentUpdate({ provider: "x".repeat(201) })).toEqual({ error: expect.stringMatching(/^provider /) });
    expect(parseSubagentUpdate({ tiers: "some" })).toEqual({ error: expect.stringMatching(/^tiers must be one of: small-medium, all/) });
    for (const budgetCap of [-1, 2.5, "5", null, Number.NaN, Number.POSITIVE_INFINITY]) expect(parseSubagentUpdate({ budgetCap })).toEqual({ error: expect.stringMatching(/^budgetCap /) });
    for (const bad of [null, "x", 3, []]) expect(parseSubagentUpdate(bad)).toHaveProperty("error");
  });
  it("fills the defaults for a missing or malformed setting", () => {
    expect(subagentValues({})).toEqual({ provider: "", tiers: "small-medium", budgetCap: 0 });
    expect(subagentValues({ subagentProvider: " codex ", subagentTiers: "all", subagentBudgetCap: 64_000.9 })).toEqual({ provider: "codex", tiers: "all", budgetCap: 64_000 });
    expect(subagentValues({ subagentTiers: "weird", subagentBudgetCap: -5 })).toEqual({ provider: "", tiers: "small-medium", budgetCap: 0 });
  });
});
