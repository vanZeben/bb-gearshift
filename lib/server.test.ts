// Integration tests for the message.dispatch hook, the message.queued listener and amend, on the official fake host.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFakePluginHost, makeMessageDispatchHookContext, makeQueueEntry, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import plugin from "../server";
import { CLAUDE_CATALOG, CODEX_CATALOG } from "./fixtures";
import { Store, fingerprint } from "./store";

type Row = ReturnType<typeof makeQueueEntry>;
const PROVIDER = "claude-code";
const T = "thread-1";
const SMALL = "fix the typo in the README";
const sdkModels = CLAUDE_CATALOG.map((m) => ({
  id: m.id, displayName: m.displayName, isDefault: m.isDefault, defaultReasoningEffort: m.defaultEffort ?? undefined,
  supportedReasoningEfforts: m.efforts.map((reasoningEffort) => ({ reasoningEffort })),
  supportedServiceTiers: m.serviceTiers.map((id) => ({ id })),
}));

interface Opts { settings?: Record<string, boolean | number | string>; models?: (a: Record<string, unknown>) => Promise<unknown>; defaults?: () => Promise<unknown>; threads?: Record<string, unknown>; hosts?: unknown[]; providerList?: unknown[] | (() => Promise<unknown>) }

async function setup(o: Opts = {}) {
  // In-memory queue model: rows the plugin can list and amend.
  const queue = new Map<string, Row>();
  const update = vi.fn(async (a: { threadId: string; queuedMessageId: string; model?: string; reasoningLevel?: string; input?: never[] }) => {
    const r = queue.get(a.queuedMessageId);
    if (!r) throw new Error("no such row");
    queue.set(r.id, { ...r, model: a.model ?? r.model, reasoningLevel: a.reasoningLevel ?? r.reasoningLevel, ...(a.input ? { content: a.input } : {}), updatedAt: r.updatedAt + 1 });
    return queue.get(r.id);
  });
  const { bb, harness } = createFakePluginHost({
    pluginId: "gearshift", agentSkillIds: ["gearshift"],
    ...(o.settings ? { settings: o.settings } : {}),
    sdk: {
      providers: { models: o.models ?? (async () => ({ models: sdkModels })), ...(o.providerList ? { list: typeof o.providerList === "function" ? o.providerList : async () => o.providerList } : {}) },
      ...(o.hosts ? { hosts: { list: async () => o.hosts } } : {}),
      threads: {
        defaultExecutionOptions: o.defaults ?? (async () => ({ model: "claude-opus-5-5", reasoningLevel: "high", serviceTier: null })),
        events: { list: async () => [] },
        queuedMessages: { list: async () => [...queue.values()], update },
        ...(o.threads ?? {}),
      },
    },
  } as never);
  await plugin(bb);
  const hook = harness.inspection.registrations.hooks["message.dispatch"]!;
  const db = bb.storage.database();
  const decisions = () => db.prepare("SELECT * FROM decisions ORDER BY id").all() as Array<Record<string, any>>;
  const row = (id: string, text: string, o2: Partial<Row> = {}): Row => {
    const r = makeQueueEntry({ id, threadId: T, content: [{ type: "text", text, mentions: [] }], model: "claude-opus-5-5", reasoningLevel: "high", waitingOn: { kind: "plugin", pluginId: "gearshift", reason: "w" }, ...o2 } as never);
    queue.set(id, r);
    return r;
  };
  const ctx = (text: string, over: Record<string, unknown> = {}) => makeMessageDispatchHookContext({
    thread: { id: T, providerId: PROVIDER }, input: { text },
    requestedExecution: { providerId: PROVIDER, model: "claude-opus-5-5", reasoningLevel: "high" }, ...over,
  } as never);
  const queued = (r: Row) => harness.behavior.emitThreadEvent("message.queued" as never, { entry: r } as never);
  const flush = () => vi.advanceTimersByTimeAsync(10);
  return { bb, harness, hook, db, decisions, row, ctx, queued, flush, update, queue };
}

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

describe("shift flow", () => {
  it("waits, amends exactly the linked row, rechecks, then proceeds without a second decision", async () => {
    const s = await setup();
    const res = await s.hook(s.ctx(SMALL));
    expect(res).toMatchObject({ action: "wait" });
    expect((res as { reason: string }).reason).toMatch(/^Shifting to /);
    expect(s.decisions()).toHaveLength(1);
    expect(s.decisions()[0]).toMatchObject({ action: "shift", amend_status: "pending" });

    s.row("other", "something unrelated", { waitingOn: null as never });
    const r = s.row("q1", SMALL);
    await s.queued(r);
    await s.flush();
    expect(s.update).toHaveBeenCalledTimes(1);
    const arg = s.update.mock.calls[0]![0];
    expect(arg.queuedMessageId).toBe("q1");
    expect(arg.model).toBe("claude-opus-5-5"); // the lead keeps its model; only the effort drops
    expect(arg.reasoningLevel).toBe("low");
    expect(s.harness.inspection.recheckCount).toBeGreaterThanOrEqual(1);
    expect(s.decisions()[0]!.amend_status).toBe("done");

    const again = await s.hook(s.ctx(SMALL, { queuedMessages: [s.queue.get("q1")] }));
    expect(again).toEqual({ action: "proceed" });
    expect(s.decisions()).toHaveLength(1);
  });
});

describe("manual picks", () => {
  it("inline explicit pick proceeds; the later drain of the linked row stays manual with no amend", async () => {
    const s = await setup();
    const res = await s.hook(s.ctx(SMALL, { executionSources: { model: "explicit" } }));
    expect(res).toEqual({ action: "proceed" });
    expect(s.decisions()[0]!.action).toBe("manual");
    const r = s.row("q1", SMALL);
    await s.queued(r);
    await s.flush();
    const drained = await s.hook(s.ctx(SMALL, { queuedMessages: [r], executionSources: { model: null } }));
    expect(drained).toEqual({ action: "proceed" });
    expect(s.decisions()).toHaveLength(1);
    expect(s.decisions()[0]!.action).toBe("manual");
    expect(s.update).not.toHaveBeenCalled();
  });
});

describe("repeats", () => {
  it("two identical short messages make two decision rows", async () => {
    const s = await setup();
    await s.hook(s.ctx("continue"));
    await s.hook(s.ctx("continue"));
    expect(s.decisions()).toHaveLength(2);
  });
});

describe("grouped drains", () => {
  it("rows both linked to decisions proceed without a new decision", async () => {
    const s = await setup();
    await s.hook(s.ctx(SMALL));
    await s.hook(s.ctx("rename the variable foo to bar"));
    const a = s.row("a", SMALL), b = s.row("b", "rename the variable foo to bar");
    await s.queued(a); await s.queued(b); await s.flush();
    expect(s.decisions()).toHaveLength(2);
    const res = await s.hook(s.ctx(`${SMALL}\n\nrename the variable foo to bar`, { queuedMessages: [a, b] }));
    expect(res).toEqual({ action: "proceed" });
    expect(s.decisions()).toHaveLength(2);
  });

  it("rows Gearshift never saw get one decision, wait, and both rows are amended", async () => {
    const s = await setup();
    const a = s.row("a", SMALL), b = s.row("b", "rename the variable foo to bar");
    const res = await s.hook(s.ctx(`${SMALL}\n\nrename the variable foo to bar`, { queuedMessages: [a, b] }));
    expect(res).toMatchObject({ action: "wait" });
    await s.flush();
    expect(s.update.mock.calls.map((c) => c[0].queuedMessageId).sort()).toEqual(["a", "b"]);
    expect(s.decisions()).toHaveLength(1);
    expect(s.harness.inspection.recheckCount).toBeGreaterThanOrEqual(1);
  });
});

