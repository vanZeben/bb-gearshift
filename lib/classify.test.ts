import { describe, expect, it } from "vitest";
import { classify, humanText, tierForScore } from "./classify";
import { DEFAULT_POLICY } from "./policy";
import { compiledDefault as cp, compiledWith } from "./fixtures";

const c = (t: string) => classify(t, cp);

describe("worked examples (docs/DESIGN.md)", () => {
  const rows: Array<[string, number, string, "exact" | "min"]> = [
    ["thanks", 0, "trivial", "exact"],
    ["thanks for the help, that works", 0, "trivial", "exact"],
    ["how does the queue work?", 1, "trivial", "exact"],
    ["fix the typo in the README", 3, "small", "exact"],
    ["fix the build", 3, "small", "exact"],
    ["why is the dashboard slow?", 4, "small", "exact"],
    ["research which models are good for which tasks", 6, "medium", "exact"],
    ["the login is flaky", 8, "medium", "exact"],
    ["delete the old migration files", 5, "small", "exact"],
    ["port the billing service into a plugin", 9, "large", "min"],
    ["build a plugin with a composer toggle, an analytics page and a settings editor, with tests and a PR", 12, "xlarge", "min"],
  ];
  for (const [text, score, tier, mode] of rows) {
    it(`${text} -> ${score}${mode === "min" ? "+" : ""} ${tier}`, () => {
      const r = c(text);
      if (mode === "exact") expect(r.score).toBe(score); else expect(r.score).toBeGreaterThanOrEqual(score);
      expect(r.tier).toBe(tier);
      expect(r.skip).toBe(false);
    });
  }
  it("explains the login example as unmatched 3 + investigation 3 + risk 2", () => {
    const r = c("the login is flaky");
    expect(r.contributions.map((x) => [x.id, x.kind, x.value])).toEqual([["unmatched", "base", 3], ["investigation", "add", 3], ["risk", "add", 2]]);
    expect(r.confidence).toBe("medium"); // 8 sits on the medium band edge
  });
});

describe("contributions", () => {
  it("come in the order applied: base/floor, adds in class order, then bonuses", () => {
    const r = c("migrate the database schema across every table in the backend api, with tests, and update docs/README.md and src/a.ts and src/b.ts");
    const kinds = r.contributions.map((x) => x.kind);
    expect(kinds[0]).toBe("floor");
    expect(r.contributions[0]!.id).toBe("large");
    const firstBonus = kinds.indexOf("bonus");
    expect(firstBonus).toBeGreaterThan(0);
    expect(kinds.slice(1, firstBonus).every((k) => k === "add")).toBe(true);
    expect(kinds.slice(firstBonus).every((k) => k === "bonus")).toBe(true);
    expect(r.signals).toEqual(r.contributions.slice(0, 4).map((x) => x.label));
    expect(r.score).toBeLessThanOrEqual(DEFAULT_POLICY.tiers.xlarge.max);
  });
  it("uses the highest floor and sums adds", () => {
    const r = c("research and rewrite the auth flow in production");
    expect(r.contributions.find((x) => x.kind === "floor")!.value).toBe(9);
    expect(r.contributions.filter((x) => x.kind === "add").map((x) => x.id)).toContain("risk");
  });
  it("adds file and length bonuses", () => {
    const files = c("look at a/b.ts and c/d.ts and e/f.ts");
    expect(files.contributions.some((x) => x.id === "files")).toBe(true);
    const long = c(`what ${"does this do ".repeat(60)}?`);
    expect(long.contributions.some((x) => x.id === "length" && x.value === 1)).toBe(true);
  });
});

