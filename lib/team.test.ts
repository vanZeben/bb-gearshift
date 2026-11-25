import { describe, expect, it } from "vitest";
import { classify } from "./classify";
import { CLAUDE_CATALOG, compiledDefault } from "./fixtures";
import { DEFAULT_POLICY } from "./policy";
import { biasTier } from "./router";
import { LEAD_INSTRUCTION, NOTE_PREFIX, formatRouteNote, noteWorthy, signalRolesFor } from "./team";

const catalogs = new Map([["claude-code", CLAUDE_CATALOG]]);
const routed = (text: string) => {
  const c = classify(text, compiledDefault);
  return { c, tier: biasTier(c.tier, c.score, c.confidence, DEFAULT_POLICY).tier };
};

describe("route note", () => {
  it("tells the lead to stay on its gear and fan the work out", () => {
    const note = formatRouteNote({ tier: "medium", score: 7, signalIds: ["investigation"], policy: DEFAULT_POLICY, parentProviderId: "claude-code", catalogs });
    expect(note.startsWith(NOTE_PREFIX)).toBe(true);
    expect(note.endsWith(LEAD_INSTRUCTION)).toBe(true);
    expect(note).toMatch(/explore → Haiku 5\.5/);
  });
});

describe("noteWorthy", () => {
  it("covers medium and up, and smaller messages only when their signals added a fan-out role", () => {
    expect(noteWorthy("medium")).toBe(true);
    expect(noteWorthy("small", 1)).toBe(true);
    expect(noteWorthy("small", 0)).toBe(false);
    expect(noteWorthy("trivial", 0)).toBe(false);
    expect(noteWorthy(null, 3)).toBe(false);
  });
});

describe("signalRolesFor", () => {
  it("adds explore to a cross-repo search even when it routes as small", () => {
    const { c, tier } = routed("Find the default terraform tags across all platform-* repos");
    expect(tier).toBe("small");
    expect(signalRolesFor(DEFAULT_POLICY, tier, c.contributions.map((x) => x.id))).toEqual(["explore"]);
  });
  it("adds nothing to a plain small change, and a trivial message gets no team at all", () => {
    const small = routed("rename the variable foo to bar in utils");
    expect(signalRolesFor(DEFAULT_POLICY, small.tier, small.c.contributions.map((x) => x.id))).toEqual([]);
    expect(signalRolesFor(DEFAULT_POLICY, "trivial", ["breadth"])).toEqual([]);
  });
});