describe("rows waiting on another plugin", () => {
  it("a row linked to our decision is amended and recognised on re-attempt", async () => {
    const s = await setup();
    await s.hook(s.ctx(SMALL));
    const r = s.row("q1", SMALL, { waitingOn: { kind: "plugin", pluginId: "someone-else", reason: "x" } as never });
    await s.queued(r);
    await s.flush();
    expect(s.update).toHaveBeenCalledTimes(1);
    expect(s.update.mock.calls[0]![0].queuedMessageId).toBe("q1");
    expect(s.queue.get("q1")!.model).toBe("claude-opus-5-5");
    expect(s.queue.get("q1")!.reasoningLevel).toBe("low");
    const res = await s.hook(s.ctx(SMALL, { queuedMessages: [s.queue.get("q1")] }));
    expect(res).toEqual({ action: "proceed" });
    expect(s.decisions()).toHaveLength(1);
  });
});

describe("fail open", () => {
  it("a lookup that never resolves still answers within ~1.6 s and leaves no timer", async () => {
    const s = await setup({ defaults: () => new Promise(() => {}) });
    const baseline = vi.getTimerCount();
    const p = Promise.resolve(s.hook(s.ctx(SMALL, { thread: { id: T, providerId: PROVIDER, status: "idle" } })));
    let settled = false;
    void p.then(() => { settled = true; });
    await vi.advanceTimersByTimeAsync(1600);
    expect(settled).toBe(true);
    expect((await p).action).toBe("proceed");
    expect(s.decisions()[0]!.action).toBe("skip");
    expect(vi.getTimerCount()).toBe(baseline);
  });

  it("an internal failure proceeds", async () => {
    const s = await setup({ models: async () => { throw new Error("boom"); } });
    expect(await s.hook(s.ctx(SMALL))).toEqual({ action: "proceed" });
  });
});

describe("thread toggle and defaults", () => {
  it("a thread toggled off proceeds with action off", async () => {
    const s = await setup();
    await s.harness.behavior.callRpc("setThreadEnabled", { threadId: T, enabled: false });
    expect(await s.hook(s.ctx(SMALL))).toEqual({ action: "proceed" });
    expect(s.decisions()[0]!.action).toBe("off");
  });

  it("defaultOn=false makes an untouched thread off", async () => {
    const s = await setup({ settings: { defaultOn: false } });
    expect(await s.hook(s.ctx(SMALL))).toEqual({ action: "proceed" });
    expect(s.decisions()[0]!.action).toBe("off");
  });
});

describe("policy safety", () => {
  it("rejects a pathological pattern and keeps routing", async () => {
    const s = await setup();
    const res = await s.harness.behavior.callRpc("savePolicy", { overrides: { skipPatterns: ["(a+)+$"] } }) as { ok: boolean; errors: unknown[] };
    expect(res.ok).toBe(false);
    expect(res.errors.length).toBeGreaterThan(0);
    const out = await s.hook(s.ctx(SMALL));
    expect(out).toMatchObject({ action: "wait" });
  });
});

// ---- teams: route note, spawn, budget guard, host fallback -------------------
const MEDIUM = "the login is flaky";
const noteBlocks = (r: Row | undefined) => ((r?.content ?? []) as Array<{ text?: string; visibility?: string }>).filter((b) => b.text?.startsWith("[gearshift]"));

describe("route note", () => {
  it("is added once, as an agent-only block, and never twice on re-attempt", async () => {
    const s = await setup();
    const res = await s.hook(s.ctx(MEDIUM));
    expect(res).toMatchObject({ action: "wait" });
    const r = s.row("q1", MEDIUM);
    await s.queued(r); await s.flush();
    const notes = noteBlocks(s.queue.get("q1"));
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatchObject({ visibility: "agent-only" });
    expect(notes[0]!.text).toMatch(/team:.*roles: implement/);
    const again = await s.hook(s.ctx(MEDIUM, { queuedMessages: [s.queue.get("q1")] }));
    expect(again).toEqual({ action: "proceed" });
    expect(noteBlocks(s.queue.get("q1"))).toHaveLength(1);
    expect(s.update).toHaveBeenCalledTimes(1);
  });

  const noteFor = async (text: string) => {
    const s = await setup({ settings: { downshiftBias: false } }); // the team follows the scored tier here
    await s.hook(s.ctx(text));
    const r = s.row("q1", text);
    await s.queued(r); await s.flush();
    return noteBlocks(s.queue.get("q1"))[0]?.text ?? "";
  };
  it("lists research for a research message and explore for an investigation message", async () => {
    expect(await noteFor("compare redis and memcached trade-offs for our cache")).toMatch(/roles:.*research/);
    expect(await noteFor(MEDIUM)).toMatch(/roles:.*explore/);
  });
  it("gives a trivial message no team and no signal roles", async () => {
    const s = await setup();
    await s.hook(s.ctx("ok thanks"));
    expect(noteBlocks(s.queue.get("q1"))).toHaveLength(0);
    expect(s.decisions().at(-1)!.signal_roles).toBe("[]");
  });

  it("is added to a small cross-repo message, offering explore", async () => {
    const text = "Find the default terraform tags across all platform-* repos";
    const s = await setup();
    await s.hook(s.ctx(text));
    expect(s.decisions().at(-1)).toMatchObject({ tier: "small", signal_roles: JSON.stringify(["explore"]) });
    const r = s.row("q1", text);
    await s.queued(r); await s.flush();
    const notes = noteBlocks(s.queue.get("q1"));
    expect(notes).toHaveLength(1);
    expect(notes[0]!.text).toMatch(/roles: implement .*explore/);
  });

  it("is not added to a small message", async () => {
    const s = await setup();
    await s.hook(s.ctx(SMALL));
    const r = s.row("q1", SMALL);
    await s.queued(r); await s.flush();
    expect(noteBlocks(s.queue.get("q1"))).toHaveLength(0);
  });

  it("never holds a manual pick just for a note", async () => {
    const s = await setup();
    expect(await s.hook(s.ctx(MEDIUM, { executionSources: { model: "explicit" } }))).toEqual({ action: "proceed" });
  });

  it("strips our note and agent-only blocks before classifying and fingerprinting", async () => {
    const s = await setup();
    const note = "[gearshift] tier=medium · refactor the entire architecture across every service";
    await s.hook(s.ctx(MEDIUM, { input: { text: `${MEDIUM}\n\n${note}`, blocks: [{ type: "text", text: MEDIUM, mentions: [] }, { type: "text", text: note, mentions: [], visibility: "agent-only" }] } }));
    expect(s.decisions()[0]!.fingerprint).toBe(fingerprint(T, MEDIUM));
    const s2 = await setup();
    await s2.hook(s2.ctx(MEDIUM, { input: { text: `${MEDIUM}\n\n${note}`, blocks: [] } }));
    expect(s2.decisions()[0]!.fingerprint).toBe(fingerprint(T, MEDIUM));
  });
});