describe("the large-build class matches the verb migrate, not the noun migration", () => {
  it("scores 'delete the old migration files' as change 3 + risk 2", () => {
    const r = c("delete the old migration files");
    expect(r.contributions.map((x) => [x.id, x.kind, x.value])).toEqual([["action", "floor", 3], ["risk", "add", 2]]);
    expect(r).toMatchObject({ score: 5, tier: "small" });
  });
  it("still floors every verb form at large", () => {
    for (const t of ["migrate the database to Postgres", "it migrates users", "we migrated everything", "migrating the users table"]) {
      expect(c(t).contributions[0]).toMatchObject({ id: "large", kind: "floor", value: 9 });
    }
  });
  it("leaves the noun to the data area, singular or plural", () => {
    for (const t of ["write a migration for the new column", "review the migrations folder", "migration"]) {
      expect(c(t).contributions.some((x) => x.id === "large")).toBe(false);
    }
    const r = c("add a migration and update the api handler");
    expect(r.contributions.find((x) => x.id === "components")!.match).toBe("backend, data");
  });
});

describe("special messages", () => {
  it("empty is trivial", () => {
    const r = c("   ");
    expect(r).toMatchObject({ tier: "trivial", score: 0, confidence: "high", skip: false });
  });
  it("trivial acknowledgements", () => {
    for (const t of ["ok", "Thanks!", "lgtm", "👍", "yes"]) expect(c(t)).toMatchObject({ tier: "trivial", score: 0, confidence: "high" });
    expect(c("thanks, now rewrite the whole thing from scratch").tier).not.toBe("trivial");
  });
  it("an acknowledgement that leads a short message is trivial when nothing asks for work", () => {
    for (const t of ["thanks for the help, that works", "thank you so much, that worked", "thanks, that fixed it", "thanks \u2014 that works", "great, that works", "perfect, thanks", "ok that makes sense", "ok, it works now", "nice, that looks good to me"]) {
      expect(c(t), t).toMatchObject({ tier: "trivial", score: 0, confidence: "high" });
    }
    expect(c("thanks for the help, that works").contributions).toEqual([{ id: "trivial", label: "acknowledgement", kind: "base", value: 0, match: "thanks for" }]);
  });
  it("a leading acknowledgement does not make a request trivial", () => {
    for (const t of [
      "ok, fix the login", "great, now add tests", "thanks \u2014 can you also delete the old branch?",
      "thanks, now rewrite the whole thing from scratch", "thanks for the help, that works, now add a test for the login",
      "thanks, now the login page", "thanks, review the PR", "ok review the PR", "ok, look at the logs", "good morning, review this",
      "great, can you explain how it works", "cheers, what next", "thank you for the help but it still crashes", "great idea, build a plugin for it",
      "cool, show me the diff",
    ]) expect(c(t).tier, t).not.toBe("trivial");
  });
  it("a question after a thank-you keeps the question score, not zero", () => {
    expect(c("thanks for the help! how does the queue work?")).toMatchObject({ score: 1, tier: "trivial" });
    expect(c("thanks for the help! how does the queue work?").contributions[0]!.id).toBe("question");
  });
  it("a leading acknowledgement is ignored beyond the short-reply length", () => {
    expect(c(`thanks for the help, that works ${"really ".repeat(10)}well`).tier).not.toBe("trivial");
  });
  it("leading patterns stay fast on a long near-miss, even with a raised length cap", () => {
    const long = compiledWith({ scoring: { trivial: { maxChars: 100_000 } } });
    const t = performance.now();
    classify(`thanks for ${"the help ".repeat(4_000)}`, long);
    classify(`ok, that ${"works ".repeat(4_000)}`, long);
    expect(performance.now() - t).toBeLessThan(50);
  });
  it("leading patterns come from the policy", () => {
    const off = compiledWith({ scoring: { trivial: { leading: [] } } });
    expect(classify("thanks for the help, that works", off).tier).toBe("small");
    expect(classify("thanks", off).tier).toBe("trivial");
  });
  it("continuation", () => {
    for (const t of ["continue", "go ahead", "Yes, please", "retry"]) expect(c(t).continuation).toBe(true);
    expect(c("continue the migration of every table").continuation).toBe(false);
    expect(c("continue the migrations").continuation).toBe(false);
  });
  it("skip patterns match the raw text", () => {
    for (const t of ["<system-reminder>x</system-reminder>", "  <task-notification>", "[SYSTEM NOTIFICATION] hi", "BB plan-progress automatic reminder"]) {
      const r = c(t);
      expect(r.skip).toBe(true);
      expect(r.contributions).toEqual([]);
    }
    expect(c("please fix this").skip).toBe(false);
  });
  it("custom skip patterns come from the policy", () => {
    const custom = compiledWith({ skipPatterns: ["^AUTO:"] });
    expect(classify("AUTO: ping", custom).skip).toBe(true);
    expect(classify("<system-reminder>x", custom).skip).toBe(false);
  });
  it("explicit model requests", () => {
    expect(c("use opus for this").requestedFamily).toBe("opus");
    expect(c("switch to Claude Sonnet please").requestedFamily).toBe("sonnet");
    expect(c("with gpt-5-mini fix the typo").requestedFamily).toBe("gpt-5-mini");
    expect(c("fix the typo").requestedFamily).toBeNull();
    expect(compiledWith({ explicitModel: { enabled: false } }) && classify("use opus", compiledWith({ explicitModel: { enabled: false } })).requestedFamily).toBeNull();
  });
});

