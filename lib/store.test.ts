import { describe, expect, it } from "vitest";
import { buildOverview, toDto } from "./analytics";
import { MIGRATIONS, Store, fingerprint, type NewDecision } from "./store";

type Db = ConstructorParameters<typeof Store>[0];
let makeDb: (() => Db) | null = null;
try {
  const mod = await import("better-sqlite3");
  const Ctor = mod.default as unknown as new (p: string) => Db;
  new Ctor(":memory:").close();
  makeDb = () => new Ctor(":memory:");
} catch { makeDb = null; }

const newStore = () => Store.migrate(makeDb!(), (db, stmts) => { for (const s of stmts) db.exec(s); });
const row = (o: Partial<NewDecision> = {}): NewDecision => ({
  at: 1_000_000, thread_id: "t1", project_id: "p", provider_id: "claude-code", initiator: "user", attempt: "start-turn", action: "shift",
  reason: "r", tier: "small", score: 3, confidence: "high", signals: JSON.stringify(["change"]), chars: 20, fingerprint: fingerprint("t1", "hello"),
  requested_model: "claude-opus-5-5", requested_effort: "high", routed_model: "claude-sonnet-5-5", routed_effort: "medium", routed_label: "Sonnet 5.5",
  routed_service_tier: null, baseline_model: "claude-opus-5-5", context_tokens: null, amend_status: null, ...o,
});

describe("migrations", () => {
  it("only ever append: shipped statements keep their place", () => {
    expect(MIGRATIONS[4]).toMatch(/routed_service_tier TEXT/);
    expect(MIGRATIONS[5]).toMatch(/CREATE TABLE queued_links/);
    expect(MIGRATIONS[7]).toMatch(/CREATE TABLE runs/);
    expect(MIGRATIONS[0]).toMatch(/^CREATE TABLE decisions/);
  });
  it("fingerprints ignore whitespace but not threads", () => {
    expect(fingerprint("a", " hi  there ")).toBe(fingerprint("a", "hi there"));
    expect(fingerprint("a", "x")).not.toBe(fingerprint("b", "x"));
  });
});

describe.skipIf(!makeDb)("Store (in-memory sqlite)", () => {
  it("stores no message text, only length and signals", () => {
    const s = newStore();
    const id = s.insertDecision(row());
    const cols = Object.keys(s.get(id)!);
    expect(cols).not.toContain("text");
    expect(JSON.stringify(s.get(id))).not.toContain("hello");
  });
  it("identical messages make separate rows", () => {
    const s = newStore();
    const a = s.insertDecision(row());
    const b = s.insertDecision(row({ at: 1_000_500 }));
    expect(b).not.toBe(a);
    expect(s.since(0)).toHaveLength(2);
  });
  it("links queue rows to decisions: newest unlinked fingerprint match, many rows per decision", () => {
    const s = newStore();
    const fp = fingerprint("t1", "hello");
    const a = s.insertDecision(row({ at: 10 }));
    const b = s.insertDecision(row({ at: 20 }));
    expect(s.unlinkedByFingerprint("t1", fp, 0)!.id).toBe(b);
    s.linkQueued(b, "t1", ["q2", "q3"]);
    expect(s.unlinkedByFingerprint("t1", fp, 0)!.id).toBe(a);
    expect(s.forQueued("t1", "q3")!.id).toBe(b);
    expect(s.forQueued("t1", "q2")!.queued_message_id).toBe("q2");
    expect(s.forQueued("t2", "q2")).toBeUndefined();
    expect(s.unlinkedByFingerprint("t1", fp, 15)).toBeUndefined();
  });
  it("attaching usage records the turn", () => {
    const s = newStore();
    const a = s.insertDecision(row());
    s.attachUsage(a, "turn1", { inputTokens: 1, outputTokens: 2, cacheReadTokens: 3, cacheWriteTokens: 4 }, 0.5, 1);
    expect(s.hasTurn("t1", "turn1")).toBe(true);
  });
  it("finds the newest open start-turn decision for usage", () => {
    const s = newStore();
    s.insertDecision(row({ fingerprint: "a", at: 10 }));
    const newer = s.insertDecision(row({ fingerprint: "b", at: 20 }));
    s.insertDecision(row({ fingerprint: "c", at: 99 }));
    expect(s.openForUsage("t1", 50)!.id).toBe(newer);
  });
  it("prefs and pruning", () => {
    const s = newStore();
    expect(s.getPref("t")).toBeNull();
    s.setPref("t", false); s.setPref("u", true);
    expect(s.getPref("t")).toBe(false);
    expect(s.countOff()).toBe(1);
    s.setPref("t", true);
    expect(s.countOff()).toBe(0);
    s.deletePref("t");
    expect(s.getPref("t")).toBeNull();
    s.insertDecision(row({ at: 5 })); s.insertDecision(row({ at: 500, fingerprint: "z" }));
    expect(s.prune(100)).toBe(1);
  });
  it("feeds analytics end to end", () => {
    const s = newStore();
    const now = 2_000_000_000_000;
    const id = s.insertDecision(row({ at: now - 1000 }));
    s.attachUsage(id, "t", { inputTokens: 100, outputTokens: 50, cacheReadTokens: 0, cacheWriteTokens: 0 }, 1, 3);
    s.insertDecision(row({ at: now - 500, fingerprint: "m", action: "manual", routed_model: null, tier: null }));
    const o = buildOverview(s.since(0), 7, 0, now);
    expect(o.totals).toMatchObject({ decisions: 2, routed: 1, shifted: 1, manual: 1, turnsWithUsage: 1, costUsd: 1, baselineCostUsd: 3, savedUsd: 2 });
    expect(toDto(s.get(id)!).usage).toEqual({ inputTokens: 100, outputTokens: 50, cacheReadTokens: 0, cacheWriteTokens: 0 });
  });
});