describe("gearshift_spawn", () => {
  const thread = (extra: Record<string, unknown> = {}) => makeThreadResponse({ id: T, providerId: PROVIDER, environmentId: "env1", projectId: "p1", ...extra } as never);
  async function spawnSetup(overrides?: Record<string, unknown>) {
    const spawn = vi.fn(async (a: Record<string, unknown>) => ({ id: `child-${spawn.mock.calls.length}`, ...a }));
    const models = async (a: Record<string, unknown>) => ({ models: a.providerId === "codex" ? CODEX_CATALOG.map((m) => ({ id: m.id, displayName: m.displayName, isDefault: m.isDefault, supportedReasoningEfforts: m.efforts.map((reasoningEffort) => ({ reasoningEffort })), supportedServiceTiers: [] })) : sdkModels });
    const s = await setup({ models, threads: { get: async () => thread(), spawn } });
    if (overrides) expect(await s.harness.behavior.callRpc("savePolicy", { overrides })).toMatchObject({ ok: true });
    await s.hook(s.ctx(MEDIUM)); // records the tier for the parent thread
    return { ...s, spawn };
  }

  it("creates a child on the role's gear with explicit execution sources and records a run", async () => {
    const s = await spawnSetup();
    const res = await s.harness.behavior.callAgentTool("gearshift_spawn", { role: "qa", prompt: "run the tests" }, { threadId: T } as never);
    expect(JSON.stringify(res)).toMatch(/Spawned qa sub-agent: thread child-1/);
    const a = s.spawn.mock.calls[0]![0] as Record<string, any>;
    expect(a).toMatchObject({ parentThreadId: T, providerId: PROVIDER, model: "claude-haiku-5-5", reasoningLevel: "low", prompt: "run the tests" });
    expect(a.environment).toEqual({ type: "reuse", environmentId: "env1" });
    expect(a.executionInputSources).toMatchObject({ providerId: "explicit", model: "explicit", reasoningLevel: "explicit" });
    const runs = s.db.prepare("SELECT * FROM runs").all() as Array<Record<string, any>>;
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ child_thread_id: "child-1", parent_thread_id: T, role: "qa", provider: PROVIDER, status: "running", budget: 120_000 });
  });

  it("supports a cross-provider role", async () => {
    const s = await spawnSetup({ roles: { qa: { gears: { "claude-code": { model: "gpt-6", effort: "medium", providerId: "codex" } } } } });
    const res = await s.harness.behavior.callAgentTool("gearshift_spawn", { role: "qa", prompt: "review the diff" }, { threadId: T } as never);
    expect(JSON.stringify(res)).toMatch(/Spawned qa/);
    const a = s.spawn.mock.calls[0]![0] as Record<string, any>;
    expect(a).toMatchObject({ providerId: "codex", model: "gpt-6" });
    expect(a.executionInputSources.providerId).toBe("explicit");
    expect((s.db.prepare("SELECT provider FROM runs").get() as { provider: string }).provider).toBe("codex");
  });

  it("accepts a signal-added role and rejects an unlisted one", async () => {
    const s = await spawnSetup(); // MEDIUM is an investigation: explore joins the team
    const ok = await s.harness.behavior.callAgentTool("gearshift_spawn", { role: "explore", prompt: "look around" }, { threadId: T } as never);
    expect(JSON.stringify(ok)).toMatch(/Spawned explore/);
    const bad = await s.harness.behavior.callAgentTool("gearshift_spawn", { role: "architecture", prompt: "plan" }, { threadId: T } as never);
    expect(JSON.stringify(bad)).toMatch(/not in this message's team/);
    expect(s.spawn).toHaveBeenCalledTimes(1);
  });

  const insertRun = (db: any, parent: string, child: string, status = "running") =>
    db.prepare("INSERT INTO runs (parent_thread_id, child_thread_id, role, tier, provider, model, effort, budget, started_at, status) VALUES (?,?,?,?,?,?,?,?,?,?)").run(parent, child, "qa", "medium", PROVIDER, "m", "low", 1000, Date.now(), status);
  const call = (s: any, threadId = T) => s.harness.behavior.callAgentTool("gearshift_spawn", { role: "qa", prompt: "x" }, { threadId } as never);

  it("refuses grandchildren, over-cap spawns and spawns while off, and hides the tool from run children", async () => {
    const s = await spawnSetup();
    insertRun(s.db, "p0", T);
    expect(JSON.stringify(await call(s))).toMatch(/cannot spawn sub-agents/);
    const cfg = (id: string) => s.harness.behavior.resolveAgentConfiguration({ thread: { id, title: null, parentThreadId: null, sourceThreadId: null }, provider: { id: PROVIDER, model: "m" } } as never);
    expect((await cfg(T)).tools).toHaveLength(0);
    expect((await cfg("someone-else")).tools).toHaveLength(1);
    s.db.prepare("DELETE FROM runs").run();
    for (let i = 0; i < 6; i++) insertRun(s.db, T, `c${i}`);
    expect(JSON.stringify(await call(s))).toMatch(/limit 6/);
    s.db.prepare("DELETE FROM runs").run();
    for (let i = 0; i < 20; i++) insertRun(s.db, `o${i}`, `g${i}`);
    expect(JSON.stringify(await call(s))).toMatch(/limit 20/);
    s.db.prepare("DELETE FROM runs").run();
    await s.harness.behavior.callRpc("setThreadEnabled", { threadId: T, enabled: false });
    expect(JSON.stringify(await call(s))).toMatch(/off for this thread/);
    expect(s.spawn).not.toHaveBeenCalled();
  });

  it("skips routing only for the matching pending spawn, and uses the newest medium+ tier", async () => {
    const s = await spawnSetup();
    let during: unknown, other: unknown;
    s.spawn.mockImplementation(async (a: Record<string, unknown>) => {
      const mk = (model: string, parent: string) => s.ctx(SMALL, { thread: { id: "kid", providerId: PROVIDER, parentThreadId: parent }, executionSources: { model: "explicit" }, requestedExecution: { providerId: PROVIDER, model } });
      during = await s.hook(mk(a.model as string, T));
      other = await s.hook(mk("claude-opus-5-5", "someone-else"));
      return { id: "child-1" };
    });
    await call(s);
    expect(during).toEqual({ action: "proceed" });
    expect(s.decisions().filter((d) => d.thread_id === "kid")).toHaveLength(1);
    expect(other).toBeDefined();
    expect((s.db.prepare("SELECT tier, model_label FROM runs").get() as any).tier).toBe("medium");
    expect((s.db.prepare("SELECT model_label FROM runs").get() as any).model_label).toBeTruthy();
  });

  it("passes the parent's host when resolving another provider's catalog", async () => {
    const seen: Array<Record<string, unknown>> = [];
    const models = async (a: Record<string, unknown>) => { seen.push(a); return { models: a.providerId === "codex" ? CODEX_CATALOG.map((m) => ({ id: m.id, displayName: m.displayName, isDefault: m.isDefault, supportedReasoningEfforts: m.efforts.map((reasoningEffort) => ({ reasoningEffort })), supportedServiceTiers: [] })) : sdkModels }; };
    const s = await setup({ models });
    await s.harness.behavior.callRpc("savePolicy", { overrides: { roles: { review: { gears: { "claude-code": { model: "gpt-6", effort: "medium", providerId: "codex" } } } }, teams: { medium: { roles: ["review"], summary: "x" } } } });
    await s.hook(s.ctx(MEDIUM, { host: { id: "h1" } }));
    expect(seen.find((c) => c.providerId === "codex")).toMatchObject({ hostId: "h1" });
  });

  it("refuses an unknown role without spawning", async () => {
    const s = await spawnSetup();
    const res = await s.harness.behavior.callAgentTool("gearshift_spawn", { role: "nope", prompt: "x" }, { threadId: T } as never);
    expect(JSON.stringify(res)).toMatch(/Unknown role/);
    expect(s.spawn).not.toHaveBeenCalled();
  });
});