describe("envelope stripping", () => {
  it("scores only the human's words", () => {
    const raw = "[forwarded from thread:abc] <system-reminder>rewrite everything from scratch, refactor, migrate the whole system</system-reminder>\nthanks";
    expect(humanText(raw)).toBe("thanks");
    expect(c(raw)).toMatchObject({ tier: "trivial", score: 0 });
  });
  it("drops attachment notes", () => {
    expect(humanText("[Attached image: a.png]\nfix the typo")).toBe("fix the typo");
  });
  it("replaces pasted content by a stub that is not scored", () => {
    const raw = `ok <pasted_content>${"migrate refactor rewrite ".repeat(100)}</pasted_content>`;
    expect(humanText(raw)).toMatch(/\[pasted \d+ chars\]/);
    expect(c(raw)).toMatchObject({ tier: "trivial", score: 0 });
    expect(c(raw).chars).toBe(2);
  });
});

describe("policy-driven", () => {
  it("a disabled class does not score", () => {
    const off = compiledWith({ scoring: { classes: [{ id: "large", enabled: false }] } });
    expect(classify("redesign the entire system", off).score).toBeLessThan(c("redesign the entire system").score);
  });
  it("moved bands change the tier", () => {
    const bands = compiledWith({ tiers: { trivial: { min: 0, max: 0 }, small: { min: 1, max: 5 } } });
    expect(classify("how does the queue work?", bands).tier).toBe("small");
  });
  it("tierForScore clamps outside the bands", () => {
    expect(tierForScore(-3, DEFAULT_POLICY.tiers)).toBe("trivial");
    expect(tierForScore(99, DEFAULT_POLICY.tiers)).toBe("xlarge");
  });
  it("confidence is low when nothing matched", () => {
    expect(c("hmm interesting blue").confidence).toBe("low");
  });
});

describe("input caps", () => {
  it("classifies a 200k-character message in under 50 ms", () => {
    const big = "refactor the module ".repeat(10_000);
    const t = performance.now();
    const c = classify(big, cp);
    expect(performance.now() - t).toBeLessThan(50);
    expect(c.chars).toBeGreaterThan(150_000);
    const hostile = "<system-reminder>".repeat(12_000) + "<pasted_content>".repeat(12_000);
    const t2 = performance.now();
    classify(hostile, cp);
    expect(performance.now() - t2).toBeLessThan(50);
  });
  it("only scans the first 2,000 characters for skip patterns", () => {
    expect(classify("x".repeat(2_500) + "<system-reminder>", cp).skip).toBe(false);
  });
});
