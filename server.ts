// Gearshift backend: routes each message to the right model + effort via the message.dispatch hook.
import { defineRpcContract, type BbPluginApi, type MessageDispatchHookContext } from "@get-bb/plugin-sdk";
import { buildOverview, toDto } from "./lib/analytics";
import { classify } from "./lib/classify";
import { bounded } from "./lib/bounded";
import { DECISIONS_CHANGED } from "./lib/channels";
import { rpcContract, type PolicyStateDto, type PreviewDto, type ProvidersDto, type ThreadStateDto } from "./lib/contract";
import { resolveGear, sizeClass, toCatalog, type CatalogModel, type Gear } from "./lib/gears";
import { DEFAULT_POLICY, compilePolicy, ladderFor, removeOverridePath, resolvePolicy, type CompiledPolicy, type Policy, type PolicyError, type PolicyOverrides } from "./lib/policy";
import { costUsd, priceFor, tierMultiplier, type Usage } from "./lib/pricing";
import { decide, type Decision } from "./lib/router";
import { fingerprint, Store, type DecisionRow, type NewDecision } from "./lib/store";
import { NOTE_PREFIX, formatBudget, formatRouteNote, gearLabel, guardAction, noteWorthy, providersFor, resolveRole, roleTarget, spendTokens } from "./lib/team";
import { TIERS, type Tier } from "./lib/policy";

export { rpcContract };
void defineRpcContract;