describe("budget guard", () => {
  async function guardSetup() {
    let spentInput = 0;
    const send = vi.fn(async (_a: Record<string, unknown>) => ({}));
    const stop = vi.fn(async (_a: Record<string, unknown>) => ({}));
    const output = vi.fn(async () => ({ output: "partial work" }));
    const events = { list: async (a: { threadId: string }) => a.threadId === "child-1" ? [{ createdAt: 1, scope: {}, data: { tokenUsage: { total: { inputTokens: spentInput, outputTokens: 0 } } } }] : [] };
    const s = await setup({ threads: { send, stop, output, events } });
    s.db.prepare("INSERT INTO runs (parent_thread_id, child_thread_id, role, tier, provider, model, effort, budget, started_at) VALUES (?,?,?,?,?,?,?,?,?)").run(T, "child-1", "qa", "medium", PROVIDER, "m", "low", 1000, Date.now());
    const emit = async (id: string) => { await s.harness.behavior.emitThreadEvent("experimental_thread.events" as never, { thread: makeThreadResponse({ id } as never), sequence: 1 } as never); await s.flush(); };
    const run = () => s.db.prepare("SELECT * FROM runs WHERE child_thread_id='child-1'").get() as Record<string, any>;
    return { ...s, send, stop, output, emit, run, setSpent: (n: number) => { spentInput = n; } };
  }

  it("nudges once at 80%", async () => {
    const g = await guardSetup();
    g.setSpent(850);
    await g.emit("child-1"); await g.emit("child-1");
    expect(g.send).toHaveBeenCalledTimes(1);
    expect(g.send.mock.calls[0]![0]).toMatchObject({ threadId: "child-1", mode: "steer-if-active" });
    expect(g.run()).toMatchObject({ status: "nudged", spent: 850 });
    expect(g.stop).not.toHaveBeenCalled();
  });

  it("stops at 100% and reports to the parent", async () => {
    const g = await guardSetup();
    g.setSpent(850); await g.emit("child-1");
    g.setSpent(1100); await g.emit("child-1");
    expect(g.stop).toHaveBeenCalledWith({ threadId: "child-1" });
    expect(g.send).toHaveBeenCalledTimes(2);
    const report = g.send.mock.calls[1]![0] as Record<string, any>;
    expect(report).toMatchObject({ threadId: T, senderThreadId: "child-1" });
    expect(JSON.stringify(report.input)).toMatch(/stopped mid-turn at its budget.*INCOMPLETE.*partial work/);
    expect(g.run()).toMatchObject({ status: "stopped" });
    await g.emit("child-1");
    expect(g.stop).toHaveBeenCalledTimes(1);
  });

  it("concurrent ticks nudge and stop exactly once", async () => {
    const g = await guardSetup();
    g.setSpent(850);
    await Promise.all([g.emit("child-1"), g.emit("child-1"), g.emit("child-1")]);
    expect(g.send).toHaveBeenCalledTimes(1);
    g.setSpent(1100);
    await Promise.all([g.emit("child-1"), g.emit("child-1"), g.emit("child-1")]);
    await g.flush();
    expect(g.stop).toHaveBeenCalledTimes(1);
    expect(g.send).toHaveBeenCalledTimes(2);
    expect(new Store(g.db).claimRun(g.run().id, ["running", "nudged"], "stopped")).toBe(false);
  });

  const idle = async (g: any) => { await g.harness.behavior.emitThreadEvent("thread.idle" as never, { thread: makeThreadResponse({ id: "child-1" } as never), lastAssistantText: null } as never); await g.flush(); };
  it("a child that crosses 100% on its final turn is done and over budget, not stopped", async () => {
    const g = await guardSetup();
    g.setSpent(1500);
    await idle(g);
    expect(g.stop).not.toHaveBeenCalled();
    expect(g.send).not.toHaveBeenCalled();
    expect(g.run()).toMatchObject({ status: "done", over_budget: 1 });
    const o = await g.harness.behavior.callRpc("overview", { days: 1 }) as any;
    expect(o.fanout.overBudget).toBe(1);
  });

  it("guards a resumed child again", async () => {
    const g = await guardSetup();
    g.setSpent(100);
    await idle(g);
    expect(g.run().status).toBe("done");
    g.setSpent(1200);
    await g.harness.behavior.emitThreadEvent("thread.active" as never, { thread: makeThreadResponse({ id: "child-1" } as never) } as never);
    await g.flush();
    expect(g.stop).toHaveBeenCalledTimes(1);
    expect(g.run().status).toBe("stopped");
  });

  it("enforces mid-turn from context-window growth", async () => {
    const send = vi.fn(async () => ({})), stop = vi.fn(async () => ({})), output = vi.fn(async () => ({ output: "x" }));
    let used = 1000;
    const events = { list: async () => [
      { createdAt: 10, data: { contextWindowUsage: { usedTokens: used } } },
      { createdAt: 5, data: { tokenUsage: { total: { inputTokens: 100, outputTokens: 0 } } } },
      { createdAt: 4, data: { contextWindowUsage: { usedTokens: 1000 } } },
    ] };
    const s = await setup({ threads: { send, stop, output, events } });
    s.db.prepare("INSERT INTO runs (parent_thread_id, child_thread_id, role, tier, provider, model, effort, budget, started_at) VALUES (?,?,?,?,?,?,?,?,?)").run(T, "child-1", "qa", "medium", PROVIDER, "m", "low", 1000, Date.now());
    const emit = async () => { await s.harness.behavior.emitThreadEvent("experimental_thread.events" as never, { thread: makeThreadResponse({ id: "child-1" } as never), sequence: 1 } as never); await s.flush(); };
    used = 1800; await emit(); // 100 + 800 = 900 -> nudge
    expect(send).toHaveBeenCalledTimes(1); expect(stop).not.toHaveBeenCalled();
    used = 2000; await emit(); // 1100 -> stop
    expect(stop).toHaveBeenCalledTimes(1);
  });

  it("closes runs of deleted, archived or failed children", async () => {
    const g = await guardSetup();
    await g.harness.behavior.emitThreadEvent("thread.deleted" as never, { thread: makeThreadResponse({ id: "child-1" } as never) } as never);
    expect(g.run()).toMatchObject({ status: "failed" });
    expect(g.stop).not.toHaveBeenCalled();
  });

  it("CLI spawn/on only for the caller's own thread or a descendant", async () => {
    const g = await guardSetup();
    const run = g.harness.inspection.registrations.cli!.run;
    expect(await run(["on", "--thread", "elsewhere"], { threadId: "me" } as never)).toMatchObject({ exitCode: 1 });
    expect(await run(["on", "--thread", "me"], { threadId: "me" } as never)).toMatchObject({ exitCode: 0 });
    expect(await run(["on", "--thread", "elsewhere"], {} as never)).toMatchObject({ exitCode: 0 });
  });

  it("ignores threads that are not in runs", async () => {
    const g = await guardSetup();
    g.setSpent(5000);
    await g.emit("other-thread");
    expect(g.send).not.toHaveBeenCalled();
    expect(g.stop).not.toHaveBeenCalled();
  });
});

