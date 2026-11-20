// Integration tests for the message.dispatch hook, the message.queued listener and amend, on the official fake host.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFakePluginHost, makeMessageDispatchHookContext, makeQueueEntry } from "@get-bb/plugin-sdk/testing";
import plugin from "../server";
import { CLAUDE_CATALOG } from "./fixtures";

type Row = ReturnType<typeof makeQueueEntry>;
const PROVIDER = "claude-code";
const T = "thread-1";
const SMALL = "fix the typo in the README";
const sdkModels = CLAUDE_CATALOG.map((m) => ({
  id: m.id, displayName: m.displayName, isDefault: m.isDefault, defaultReasoningEffort: m.defaultEffort ?? undefined,
  supportedReasoningEfforts: m.efforts.map((reasoningEffort) => ({ reasoningEffort })),
  supportedServiceTiers: m.serviceTiers.map((id) => ({ id })),
}));

interface Opts { settings?: Record<string, boolean | number>; models?: () => Promise<unknown>; defaults?: () => Promise<unknown> }

async function setup(o: Opts = {}) {
  // In-memory queue model: rows the plugin can list and amend.
  const queue = new Map<string, Row>();
  const update = vi.fn(async (a: { threadId: string; queuedMessageId: string; model?: string; reasoningLevel?: string }) => {
    const r = queue.get(a.queuedMessageId);
    if (!r) throw new Error("no such row");
    queue.set(r.id, { ...r, model: a.model ?? r.model, reasoningLevel: a.reasoningLevel ?? r.reasoningLevel, updatedAt: r.updatedAt + 1 });
    return queue.get(r.id);
  });
  const { bb, harness } = createFakePluginHost({
    pluginId: "gearshift",
    ...(o.settings ? { settings: o.settings } : {}),
    sdk: {
      providers: { models: o.models ?? (async () => ({ models: sdkModels })) },
      threads: {
        defaultExecutionOptions: o.defaults ?? (async () => ({ model: "claude-opus-5-5", reasoningLevel: "high", serviceTier: null })),
        events: { list: async () => [] },
        queuedMessages: { list: async () => [...queue.values()], update },
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
    expect(arg.model).not.toBe("claude-opus-5-5");
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
    expect(s.queue.get("q1")!.model).not.toBe("claude-opus-5-5");
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