const CATALOG_TTL = 10 * 60_000;
const ARM_TTL = 15 * 60_000;
const LOOKUP_MS = 1500; // one budget for every lookup the hook makes
const PROVIDER_MS = 4000;
const LINK_WINDOW_MS = 2 * 60_000; // a queue row appears right after the hook returns
const REATTEMPT_LINK_WINDOW_MS = 30 * 60_000;
const POLICY_KEY = "policy-overrides";
/** Not configurable from the policy editor: prices stay internal, routing switches are plain settings. */
const NOT_OVERRIDABLE = ["prices", "serviceTierMultipliers", "baselineModel", "routing"] as const;
type QueuedRow = MessageDispatchHookContext["queuedMessages"][number];
const rowText = (r: QueuedRow) => r.content.map((b) => ("text" in b ? b.text : "")).join(" ");
const DAY = 86_400_000;
const norm = (s: string) => s.replace(/\s+/g, " ").trim();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
export default async function plugin(bb: BbPluginApi) {
  const { z } = await import("zod");
  const settings = bb.settings.define({
    enabled: { type: "boolean", label: "Enable Gearshift", description: "Turn routing off everywhere without uninstalling.", default: true },
    defaultOn: { type: "boolean", label: "Start new threads with Gearshift on", description: "Threads you have not toggled yourself follow this. The per-thread toggle always wins.", default: true },
    respectManualPicks: { type: "boolean", label: "A model picked by hand wins", description: "When you choose a model in the composer, Gearshift leaves that message alone.", default: true },
    routeAgentMessages: { type: "boolean", label: "Route messages from other agents", description: "Also pick a model for messages that other threads or agents send into a thread.", default: true },
    holdAboveTokens: { type: "number", label: "Don't downshift threads above this many context tokens (0 = never hold)", description: "Switching to a cheaper model on a big context re-reads it uncached, so Gearshift keeps the current model instead.", default: 60000, experimental_schema: z.number().int().min(0) },
    routeNotes: { type: "boolean", label: "Add a team note to medium and larger messages", description: "Tells the agent which sub-agent roles to spawn (gearshift_spawn), on which models, with what budgets. Invisible in the chat.", default: true },
    retentionDays: { type: "number", label: "Days of history kept", description: "Routing decisions older than this are deleted.", default: 90, experimental_schema: z.number().int().min(1).max(3650) },
  });
  let cfg = await settings.get();

  // ---- policy ----------------------------------------------------------
  // Overrides (scoring, gears, patterns) live in plugin storage; the routing switches come from the settings above.
  let overrides: PolicyOverrides = {};
  let policyErrors: PolicyError[] = [];
  let compiled: CompiledPolicy = compilePolicy(DEFAULT_POLICY);
  const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
  /** Splits off the keys the editor may not set, with one error per stripped path. */
  const stripLocked = (o: Record<string, unknown>): { clean: PolicyOverrides; errors: PolicyError[] } => {
    const clean: Record<string, unknown> = {};
    const errors: PolicyError[] = [];
    for (const [k, v] of Object.entries(o)) {
      if ((NOT_OVERRIDABLE as readonly string[]).includes(k)) errors.push({ path: k, message: k === "routing" ? "Routing switches are plugin settings, not policy overrides" : "Not configurable: cost estimates use built-in list prices" });
      else clean[k] = v;
    }
    return { clean: clean as PolicyOverrides, errors };
  };
  const routingFromSettings = (c: typeof cfg): Policy["routing"] => ({
    defaultOn: c.defaultOn ?? DEFAULT_POLICY.routing.defaultOn,
    respectManualPicks: c.respectManualPicks ?? DEFAULT_POLICY.routing.respectManualPicks,
    routeAgentMessages: c.routeAgentMessages ?? DEFAULT_POLICY.routing.routeAgentMessages,
    holdAboveTokens: c.holdAboveTokens ?? DEFAULT_POLICY.routing.holdAboveTokens,
    routeNotes: c.routeNotes ?? DEFAULT_POLICY.routing.routeNotes,
  });
  /** Overrides on top of the defaults, with the routing section taken from the settings. Null when it does not compile. */
  const build = (o: PolicyOverrides): { compiled: CompiledPolicy; errors: PolicyError[] } => {
    const { effective, errors } = resolvePolicy(stripLocked(o).clean);
    try { return { compiled: compilePolicy({ ...effective, routing: routingFromSettings(cfg) }), errors }; }
    catch (e) { return { compiled: compilePolicy({ ...DEFAULT_POLICY, routing: routingFromSettings(cfg) }), errors: [...errors, { path: "policy", message: String(e) }] }; }
  };
  const rebuild = () => {
    const r = build(overrides);
    compiled = r.compiled; policyErrors = r.errors;
    if (policyErrors.length) bb.log.warn(`invalid saved policy, routing with defaults: ${policyErrors[0]!.path}: ${policyErrors[0]!.message}`);
  };
  try {
    const saved = await bb.storage.kv.get<unknown>(POLICY_KEY);
    overrides = isObj(saved) ? stripLocked(saved).clean : {};
  } catch (e) { bb.log.warn(`could not read saved policy: ${String(e)}`); }
  rebuild();
  settings.onChange((next) => { cfg = next; rebuild(); });
  const policyState = (ok = true, extra: PolicyError[] = []): PolicyStateDto => ({
    ok: ok && policyErrors.length === 0, defaults: DEFAULT_POLICY, overrides, effective: compiled.policy, errors: [...extra, ...policyErrors],
  });

  const store = Store.migrate(bb.storage.database(), (db, s) => bb.storage.migrate(db, s));
  const timers = new Set<ReturnType<typeof setTimeout>>();
  let disposed = false;
  bb.onDispose(() => { disposed = true; for (const t of timers) clearTimeout(t); timers.clear(); });
  const later = (ms: number, fn: () => void) => {
    const t = setTimeout(() => { timers.delete(t); if (!disposed) fn(); }, ms);
    timers.add(t);
  };
  const changed = (threadId: string) => bb.realtime.publish(DECISIONS_CHANGED, { threadId });

  const prune = () => { try { store.prune(Date.now() - cfg.retentionDays * DAY); } catch (e) { bb.log.warn(`prune failed: ${String(e)}`); } };
  prune();
  const pruneTimer = setInterval(prune, DAY);
  bb.onDispose(() => clearInterval(pruneTimer));

  // ---- catalog ---------------------------------------------------------
  const catalogCache = new Map<string, { at: number; models: CatalogModel[] }>();
  /** Not bounded here: callers race it so a late answer still lands in the cache. */
  /**
   * The provider's model list. The catalog is host-scoped on some servers, so with no environment or host
   * named, a call without a host can fail ("Local host daemon is not initialized"): fall back to the hosts,
   * connected ones first, until one lists models. Throws the first error when nothing answered.
   */
  async function listModels(p: { providerId: string; environmentId?: string | null; hostId?: string | null; projectId?: string | null }) {
    const base = { providerId: p.providerId, preferCached: true };
    if (p.environmentId) return (await bb.sdk.providers.models({ ...base, environmentId: p.environmentId })).models;
    if (p.hostId) return (await bb.sdk.providers.models({ ...base, hostId: p.hostId, ...(p.projectId ? { projectId: p.projectId } : {}) })).models;
    let first: unknown = null;
    try {
      const res = await bb.sdk.providers.models({ ...base, ...(p.projectId ? { projectId: p.projectId } : {}) });
      if (res.models.length) return res.models;
    } catch (e) { first = e; }
    const hosts = await bb.sdk.hosts.list().catch(() => []);
    const ordered = [...hosts].sort((a, b) => Number(b.status === "connected") - Number(a.status === "connected"));
    for (const h of ordered) {
      try {
        const res = await bb.sdk.providers.models({ ...base, hostId: h.id });
        if (res.models.length) return res.models;
      } catch (e) { first = first ?? e; }
    }
    if (first) throw first;
    return [];
  }
  async function catalogFor(p: { providerId: string; environmentId?: string | null; hostId?: string | null; projectId?: string | null }): Promise<CatalogModel[] | null> {
    const key = `${p.providerId}|${p.environmentId ?? ""}|${p.hostId ?? ""}|${p.projectId ?? ""}`;
    const hit = catalogCache.get(key);
    if (hit && Date.now() - hit.at < CATALOG_TTL) return hit.models;
    try {
      const models = toCatalog(await listModels(p));
      if (models.length) { catalogCache.set(key, { at: Date.now(), models }); return models; }
    } catch { /* fall through */ }
    return null;
  }

  async function currentGear(threadId: string, pending: boolean) {
    if (pending) return null;
    try {
      const o = await bb.sdk.threads.defaultExecutionOptions({ threadId });
      return o ? { model: o.model, effort: o.reasoningLevel || null, serviceTier: o.serviceTier || null } : null;
    } catch { return null; }
  }
  async function contextTokens(threadId: string): Promise<number | null> {
    try {
      const rows = await bb.sdk.threads.events.list({ threadId, types: ["thread/contextWindowUsage/updated"], order: "desc", limit: "1" });
      const d = rows[0]?.data as { contextWindowUsage?: { usedTokens?: number | null } } | undefined;
      return d?.contextWindowUsage?.usedTokens ?? null;
    } catch { return null; }
  }

  // ---- thread toggle + new-thread arming -------------------------------
  const armed = new Map<string, { projectId: string | null; text: string; at: number; enabled: boolean }>();
  const sweepArmed = () => { for (const [k, v] of armed) if (Date.now() - v.at > ARM_TTL) armed.delete(k); };
  function takeArmed(projectId: string, text: string): boolean | null {
    sweepArmed();
    const want = norm(text);
    const hit = [...armed.entries()].find(([, v]) => v.projectId === projectId && norm(v.text) === want);
    if (!hit) return null;
    armed.delete(hit[0]);
    return hit[1].enabled;
  }
  const threadOn = (threadId: string) => store.getPref(threadId) ?? compiled.policy.routing.defaultOn;

  // ---- baseline + usage ------------------------------------------------
  const baselineFor = (providerId: string, catalog: CatalogModel[] | null) =>
    compiled.policy.baselineModel?.trim() || (catalog ? resolveGear(ladderFor(compiled.policy, providerId).xlarge, catalog)?.model ?? null : null);
  function costs(model: string | null, baseline: string | null, serviceTier: string | null, u: Usage) {
    const p = compiled.policy;
    const mult = tierMultiplier(p, serviceTier);
    return {
      cost: model ? costUsd(u, priceFor(model, p.prices), mult) : null,
      base: baseline ? costUsd(u, priceFor(baseline, p.prices), mult) : null,
    };
  }

  // ---- amend -----------------------------------------------------------
  // Decisions waiting for their queue row to appear (inline attempts): decision id -> what to amend with.
  const awaitingRow = new Map<number, { threadId: string; gear: Gear | null; note: string | null }>();

  async function amendOne(threadId: string, row: QueuedRow, gear: Gear | null, note: string | null): Promise<boolean> {
    let cur: QueuedRow | undefined = row;
    for (let tries = 0; tries < 3 && cur && !disposed; tries++) {
      try {
        const hasNote = cur.content.some((b) => "text" in b && b.text.startsWith(NOTE_PREFIX)); // never twice
        await bb.sdk.threads.queuedMessages.update({
          threadId, queuedMessageId: cur.id, expectedUpdatedAt: cur.updatedAt,
          ...(gear ? { model: gear.model } : {}),
          ...(gear?.effort ? { reasoningLevel: gear.effort } : {}), ...(gear?.serviceTier ? { serviceTier: gear.serviceTier } : {}),
          ...(note && !hasNote ? { input: [...cur.content, { type: "text", text: note, mentions: [], visibility: "agent-only" }] as never } : {}),
        });
        return true;
      } catch (e) {
        bb.log.debug(`amend retry: ${String(e)}`);
        await sleep(50);
        const rowId: string = cur.id;
        cur = (await bb.sdk.threads.queuedMessages.list({ threadId }).catch(() => [] as QueuedRow[])).find((r) => r.id === rowId);
      }
    }
    return false;
  }

  async function amendRows(threadId: string, decisionId: number, rows: QueuedRow[], gear: Gear | null, note: string | null) {
    let ok = rows.length > 0;
    try { for (const [i, r] of rows.entries()) ok = (await amendOne(threadId, r, gear, i === rows.length - 1 ? note : null)) && ok; }
    catch (e) { ok = false; bb.log.warn(`amend failed: ${String(e)}`); }
    const cur = store.get(decisionId);
    if (cur && cur.amend_status === "pending") store.patch(decisionId, { amend_status: ok ? "done" : "failed" });
    changed(threadId);
    const ids = new Set(rows.map((r) => r.id));
    const recheck = () => { void bb.experimental_hooks.recheck("message.dispatch").catch(() => {}); };
    recheck();
    for (const ms of [1200, 3000]) later(ms, async () => {
      try {
        const left = await bb.sdk.threads.queuedMessages.list({ threadId });
        if (left.some((r) => ids.has(r.id) && r.waitingOn?.kind === "plugin" && r.waitingOn.pluginId === bb.pluginId)) recheck();
      } catch { /* ignore */ }
    });
  }

  /** Link a queue row to the newest unlinked decision with the same text; undefined when none matches or it is linked already. */
  function linkRow(threadId: string, row: QueuedRow, windowMs: number): DecisionRow | undefined {
    if (store.forQueued(threadId, row.id)) return undefined;
    const d = store.unlinkedByFingerprint(threadId, fingerprint(threadId, rowText(row)), Date.now() - windowMs);
    if (!d) return undefined;
    store.linkQueued(d.id, threadId, [row.id]);
    return d;
  }
  /** Amend a row that just got linked to a decision still waiting for it. */
  function amendLinked(threadId: string, d: DecisionRow | undefined, row: QueuedRow) {
    const want = d && awaitingRow.get(d.id);
    if (!d || !want) return;
    awaitingRow.delete(d.id);
    void amendRows(threadId, d.id, [row], want.gear, want.note);
  }

  bb.events.on("message.queued", ({ entry }) => {
    try { amendLinked(entry.threadId, linkRow(entry.threadId, entry, LINK_WINDOW_MS), entry); }
    catch (e) { bb.log.warn(`queue link failed: ${String(e)}`); }
  });

  /** Backup if the event never arrives: poll the queue for the exact message text. */
  async function pollForRow(threadId: string, decisionId: number) {
    const started = Date.now();
    while (awaitingRow.has(decisionId) && !disposed && Date.now() - started < 5000) {
      try {
        const rows = await bb.sdk.threads.queuedMessages.list({ threadId });
        for (const r of rows) amendLinked(threadId, linkRow(threadId, r, LINK_WINDOW_MS), r);
      } catch (e) { bb.log.debug(`row poll: ${String(e)}`); }
      if (awaitingRow.has(decisionId)) await sleep(250);
    }
    if (awaitingRow.delete(decisionId)) {
      const cur = store.get(decisionId);
      if (cur && cur.amend_status === "pending") store.patch(decisionId, { amend_status: "failed" });
      changed(threadId);
    }
  }


  // ---- teams: route note, spawn, budget guard ------------------------------
  let spawning = 0;
  const parentOf = (t: unknown) => (t as { parentThreadId?: string | null }).parentThreadId ?? null;

  /** Catalogs for every provider the team's roles run on (the parent's is passed in). */
  async function catalogsFor(roles: readonly string[], parentProviderId: string, tier: Tier, scope: { environmentId?: string | null; hostId?: string | null; projectId?: string | null }, parentCatalog: CatalogModel[] | null) {
    const out = new Map<string, CatalogModel[]>();
    if (parentCatalog) out.set(parentProviderId, parentCatalog);
    for (const pid of providersFor(compiled.policy, roles, parentProviderId, tier)) {
      if (out.has(pid)) continue;
      const c = await catalogFor({ providerId: pid, ...(pid === parentProviderId ? scope : { projectId: scope.projectId }) });
      if (c) out.set(pid, c);
    }
    return out;
  }
  async function buildNote(tier: Tier, score: number | null, providerId: string, scope: { environmentId?: string | null; hostId?: string | null; projectId?: string | null }, parentCatalog: CatalogModel[] | null): Promise<string | null> {
    try {
      const catalogs = await catalogsFor(compiled.policy.teams[tier].roles, providerId, tier, scope, parentCatalog);
      return formatRouteNote({ tier, score, policy: compiled.policy, parentProviderId: providerId, catalogs });
    } catch (e) { bb.log.warn(`route note failed: ${String(e)}`); return null; }
  }

  interface SpawnResult { ok: true; childThreadId: string; role: string; providerId: string; label: string; effort: string | null; budget: number; tier: Tier }
  async function spawnRole(parentThreadId: string, roleName: string, prompt: string, title?: string): Promise<SpawnResult | { ok: false; error: string }> {
    try {
      const parent = await bb.sdk.threads.get({ threadId: parentThreadId });
      const tier = (store.lastForThread(parentThreadId)?.tier as Tier | null) ?? "medium";
      const target = roleTarget(compiled.policy, roleName, parent.providerId, tier);
      if (!target) return { ok: false, error: `Unknown role "${roleName}". Roles: ${Object.keys(compiled.policy.roles).join(", ")}` };
      const catalog = await catalogFor({ providerId: target.providerId, ...(target.providerId === parent.providerId ? { environmentId: parent.environmentId } : {}), projectId: parent.projectId });
      const r = catalog ? resolveRole(compiled.policy, roleName, parent.providerId, tier, new Map([[target.providerId, catalog]])) : null;
      if (!r?.gear) return { ok: false, error: `No model for role "${roleName}" on ${target.providerId}` };
      if (!parent.environmentId) return { ok: false, error: "The calling thread has no environment yet" };
      const g = r.gear;
      spawning++;
      let child;
      try {
        child = await bb.sdk.threads.spawn({
          projectId: parent.projectId, environment: { type: "reuse", environmentId: parent.environmentId }, parentThreadId,
          providerId: target.providerId, model: g.model, ...(g.effort ? { reasoningLevel: g.effort } : {}), ...(g.serviceTier ? { serviceTier: g.serviceTier } : {}),
          executionInputSources: { providerId: "explicit", model: "explicit", ...(g.effort ? { reasoningLevel: "explicit" as const } : {}), ...(g.serviceTier ? { serviceTier: "explicit" as const } : {}) },
          title: title ?? `${roleName}`, prompt,
        } as never);
      } finally { later(5000, () => { spawning = Math.max(0, spawning - 1); }); }
      store.insertRun({ parent_thread_id: parentThreadId, child_thread_id: child.id, role: roleName, tier, provider: target.providerId, model: g.model, effort: g.effort, budget: target.budget, started_at: Date.now() });
      changed(parentThreadId);
      return { ok: true, childThreadId: child.id, role: roleName, providerId: target.providerId, label: g.label, effort: g.effort, budget: target.budget, tier };
    } catch (e) { return { ok: false, error: e instanceof Error ? e.message : String(e) }; }
  }
  const spawnText = (r: SpawnResult) => `Spawned ${r.role} sub-agent: thread ${r.childThreadId} on ${gearLabel({ model: "", label: r.label, effort: r.effort, serviceTier: null }, r.label)} (${r.providerId}), budget ${formatBudget(r.budget)} tokens. It reports back to you when done.`;

  bb.agents.registerTool({
    name: "gearshift_spawn",
    description: "Spawn a sub-agent thread for a team role (implement, qa, verify, review, explore, research, architecture, ...) on the model and budget Gearshift's policy sets for that role. Use the roles from the [gearshift] team note.",
    presentation: { label: { pending: "Spawning sub-agent", completed: "Spawned sub-agent" } },
    parameters: z.object({ role: z.string().min(1), prompt: z.string().min(1), title: z.string().optional() }),
    async execute({ role, prompt, title }: { role: string; prompt: string; title?: string }, { threadId }: { threadId: string }) {
      const r = await spawnRole(threadId, role, prompt, title);
      return r.ok ? spawnText(r) : { content: [{ type: "text", text: r.error }], isError: true };
    },
  } as never);

  const textInput = (text: string) => [{ type: "text", text, mentions: [] }] as never;
  const clip = (s: string | null, n: number) => (s ? (s.length > n ? `${s.slice(0, n)}…` : s) : "(no output)");
  /** Check one child against its budget: nudge once at 80%, stop at 100% and report to the parent. Touches only threads in `runs`. */
  async function guard(childId: string, idle: boolean) {
    const run = store.runForChild(childId);
    if (!run || (run.status !== "running" && run.status !== "nudged")) return;
    try {
      const rows = await bounded(bb.sdk.threads.events.list({ threadId: childId, types: ["thread/tokenUsage/updated"], order: "desc", limit: "1" }), PROVIDER_MS, []);
      const total = (rows[0]?.data as { tokenUsage?: { total?: Record<string, number | undefined> } } | undefined)?.tokenUsage?.total;
      if (total) {
        const split = total.cacheReadInputTokens !== undefined || total.cacheWriteInputTokens !== undefined;
        const spent = spendTokens({ inputTokens: total.inputTokens ?? 0, outputTokens: total.outputTokens ?? 0, cacheReadTokens: split ? total.cacheReadInputTokens ?? 0 : total.cachedInputTokens ?? 0, cacheWriteTokens: total.cacheWriteInputTokens ?? 0 });
        store.patchRun(run.id, { spent });
        run.spent = spent;
      }
      const act = guardAction(run.spent, run.budget, run.status);
      if (act === "nudge") {
        store.patchRun(run.id, { status: "nudged" }); // before sending: the nudge goes out once
        await bounded(bb.sdk.threads.send({ threadId: childId, mode: "steer-if-active", input: textInput(`${NOTE_PREFIX} Budget at 80%: finish the current step, then report done vs left.`) } as never), PROVIDER_MS, null);
      } else if (act === "stop") {
        store.patchRun(run.id, { status: "stopped", ended_at: Date.now() });
        await bounded(bb.sdk.threads.stop({ threadId: childId }), PROVIDER_MS, null);
        const out = await bounded(bb.sdk.threads.output({ threadId: childId }), PROVIDER_MS, null);
        const report = `${NOTE_PREFIX} run report: ${run.role} sub-agent ${childId} stopped at its budget (${formatBudget(run.spent)}/${formatBudget(run.budget)} tokens). Its last output: ${clip(out?.output ?? null, 1500)}`;
        await bounded(bb.sdk.threads.send({ threadId: run.parent_thread_id, mode: "queue-if-active", input: textInput(report), senderThreadId: childId } as never), PROVIDER_MS, null);
      } else if (idle) store.patchRun(run.id, { status: "done", ended_at: Date.now() });
      changed(run.parent_thread_id);
    } catch (e) { bb.log.warn(`budget guard failed: ${String(e)}`); }
  }
  bb.events.on("experimental_thread.events", ({ thread }) => { void guard(thread.id, false); });

  // ---- the hook --------------------------------------------------------
  // Inline first attempt (no queued rows): always a new decision. Re-attempt: rows with a decision of ours
  // proceed without deciding again; only rows we never saw get a fresh decision on their combined text.
  bb.experimental_hooks.on("message.dispatch", async (ctx) => {
    try {
      const t0 = Date.now();
      const threadId = ctx.thread.id;
      // Sub-agents we spawned keep the gear we gave them; our own nudges and reports are never routed.
      if (store.runForChild(threadId) || ctx.input.text.startsWith(NOTE_PREFIX)
        || (spawning > 0 && ctx.executionSources.model === "explicit" && !!(ctx.thread as { parentThreadId?: string | null }).parentThreadId)) return { action: "proceed" };
      const queued = ctx.queuedMessages;
      if (queued.length) {
        const known = new Map<number, DecisionRow>();
        const unseen: QueuedRow[] = [];
        for (const r of queued) {
          const d = store.forQueued(threadId, r.id) ?? linkRow(threadId, r, REATTEMPT_LINK_WINDOW_MS);
          if (d) known.set(d.id, store.get(d.id) ?? d); else unseen.push(r);
        }
        for (const d of known.values()) {
          awaitingRow.delete(d.id);
          const fields: Partial<DecisionRow> = {};
          if (d.amend_status === "pending") fields.amend_status = "failed"; // never wait twice on a row
          if (unseen.length === 0 && d.latency_ms === null) fields.latency_ms = t0 - d.at;
          store.patch(d.id, fields);
        }
        if (unseen.length === 0) { changed(threadId); return { action: "proceed" }; }
      }
      const pending = ctx.thread.status === "pending";
      if (queued.length === 0 && pending && ctx.initiator === "user") {
        const a = takeArmed(ctx.thread.projectId, ctx.input.text);
        if (a !== null) store.setPref(threadId, a);
      }
      const providerId = ctx.thread.providerId;
      const on = cfg.enabled && threadOn(threadId);
      const looked = on
        ? await bounded(Promise.all([
          catalogFor({ providerId, environmentId: ctx.thread.environmentId, hostId: ctx.host?.id ?? null, projectId: ctx.thread.projectId }),
          currentGear(threadId, pending),
          pending ? Promise.resolve(null) : contextTokens(threadId),
        ]), LOOKUP_MS, null)
        : null;
      const [catalog, current, ctxTokens] = looked ?? [null, null, null];
      const d = decide({
        enabled: on, text: ctx.input.text, providerId, attempt: ctx.attempt, initiator: ctx.initiator,
        requested: { model: ctx.requestedExecution.model, effort: ctx.requestedExecution.reasoningLevel, serviceTier: ctx.requestedExecution.serviceTier },
        modelSource: ctx.executionSources.model === "explicit" || ctx.executionSources.model === "client-preference" ? ctx.executionSources.model : null,
        current, contextTokens: ctxTokens, catalog, policy: compiled,
      });
      const wantsNote = compiled.policy.routing.routeNotes && ctx.attempt === "start-turn" && (ctx.initiator === "user" || ctx.initiator === "agent")
        && noteWorthy(d.tier) && ["shift", "keep", "hold", "manual"].includes(d.action);
      const note = wantsNote && d.tier ? await bounded(buildNote(d.tier, d.classification.score, providerId, { environmentId: ctx.thread.environmentId, hostId: ctx.host?.id ?? null, projectId: ctx.thread.projectId }, catalog), LOOKUP_MS, null) : null;
      const id = record(ctx, d, ctxTokens, baselineFor(providerId, catalog), t0);
      if (queued.length) store.linkQueued(id, threadId, queued.map((r) => r.id));
      changed(threadId);
      const gear = d.needsAmend ? d.gear : null;
      if (gear || note) {
        store.patch(id, { amend_status: "pending" });
        if (queued.length) later(0, () => { void amendRows(threadId, id, queued, gear, note); });
        else {
          awaitingRow.set(id, { threadId, gear, note });
          later(1000, () => { void pollForRow(threadId, id); });
        }
        return { action: "wait", reason: gear ? `Shifting to ${gear.label}${gear.effort ? ` · ${gear.effort}` : ""}` : "Adding the team note" };
      }
      return { action: "proceed" };
    } catch (e) {
      bb.log.warn(`hook failed open: ${String(e)}`);
      return { action: "proceed" };
    }
  });

  function record(ctx: MessageDispatchHookContext, d: Decision, ctxTokens: number | null, baseline: string | null, at: number): number {
    const c = d.classification;
    const row: NewDecision = {
      at, thread_id: ctx.thread.id, project_id: ctx.thread.projectId, provider_id: ctx.thread.providerId, initiator: ctx.initiator,
      attempt: ctx.attempt, action: d.action, reason: d.reason, tier: d.tier, score: d.tier ? c.score : null, confidence: d.tier ? c.confidence : null,
      signals: JSON.stringify(c.signals), chars: c.chars, fingerprint: fingerprint(ctx.thread.id, ctx.input.text),
      requested_model: ctx.requestedExecution.model, requested_effort: ctx.requestedExecution.reasoningLevel,
      routed_model: d.gear?.model ?? null, routed_effort: d.gear?.effort ?? null, routed_label: d.gear?.label ?? null, routed_service_tier: d.gear?.serviceTier ?? null,
      baseline_model: baseline, context_tokens: ctxTokens, amend_status: null,
    };
    return store.insertDecision(row);
  }

  // ---- usage + cleanup -------------------------------------------------
  bb.events.on("thread.idle", async ({ thread }) => {
    void guard(thread.id, true);
    try {
      const rows = await bb.sdk.threads.events.list({ threadId: thread.id, types: ["thread/tokenUsage/updated"], order: "desc", limit: "1" });
      const ev = rows[0];
      if (!ev) return;
      const turnId = (ev.scope as { turnId?: string | null } | undefined)?.turnId ?? null;
      if (turnId && store.hasTurn(thread.id, turnId)) return;
      const last = (ev.data as { tokenUsage?: { last?: Record<string, number | undefined> } }).tokenUsage?.last;
      const target = last ? store.openForUsage(thread.id, ev.createdAt) : undefined;
      if (!last || !target) return;
      const split = last.cacheReadInputTokens !== undefined || last.cacheWriteInputTokens !== undefined;
      const usage: Usage = {
        inputTokens: last.inputTokens ?? 0, outputTokens: last.outputTokens ?? 0,
        cacheReadTokens: split ? last.cacheReadInputTokens ?? 0 : last.cachedInputTokens ?? 0, cacheWriteTokens: last.cacheWriteInputTokens ?? 0,
      };
      const { cost, base } = costs(target.routed_model ?? target.requested_model, target.baseline_model, target.routed_service_tier, usage);
      store.attachUsage(target.id, turnId, usage, cost, base);
      changed(thread.id);
    } catch (e) { bb.log.warn(`usage attach failed: ${String(e)}`); }
  });
  bb.events.on("thread.deleted", ({ thread }) => { try { store.deletePref(thread.id); } catch { /* ignore */ } });

  // ---- preview + state -------------------------------------------------
  function dtoState(threadId: string): ThreadStateDto {
    const last = store.lastForThread(threadId);
    return { threadId, enabled: threadOn(threadId), last: last ? toDto(last, store.modelLabels()) : null };
  }
  async function preview(i: { text: string; providerId: string | null; model: string | null; effort: string | null; threadId: string | null; projectId: string | null; overrides?: Record<string, unknown> }): Promise<PreviewDto> {
    let policy = compiled;
    if (i.overrides) {
      const r = build(i.overrides as PolicyOverrides); // draft overrides; locked keys are ignored, routing comes from settings
      if (!r.errors.length) policy = r.compiled;
    }
    let providerId = i.providerId;
    let env: string | null = null, project = i.projectId;
    let current = null as { model: string; effort: string | null; serviceTier?: string | null } | null, tokens: number | null = null, on = cfg.enabled && policy.policy.routing.defaultOn;
    if (i.threadId) {
      try {
        const t = await bounded(bb.sdk.threads.get({ threadId: i.threadId }), LOOKUP_MS, null);
        if (t) {
          providerId = providerId ?? t.providerId; env = t.environmentId ?? null; project = project ?? t.projectId;
          current = await bounded(currentGear(i.threadId, t.status === "pending"), LOOKUP_MS, null);
          tokens = t.status === "pending" ? null : await bounded(contextTokens(i.threadId), LOOKUP_MS, null);
        }
      } catch { /* preview is best effort */ }
      on = cfg.enabled && (store.getPref(i.threadId) ?? policy.policy.routing.defaultOn);
    } else {
      sweepArmed();
      const a = [...armed.values()].find((v) => v.projectId === i.projectId && norm(v.text) === norm(i.text));
      if (a) on = cfg.enabled && a.enabled;
    }
    const c0 = classify(i.text, policy);
    const empty = { enabled: on, providerId, tier: c0.tier, score: c0.score, confidence: c0.confidence, signals: c0.signals, gear: null, contributions: c0.contributions } as const;
    if (!providerId) return { ...empty, action: on ? "skip" : "off", reason: on ? "No provider selected" : "Gearshift is off for this thread" };
    const catalog = on ? await bounded(catalogFor({ providerId, environmentId: env, projectId: project }), LOOKUP_MS, null) : null;
    const d = decide({
      enabled: on, text: i.text, providerId, attempt: "start-turn", initiator: "user", requested: { model: i.model, effort: i.effort },
      modelSource: null, current, contextTokens: tokens, catalog, policy,
    });
    const c = d.classification;
    return {
      enabled: on, providerId, tier: d.tier ?? c.tier, score: c.score, confidence: c.confidence, signals: c.signals,
      gear: d.gear ? { model: d.gear.model, label: d.gear.label, effort: d.gear.effort, serviceTier: d.gear.serviceTier } : null,
      action: d.action, reason: d.reason, contributions: c.contributions,
    };
  }

  async function providersState(): Promise<ProvidersDto> {
    const TIMED_OUT = Symbol("timed out");
    const list = await bounded(bb.sdk.providers.list(), PROVIDER_MS, TIMED_OUT);
    if (list === TIMED_OUT) return { providers: [] };
    const providers = await Promise.all(list.filter((p) => !("enabled" in p) || p.enabled !== false).map(async (info) => {
      const base = { id: info.id, displayName: info.displayName ?? info.id };
      try {
        const res = await bounded(listModels({ providerId: info.id }), PROVIDER_MS, TIMED_OUT);
        if (res === TIMED_OUT) return { ...base, models: [], error: "timed out" };
        const models = toCatalog(res).map((m) => ({
          id: m.id, label: m.displayName, isDefault: m.isDefault, efforts: m.efforts, serviceTiers: m.serviceTiers, sizeClass: sizeClass(m),
        }));
        return { ...base, models, error: null };
      } catch (e) { return { ...base, models: [], error: e instanceof Error ? e.message : String(e) }; }
    }));
    return { providers };
  }

  async function storeOverrides(next: PolicyOverrides): Promise<PolicyStateDto> {
    const { clean, errors: locked } = stripLocked(next);
    const { errors } = resolvePolicy(clean);
    if (errors.length) return policyState(false, [...locked, ...errors]);
    try {
      await bb.storage.kv.set(POLICY_KEY, clean);
      overrides = clean;
      rebuild();
      return policyState(locked.length === 0, locked); // the rest is saved; locked keys come back as errors
    } catch (e) {
      return policyState(false, [{ path: "policy", message: e instanceof Error ? e.message : String(e) }]);
    }
  }

  bb.rpc.register(rpcContract, {
    preview: (i) => preview(i),
    threadState: ({ threadId }) => dtoState(threadId),
    setThreadEnabled: ({ threadId, enabled }) => { store.setPref(threadId, enabled); changed(threadId); return dtoState(threadId); },
    armNewThread: ({ key, projectId, text, enabled }) => {
      sweepArmed();
      if (enabled) armed.delete(key); else armed.set(key, { projectId, text, at: Date.now(), enabled: false });
      return { ok: true };
    },
    overview: ({ days }) => buildOverview(store.since(Date.now() - days * DAY), days, store.countOff(), Date.now(), store.runsSince(Date.now() - days * DAY), store.modelLabels()),
    getPolicy: () => policyState(),
    savePolicy: ({ overrides: next }) => storeOverrides(next),
    resetPolicy: ({ path }) => storeOverrides(removeOverridePath(overrides, path)),
    providers: () => providersState(),
  });

  // ---- CLI -------------------------------------------------------------
  const usage = "Usage:\n  bb gearshift status [--thread <id>]\n  bb gearshift on --thread <id>\n  bb gearshift off --thread <id>\n  bb gearshift explain <text...> [--provider <id>]\n  bb gearshift policy\n  bb gearshift spawn --role <role> [--thread <id>] <prompt...>";
  bb.cli.register({
    name: "gearshift",
    summary: "Automatic model routing: status, per-thread toggle, explain a routing decision",
    commands: [
      { name: "status", summary: "Show whether Gearshift is on, and the last decision", usage: "bb gearshift status [--thread <id>]" },
      { name: "on", summary: "Turn Gearshift on for a thread", usage: "bb gearshift on --thread <id>" },
      { name: "off", summary: "Turn Gearshift off for a thread", usage: "bb gearshift off --thread <id>" },
      { name: "policy", summary: "Print the effective routing policy as JSON (read-only; edit it in Gearshift settings)", usage: "bb gearshift policy" },
      { name: "spawn", summary: "Spawn a sub-agent thread for a team role on its policy gear and budget", usage: "bb gearshift spawn --role <role> [--thread <id>] <prompt...>" },
      { name: "explain", summary: "Classify text and show the gear it would get", usage: "bb gearshift explain <text...> [--provider <id>]" },
    ],
    async run(argv, ctx) {
      const flag = (name: string) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
      const threadId = flag("--thread") ?? ctx.threadId;
      const [cmd] = argv;
      switch (cmd) {
        case "status": {
          const lines = [`Gearshift: ${cfg.enabled ? "enabled" : "disabled"} (new threads ${compiled.policy.routing.defaultOn ? "on" : "off"})`];
          if (threadId) {
            const s = dtoState(threadId);
            lines.push(`Thread ${threadId}: ${s.enabled ? "on" : "off"}`);
            if (s.last) lines.push(`Last: ${s.last.action} - ${s.last.reason}`);
          }
          return { exitCode: 0, stdout: lines.join("\n") };
        }
        case "on": case "off": {
          if (!threadId) return { exitCode: 1, stderr: usage };
          store.setPref(threadId, cmd === "on"); changed(threadId);
          return { exitCode: 0, stdout: `Gearshift ${cmd} for ${threadId}` };
        }
        case "policy": {
          const lines = [JSON.stringify(compiled.policy, null, 2)];
          if (policyErrors.length) lines.push(`# Saved policy is invalid, routing with defaults: ${policyErrors.map((e) => `${e.path}: ${e.message}`).join("; ")}`);
          return { exitCode: 0, stdout: lines.join("\n") };
        }
        case "spawn": {
          const role = flag("--role");
          const skip = new Set<number>();
          argv.forEach((w, i) => { if (w === "--role" || w === "--thread") { skip.add(i); skip.add(i + 1); } });
          const prompt = argv.slice(1).filter((_, i) => !skip.has(i + 1)).join(" ").trim();
          if (!role || !threadId || !prompt) return { exitCode: 1, stderr: usage };
          const r = await spawnRole(threadId, role, prompt);
          return r.ok ? { exitCode: 0, stdout: `${spawnText(r)}` } : { exitCode: 1, stderr: r.error };
        }
        case "explain": {
          const providerFlag = flag("--provider");
          const words = argv.slice(1).filter((w, i, a) => w !== "--provider" && a[i - 1] !== "--provider");
          const text = words.join(" ").trim();
          if (!text) return { exitCode: 1, stderr: usage };
          const p = await preview({ text, providerId: providerFlag ?? "claude-code", model: null, effort: null, threadId: null, projectId: null });
          const out = [`Tier: ${p.tier} (score ${p.score}, ${p.confidence} confidence)`, `Signals: ${p.signals.join(", ") || "none"}`,
            `Gear: ${p.gear ? `${p.gear.label}${p.gear.effort ? ` · ${p.gear.effort}` : ""}${p.gear.serviceTier ? ` · ${p.gear.serviceTier}` : ""}` : "none"}`, `Score: ${p.contributions.map((c) => `${c.label} ${c.kind === "add" || c.kind === "bonus" ? "+" : "="}${c.value}`).join(", ") || "none"}`, `Action: ${p.action} - ${p.reason}`];
          return { exitCode: 0, stdout: out.join("\n").slice(0, 4000) };
        }
        default: return { exitCode: cmd === undefined || cmd === "help" || cmd === "--help" ? 0 : 1, stdout: usage };
      }
    },
  });
}