describe("sub-agent provider settings", () => {
  const LARGE = "port the billing service into a plugin"; // scores 9, the bottom of large (set downshiftBias false to keep it there)
  const thread = () => makeThreadResponse({ id: T, providerId: PROVIDER, environmentId: "env1", projectId: "p1" } as never);
  const codexModels = CODEX_CATALOG.map((m) => ({ id: m.id, displayName: m.displayName, isDefault: m.isDefault, supportedReasoningEfforts: m.efforts.map((reasoningEffort) => ({ reasoningEffort })), supportedServiceTiers: [] }));
  const forCodex = (codex: (a: Record<string, unknown>) => Promise<unknown>) => async (a: Record<string, unknown>) => (a.providerId === "codex" ? codex(a) : { models: sdkModels });
  const codexOk = forCodex(async () => ({ models: codexModels }));
  async function withSettings(settings?: Record<string, boolean | number | string>, providerList?: unknown[] | (() => Promise<unknown>), models: (a: Record<string, unknown>) => Promise<unknown> = codexOk, text = MEDIUM) {
    const spawn = vi.fn(async (a: Record<string, unknown>) => ({ id: `child-${spawn.mock.calls.length}`, ...a }));
    const s = await setup({ models, threads: { get: async () => thread(), spawn }, ...(settings ? { settings } : {}), ...(providerList ? { providerList } : {}) });
    await s.hook(s.ctx(text));
    const state = () => s.harness.behavior.callRpc("getPolicy", null) as Promise<{ effective: { roles: Record<string, unknown>; teams: Record<string, { roles: string[] }> } }>;
    const spawnRole = async (role: string) => JSON.stringify(await s.harness.behavior.callAgentTool("gearshift_spawn", { role, prompt: "x" }, { threadId: T } as never));
    const noteText = async () => { const r = s.row("q1", text); await s.queued(r); await s.flush(); return noteBlocks(s.queue.get("q1"))[0]?.text ?? ""; };
    return { ...s, spawn, state, spawnRole, noteText };
  }
  const runs = (s: { db: { prepare: (q: string) => { all: () => unknown[] } } }) => s.db.prepare("SELECT role, provider, budget FROM runs").all();

  it("with the defaults, leaves the team and the editor's policy as they were", async () => {
    const s = await withSettings();
    const { effective } = await s.state();
    expect(effective.roles).not.toHaveProperty("qa-sub");
    expect(effective.teams.medium!.roles).toEqual(["implement", "qa", "verify"]);
    expect(await s.spawnRole("qa")).toMatch(/Spawned qa/);
    expect(s.spawn.mock.calls[0]![0]).toMatchObject({ providerId: PROVIDER });
  });

  it("spawns the moved role on the sub-agent provider's default model with the capped budget", async () => {
    const s = await withSettings({ subagentProvider: "codex", subagentBudgetCap: 64_000 });
    expect(await s.spawnRole("qa-sub")).toMatch(/Spawned qa-sub sub-agent/);
    expect(s.spawn.mock.calls[0]![0]).toMatchObject({ providerId: "codex", model: CODEX_CATALOG.find((m) => m.isDefault)!.id });
    expect(runs(s)).toEqual([{ role: "qa-sub", provider: "codex", budget: 64_000 }]);
  });

  it("accepts the base role name while its -sub role is in the team", async () => {
    const s = await withSettings({ subagentProvider: "codex", subagentBudgetCap: 64_000 });
    const res = await s.spawnRole("qa");
    expect(res).toMatch(/Spawned qa-sub sub-agent/);
    expect(res).not.toMatch(/Note:/);
    expect(runs(s)).toEqual([{ role: "qa-sub", provider: "codex", budget: 64_000 }]);
    expect(await s.spawnRole("architecture")).toMatch(/not in this message's team/);
  });

  it("keeps the derived roles out of the policy the editor saves", async () => {
    const s = await withSettings({ subagentProvider: "codex" });
    const { effective } = await s.state();
    expect(effective.roles).not.toHaveProperty("qa-sub");
    expect(effective.teams.medium!.roles).toEqual(["implement", "qa", "verify"]);
  });

  it("prints the editable policy from the CLI with a footer that lists the derived roles", async () => {
    const s = await withSettings({ subagentProvider: "codex" });
    const run = s.harness.inspection.registrations.cli!.run as unknown as (argv: string[], ctx: Record<string, unknown>) => Promise<{ stdout?: string }>;
    const out = (await run(["policy"], {})).stdout!;
    const [json, footer] = out.split(/\n(?=# )/);
    expect(Object.keys(JSON.parse(json!).roles)).not.toContain("qa-sub");
    expect(footer).toMatch(/implement-sub, qa-sub, verify-sub/);
    const plain = await withSettings();
    const plainRun = plain.harness.inspection.registrations.cli!.run as unknown as typeof run;
    expect((await plainRun(["policy"], {})).stdout).not.toMatch(/^# Roles added/m);
  });

  it("ignores a provider that the host does not list, and uses one it does", async () => {
    const ghost = await withSettings({ subagentProvider: "ghost" }, [{ id: PROVIDER }, { id: "codex" }]);
    await ghost.flush();
    expect((await ghost.state()).effective.teams.medium!.roles).toEqual(["implement", "qa", "verify"]);
    expect(await ghost.spawnRole("qa-sub")).toMatch(/Unknown role .{1,3}qa-sub/);
    expect(await ghost.spawnRole("qa")).toMatch(/Spawned qa/);
    const real = await withSettings({ subagentProvider: "codex" }, [{ id: PROVIDER }, { id: "codex" }]);
    await real.flush();
    expect(await real.spawnRole("qa-sub")).toMatch(/Spawned qa-sub/);
  });

  it("ignores a listed provider whose catalog has no default model", async () => {
    const s = await withSettings({ subagentProvider: "codex" }, [{ id: PROVIDER }, { id: "codex" }], forCodex(async () => ({ models: [] })));
    await s.flush();
    expect((await s.state()).effective.teams.medium!.roles).toEqual(["implement", "qa", "verify"]);
    expect(await s.spawnRole("qa")).toMatch(/Spawned qa sub-agent/);
    expect(runs(s)).toEqual([{ role: "qa", provider: PROVIDER, budget: 120_000 }]);
  });

  describe("fails open when the sub-agent provider has no model at spawn time", () => {
    // No provider list in these hosts, so the setting is trusted and the derived role is in the team.
    const check = async (s: Awaited<ReturnType<typeof withSettings>>, res: string) => {
      expect(res).toMatch(/Spawned qa sub-agent/);
      expect(res).toMatch(/qa-sub had no model available, so qa ran on the lead's provider/);
      expect(s.spawn.mock.calls[0]![0]).toMatchObject({ providerId: PROVIDER, model: "claude-haiku-5-5" });
      expect(runs(s)).toEqual([{ role: "qa", provider: PROVIDER, budget: 120_000 }]); // the base role's budget, not the cap
    };
    it("when the catalog is empty", async () => {
      const s = await withSettings({ subagentProvider: "codex", subagentBudgetCap: 64_000 }, undefined, forCodex(async () => ({ models: [] })));
      await check(s, await s.spawnRole("qa-sub"));
    });
    it("when the catalog lookup throws, asked for by the base name", async () => {
      const s = await withSettings({ subagentProvider: "codex", subagentBudgetCap: 64_000 }, undefined, forCodex(async () => { throw new Error("provider down"); }));
      await check(s, await s.spawnRole("qa"));
    });
    it("when the catalog lookup times out", async () => {
      const pending = withSettings({ subagentProvider: "codex", subagentBudgetCap: 64_000 }, undefined, forCodex(() => new Promise(() => {})));
      await vi.advanceTimersByTimeAsync(5000); // the first message's hook also waits on the hung catalog
      const s = await pending;
      const res = s.spawnRole("qa-sub");
      await vi.advanceTimersByTimeAsync(5000);
      await check(s, await res);
    });
  });

  it("with subagentTiers all, names qa-sub with the capped budget in a large message's note and spawn", async () => {
    const settings = { subagentProvider: "codex", subagentTiers: "all", subagentBudgetCap: 64_000, downshiftBias: false };
    const s = await withSettings(settings, undefined, codexOk, LARGE);
    expect(await s.noteText()).toMatch(/tier=large.*qa-sub → .* on codex \(budget 64k\)/);
    expect(await s.spawnRole("qa-sub")).toMatch(/Spawned qa-sub sub-agent/);
    expect(runs(s)).toEqual([{ role: "qa-sub", provider: "codex", budget: 64_000 }]);
    const small = await withSettings({ ...settings, subagentTiers: "small-medium" }, undefined, codexOk, LARGE);
    expect(await small.noteText()).toMatch(/qa → .*\(budget 150k\)/); // large keeps the lead's provider
  });

  it("follows the settings when they change", async () => {
    const s = await withSettings({}, undefined);
    expect(await s.spawnRole("qa-sub")).toMatch(/Unknown role/);
    await s.harness.behavior.setSettings({ subagentProvider: "codex" });
    expect((await s.state()).effective.teams.medium!.roles).toEqual(["implement", "qa", "verify"]);
    expect(await s.spawnRole("qa-sub")).toMatch(/Spawned qa-sub/);
    await s.harness.behavior.setSettings({ subagentProvider: null });
    expect(await s.spawnRole("qa-sub")).toMatch(/Unknown role/);
  });

  it("trusts a new provider id at once instead of keeping the old provider check", async () => {
    let calls = 0;
    const list = async () => (calls++ === 0 ? [{ id: PROVIDER }] : new Promise<never>(() => {})); // only the first lookup answers
    const s = await withSettings({ subagentProvider: "codex" }, list);
    await s.flush();
    expect(await s.spawnRole("qa-sub")).toMatch(/Unknown role/); // listed without codex: ignored
    await s.harness.behavior.setSettings({ subagentProvider: null });
    await s.harness.behavior.setSettings({ subagentProvider: "codex" });
    expect(await s.spawnRole("qa-sub")).toMatch(/Spawned qa-sub/); // the old verdict is dropped while the new lookup is pending
  });

  it("picks up a provider that appears on a later refresh", async () => {
    const providers: Array<{ id: string }> = [{ id: PROVIDER }];
    const s = await withSettings({ subagentProvider: "codex" }, async () => providers);
    await s.flush();
    expect(await s.spawnRole("qa-sub")).toMatch(/Unknown role/);
    providers.push({ id: "codex" });
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(await s.spawnRole("qa-sub")).toMatch(/Spawned qa-sub/);
  });

  it("stops polling providers when the plugin is disposed", async () => {
    const list = vi.fn(async () => [{ id: PROVIDER }, { id: "codex" }]);
    const s = await withSettings({ subagentProvider: "codex" }, list);
    await s.flush();
    const before = list.mock.calls.length;
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(list.mock.calls.length).toBe(before + 1);
    expect(vi.getTimerCount()).toBeGreaterThan(0);
    await s.harness.lifecycle.dispose();
    expect(vi.getTimerCount()).toBe(0); // the refresh interval is gone with the rest
    await vi.advanceTimersByTimeAsync(30 * 60_000);
    expect(list.mock.calls.length).toBe(before + 1);
  });

  it("does not poll when the host has no provider list, and trusts the setting", async () => {
    const s = await withSettings({ subagentProvider: "codex" });
    expect((await s.state()).effective.teams.medium!.roles).toEqual(["implement", "qa", "verify"]);
    expect(await s.spawnRole("qa-sub")).toMatch(/Spawned qa-sub/);
  });
});

describe("CLI review and policy edits", () => {
  type Run = (argv: string[], ctx: Record<string, unknown>) => Promise<{ exitCode: number; stdout?: string; stderr?: string }>;
  async function cli() {
    const s = await setup();
    const run = s.harness.inspection.registrations.cli!.run as unknown as Run;
    const getPolicy = () => s.harness.behavior.callRpc("getPolicy", null) as Promise<{ overrides: Record<string, unknown>; effective: { tiers: Record<string, { min: number; max: number }> } }>;
    return { ...s, run, getPolicy };
  }

  it("review prints text, --json prints the object, and bad --days is rejected", async () => {
    const c = await cli();
    c.db.prepare("INSERT INTO decisions (at, thread_id, provider_id, initiator, attempt, action, reason, tier, score, signals) VALUES (?,?,?,?,?,?,?,?,?,?)")
      .run(Date.now() - 1000, "thr-9", "claude-code", "user", "start-turn", "shift", "", "large", 10, '["build"]');
    const text = await c.run(["review", "--days", "7"], {});
    expect(text.exitCode).toBe(0);
    expect(text.stdout).toContain("last 7 days");
    expect(text.stdout).toContain("Large: 1");
    const json = await c.run(["review", "--json"], {});
    const parsed = JSON.parse(json.stdout!) as { period: { days: number }; counts: { total: number } };
    expect(parsed.period.days).toBe(30);
    expect(parsed.counts.total).toBe(1);
    for (const bad of ["0", "366", "abc", "1.5"]) expect(await c.run(["review", "--days", bad], {})).toMatchObject({ exitCode: 1 });
  });

  it("policy set stores minimal overrides, prints old to new and updates routing", async () => {
    const c = await cli();
    const r = await c.run(["policy", "set", "tiers.large.max", "12"], {});
    expect(r).toMatchObject({ exitCode: 0, stdout: "tiers.large.max: 11 → 12" });
    const state = await c.getPolicy();
    expect(state.overrides).toEqual({ tiers: { large: { max: 12 }, xlarge: { min: 13 } } });
    expect(state.effective.tiers.xlarge!.min).toBe(13);
    const printed = JSON.parse((await c.run(["policy"], {})).stdout!) as { tiers: Record<string, { max: number }> };
    expect(printed.tiers.large!.max).toBe(12);
  });

  it("unset, add-pattern and remove-pattern round-trip", async () => {
    const c = await cli();
    await c.run(["policy", "set", "gears.claude-code.xlarge.effort", "high"], {});
    expect((await c.getPolicy()).overrides).toHaveProperty("gears");
    expect(await c.run(["policy", "unset", "gears.claude-code.xlarge.effort"], {})).toMatchObject({ exitCode: 0 });
    expect((await c.getPolicy()).overrides).toEqual({});
    expect(await c.run(["policy", "add-pattern", "action", "\\bzzz\\b"], {})).toMatchObject({ exitCode: 0 });
    expect((await c.getPolicy()).overrides).toHaveProperty("scoring");
    expect(await c.run(["policy", "remove-pattern", "action", "\\bzzz\\b"], {})).toMatchObject({ exitCode: 0 });
    expect((await c.getPolicy()).overrides).toEqual({});
  });

  it("invalid edits exit 1 and store nothing", async () => {
    const c = await cli();
    for (const argv of [["policy", "set", "tiers.large.max", "8"], ["policy", "set", "nope", "1"], ["policy", "set", "scoring.unmatchedScore", "x"], ["policy", "add-pattern", "action", "(a+)+$"], ["policy", "set", "tiers.large.max"], ["policy", "bogus"]]) {
      expect(await c.run(argv, {})).toMatchObject({ exitCode: 1 });
    }
    expect((await c.getPolicy()).overrides).toEqual({});
  });

  it("policy edits are global: allowed for any calling thread", async () => {
    const c = await cli();
    expect(await c.run(["policy", "set", "scoring.unmatchedScore", "2"], { threadId: "some-agent-thread" })).toMatchObject({ exitCode: 0 });
  });

  it("help lists the new commands", async () => {
    const c = await cli();
    const help = await c.run(["help"], {});
    expect(help.stdout).toContain("bb gearshift review");
    expect(help.stdout).toContain("add-pattern");
    expect(help.stdout).toContain("bb gearshift replay");
  });

  const insert = (c: { db: Awaited<ReturnType<typeof setup>>["db"] }, thread: string, tier: string, score: number, extra: { output?: number; at?: number } = {}) =>
    c.db.prepare("INSERT INTO decisions (at, thread_id, provider_id, initiator, attempt, action, reason, tier, score, signals, routed_model, routed_effort, routed_label, output_tokens) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
      .run(extra.at ?? Date.now() - 1000, thread, "claude-code", "user", "start-turn", "shift", "", tier, score, "[]", "claude-opus-5-5", "xhigh", "Opus 5.5", extra.output ?? null);

  it("replay prints a before and after report, also through review --replay, and takes repeatable --set", async () => {
    const c = await cli();
    for (let i = 0; i < 3; i++) insert(c, `thr-${i}`, "small", 5); // 4 would be the bottom of medium and lean back down
    const rp = await c.run(["replay", "--days", "7", "--set", "tiers.small.max=3", "--set", "routing.holdAboveTokens=30000"], {});
    expect(rp.exitCode).toBe(0);
    expect(rp.stdout).toContain("Gearshift replay: last 7 days");
    expect(rp.stdout).toContain("Under the current policy with: tiers.small.max=3, routing.holdAboveTokens=30000");
    expect(rp.stdout).toMatch(/- Small: 3 \(100%\) → 0 \(0%\)/);
    expect(rp.stdout).toMatch(/- Medium: 0 \(0%\) → 3 \(100%\)/);
    expect(rp.stdout).toContain("What is estimated");
    const viaReview = await c.run(["review", "--replay", "--days", "7", "--set", "tiers.small.max=3", "--set", "routing.holdAboveTokens=30000"], {});
    expect(viaReview.stdout).toBe(rp.stdout);
    const json = JSON.parse((await c.run(["replay", "--json"], {})).stdout!) as { rows: number; period: { days: number }; edits: string[] };
    expect(json).toMatchObject({ rows: 3, period: { days: 30 }, edits: [] });
    expect((await c.getPolicy()).overrides).toEqual({}); // a replay never saves anything
  });

  it("replay takes --set routing.downshiftBias and reports turns that run on a lower gear", async () => {
    const c = await cli();
    insert(c, "thr-1", "large", 9); // the bottom of large: recorded before the bias existed
    const on = await c.run(["replay", "--days", "7"], {});
    expect(on.exitCode).toBe(0);
    expect(on.stdout).toMatch(/- Large: 1 \(100%\) → 0 \(0%\)/);
    expect(on.stdout).toMatch(/Lower gear: 1 turns run on a lower gear/);
    const off = await c.run(["replay", "--days", "7", "--set", "routing.downshiftBias=false"], {});
    expect(off.exitCode).toBe(0);
    expect(off.stdout).toMatch(/- Large: 1 \(100%\) → 1 \(100%\)/);
    expect(off.stdout).toMatch(/Opus 5\.5 · XHigh → Opus 5\.5 · High/); // large's own gear: still lower than the recorded xhigh, but the same model
    expect(on.stdout).toMatch(/Opus 5\.5 · XHigh → Opus 5\.5 · High/); // medium keeps the lead on Opus
    expect((await c.run(["replay", "--set", "routing.downshiftBias=maybe"], {})).stderr).toMatch(/takes true or false/);
  });

  it("calibrate proposes a downshift, --apply saves it, and every run is logged", async () => {
    const c = await cli();
    const add = (thread: string, effort: string) => c.db.prepare("INSERT INTO decisions (at, thread_id, provider_id, initiator, attempt, action, reason, tier, scored_tier, score, signals, fingerprint, routed_model, routed_effort, routed_label, output_tokens) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
      .run(Date.now() - 3_600_000, thread, "claude-code", "user", "start-turn", "shift", "", "small", "small", 4, "[]", `fp-${thread}`, "claude-opus-5-5", effort, "Opus 5.5", 400);
    for (let i = 0; i < 12; i++) add(`thr-low-${i}`, "low");
    const dry = await c.run(["calibrate", "--days", "7"], {});
    expect(dry.exitCode).toBe(0);
    expect(dry.stdout).toContain("Proposed 1 downshift");
    expect(dry.stdout).toContain("--set gears.claude-code.small.effort=low");
    expect((await c.getPolicy()).overrides).toEqual({});
    const json = JSON.parse((await c.run(["calibrate", "--json"], {})).stdout!) as { proposals: unknown[]; applied: boolean };
    expect(json).toMatchObject({ applied: false });
    expect(json.proposals).toHaveLength(1);
    const applied = await c.run(["calibrate", "--apply"], {});
    expect(applied.stdout).toContain("Applied 1 downshift");
    expect((await c.getPolicy()).overrides).toEqual({ gears: { "claude-code": expect.objectContaining({ small: { model: "opus", effort: "low" } }) } });
    const again = await c.run(["calibrate"], {});
    expect(again.stdout).toContain("No routing change.");
    const logged = c.db.prepare("SELECT applied, proposals FROM calibrations ORDER BY id").all();
    expect(logged).toEqual([{ applied: 0, proposals: 1 }, { applied: 0, proposals: 1 }, { applied: 1, proposals: 1 }, { applied: 0, proposals: 0 }]);
    for (const bad of [["calibrate", "--days", "0"], ["calibrate", "--min-samples", "1"]]) expect(await c.run(bad, {})).toMatchObject({ exitCode: 1 });
  });

  it("replay rejects a bad --set, a bad --days and --set without --replay", async () => {
    const c = await cli();
    insert(c, "thr-1", "small", 4);
    const err = async (argv: string[]) => { const r = await c.run(argv, {}); expect(r.exitCode).toBe(1); return r.stderr!; };
    expect(await err(["replay", "--set", "tiers.small.max"])).toMatch(/path=value/);
    expect(await err(["replay", "--set"])).toMatch(/path=value/);
    expect(await err(["replay", "--set", "nope.nope=1"])).toMatch(/Unknown path/);
    expect(await err(["replay", "--set", "routing.holdAboveTokens=lots"])).toMatch(/whole number/);
    expect(await err(["replay", "--set", "routing.routeNotes=false"])).toMatch(/not replayable/);
    expect(await err(["replay", "--days", "0"])).toMatch(/--days/);
    expect(await err(["review", "--set", "tiers.small.max=3"])).toMatch(/--replay/);
  });

  it("review lists thread titles fetched at report time, ignores failed lookups, and never stores a title", async () => {
    const get = vi.fn(async ({ threadId }: { threadId: string }) => {
      if (threadId === "thr-broken") throw new Error("gone");
      return makeThreadResponse({ id: threadId, title: "Fix the login flow" } as never);
    });
    const s = await setup({ threads: { get } });
    const run = s.harness.inspection.registrations.cli!.run as unknown as (argv: string[], ctx: Record<string, unknown>) => Promise<{ exitCode: number; stdout?: string }>;
    insert({ db: s.db }, "thr-1", "large", 10, { output: 100 });
    insert({ db: s.db }, "thr-broken", "xlarge", 13, { output: 100 });
    const text = await run(["review"], {});
    expect(text.exitCode).toBe(0);
    expect(text.stdout).toContain('thread thr-1 "Fix the login flow"');
    expect(text.stdout).toContain("thread thr-broken xlarge");
    const json = JSON.parse((await run(["review", "--json"], {})).stdout!) as { overkill: Array<{ threadId: string; threadTitle?: string }> };
    expect(json.overkill.find((t) => t.threadId === "thr-1")!.threadTitle).toBe("Fix the login flow");
    expect(json.overkill.find((t) => t.threadId === "thr-broken")!.threadTitle).toBeUndefined();
    expect(JSON.stringify(s.db.prepare("SELECT * FROM decisions").all())).not.toContain("Fix the login flow");
  });
});

describe("downshift bias", () => {
  it("records the tier the score gave next to the routed tier, and follows the setting", async () => {
    const on = await setup();
    await on.hook(on.ctx(SMALL)); // score 3: the bottom of small
    expect(on.decisions()[0]).toMatchObject({ action: "shift", tier: "trivial", scored_tier: "small", score: 3 });
    expect(on.decisions()[0]!.reason).toContain("(leaning lower: score 3 is the bottom of small)");
    const off = await setup({ settings: { downshiftBias: false } });
    await off.hook(off.ctx(SMALL));
    expect(off.decisions()[0]).toMatchObject({ tier: "small", scored_tier: "small" });
    expect(off.decisions()[0]!.reason).not.toContain("leaning lower");
  });
  it("records the same tier twice when the message is not biased (a named model, a manual pick)", async () => {
    const s = await setup();
    await s.hook(s.ctx("use opus please"));
    await s.hook(s.ctx(SMALL, { executionSources: { model: "explicit" } }));
    const [named, manual] = s.decisions();
    expect(named!.scored_tier).toBe(named!.tier);
    expect(manual).toMatchObject({ action: "manual" });
    expect(manual!.scored_tier).toBe(manual!.tier);
  });
});

describe("held messages", () => {
  it("record the hold kind, the decision whose gear was inherited, the gear before and the policy stamp", async () => {
    let used = 1000;
    const s = await setup({
      settings: { downshiftBias: false }, // this test follows the hold rule, not the bias
      defaults: async () => ({ model: "claude-opus-5-5", reasoningLevel: "xhigh", serviceTier: null }),
      threads: { events: { list: async () => [{ data: { contextWindowUsage: { usedTokens: used } } }] } },
    });
    const live = { thread: { id: T, providerId: PROVIDER, status: "idle" } }; // not a pending thread: it has a gear and a context
    await s.hook(s.ctx(SMALL, live)); // short context: runs on its own gear, which becomes the origin
    used = 100_000;
    await s.hook(s.ctx("rename the variable foo to bar", live));
    const [first, second] = s.decisions();
    expect(first).toMatchObject({ action: "shift", hold_kind: null, hold_origin_id: null, current_model: "claude-opus-5-5", current_effort: "xhigh" });
    expect(second).toMatchObject({ action: "hold", hold_kind: "effort", hold_origin_id: first!.id, current_model: "claude-opus-5-5", current_effort: "xhigh", routed_model: "claude-opus-5-5", context_tokens: 100_000 });
    expect(second!.routed_effort).not.toBe("xhigh");
    expect(first!.policy_rev).toMatch(/^[0-9a-f]{8}$/);
    expect(second!.policy_rev).toBe(first!.policy_rev);
  });
});

describe("listModels host fallback", () => {
  it("falls back to per-host queries when the plain call fails", async () => {
    const calls: Array<Record<string, unknown>> = [];
    const models = async (a: Record<string, unknown>) => {
      calls.push(a);
      if (!a.hostId) throw new Error("Local host daemon is not initialized");
      if (a.hostId === "h-down") throw new Error("down");
      return { models: sdkModels };
    };
    const s = await setup({ models, hosts: [{ id: "h-down", status: "disconnected" }, { id: "h-up", status: "connected" }] });
    expect(await s.hook(s.ctx(SMALL))).toMatchObject({ action: "wait" });
    const hostCalls = calls.filter((c) => c.hostId).map((c) => c.hostId);
    expect(hostCalls[0]).toBe("h-up"); // connected hosts first
  });
});
