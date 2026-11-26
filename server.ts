// Gearshift backend: routes each message to the right model + effort via the message.dispatch hook.
import { defineRpcContract, type BbPluginApi, type MessageDispatchHookContext } from "@get-bb/plugin-sdk";
import { buildOverview, toDto } from "./lib/analytics";
import { classify } from "./lib/classify";
import { bounded } from "./lib/bounded";
import { DECISIONS_CHANGED } from "./lib/channels";
import { rpcContract, type PolicyStateDto, type PreviewDto, type ProvidersDto, type ThreadStateDto } from "./lib/contract";
import { resolveGear, sizeClass, toCatalog, type CatalogModel, type Gear } from "./lib/gears";
import { DEFAULT_POLICY, compilePolicy, diffOverrides, ladderFor, mergePolicy, removeOverridePath, resolvePolicy, type CompiledPolicy, type Policy, type PolicyError, type PolicyOverrides } from "./lib/policy";
import { applyPolicyEdit, POLICY_PATHS, type PolicyEdit } from "./lib/policy-edit";
import { applyReplaySets, formatReplay, parseReplaySet, replayDecisions, type ReplaySet } from "./lib/replay";
import { calibrate, formatCalibration, MIN_SAMPLES } from "./lib/calibrate";
import { buildReview, formatReview, reviewThreadIds, withTitles } from "./lib/review";
import { policyRev } from "./lib/policy-rev";
import { costUsd, priceFor, tierMultiplier, type Usage } from "./lib/pricing";
import { decide, type Decision } from "./lib/router";
import { fingerprint, Store, type DecisionRow, type NewDecision } from "./lib/store";
import { NOTE_PREFIX, teamRoles, formatBudget, formatRouteNote, gearLabel, guardAction, noteWorthy, providersFor, signalRolesFor, resolveRole, roleTarget, spendTokens } from "./lib/team";
import { TIERS, type Tier } from "./lib/policy";

export { rpcContract };
void defineRpcContract;

const CATALOG_TTL = 10 * 60_000;
const ARM_TTL = 15 * 60_000;
const LOOKUP_MS = 1500; // one budget for every lookup the hook makes
const PROVIDER_MS = 4000;
const MAX_TITLES = 40; // thread titles fetched for one review
const HISTORY_EXTRA_DAYS = 30; // rows read before a report window, so hold origins and thread gears there resolve
const LINK_WINDOW_MS = 2 * 60_000; // a queue row appears right after the hook returns
const REATTEMPT_LINK_WINDOW_MS = 30 * 60_000;
const MAX_RUNS_PER_PARENT = 6;
const MAX_RUNS_GLOBAL = 20;
const STALE_RUN_MS = 6 * 3_600_000; // an open run this old never reported back
const POLICY_KEY = "policy-overrides";
/** { rev, changedAt }: the effective policy's fingerprint and when it last changed (for the review's policy note). */
const POLICY_REV_KEY = "policy-rev";
/** Not configurable from the policy editor: prices stay internal, routing switches are plain settings. */
const NOT_OVERRIDABLE = ["prices", "serviceTierMultipliers", "baselineModel", "routing"] as const;
type QueuedRow = MessageDispatchHookContext["queuedMessages"][number];
type AnyBlock = { type?: string; text?: string; visibility?: string };
/** Our own team note, or any agent-only block: never part of what the user asked, so never classified or fingerprinted. */
const isNoteBlock = (b: AnyBlock) => b.visibility === "agent-only" || (typeof b.text === "string" && b.text.trimStart().startsWith(NOTE_PREFIX));
const stripNoteText = (t: string) => t.split(/\n{2,}/).filter((seg) => !seg.trimStart().startsWith(NOTE_PREFIX)).join("\n\n");
const rowText = (r: QueuedRow) => (r.content as AnyBlock[]).filter((b) => typeof b.text === "string" && !isNoteBlock(b)).map((b) => b.text).join(" ");
/** The user's own text for a dispatch: note and agent-only blocks removed, so a re-attempt never re-classifies our note. */
const userText = (input: { blocks?: readonly unknown[]; text: string }) => {
  const texts = ((input.blocks ?? []) as AnyBlock[]).filter((b) => typeof b.text === "string");
  return texts.length ? texts.filter((b) => !isNoteBlock(b)).map((b) => b.text).join("\n\n") : stripNoteText(input.text);
};
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
    holdEffortFollowsMessage: { type: "boolean", label: "Lower the effort of held messages to their own size", description: "On a long thread Gearshift keeps the model (switching would re-read the context uncached), but a smaller message still gets its own lower effort. Claude Code sends the effort inside the conversation, so the cache stays valid on models that support per-turn effort.", default: true },
    downshiftBias: { type: "boolean", label: "Lean to the lower tier on borderline messages", description: "A message at the very bottom of its size band, or with no clear signal, runs one tier lower. Never higher, and never below trivial.", default: true },
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
    holdEffortFollowsMessage: c.holdEffortFollowsMessage ?? DEFAULT_POLICY.routing.holdEffortFollowsMessage,
    downshiftBias: c.downshiftBias ?? DEFAULT_POLICY.routing.downshiftBias,
  });
  /** Overrides on top of the defaults, with the routing section taken from the settings. Null when it does not compile. */
  const build = (o: PolicyOverrides): { compiled: CompiledPolicy; errors: PolicyError[] } => {
    const { effective, errors } = resolvePolicy(stripLocked(o).clean);
    try { return { compiled: compilePolicy({ ...effective, routing: routingFromSettings(cfg) }), errors }; }
    catch (e) { return { compiled: compilePolicy({ ...DEFAULT_POLICY, routing: routingFromSettings(cfg) }), errors: [...errors, { path: "policy", message: String(e) }] }; }
  };
  /** The effective policy's fingerprint (stamped on every decision) and when it last changed. */
  let rev = { rev: "", changedAt: null as number | null };
  let stamping = Promise.resolve();
  const currentRev = () => rev.rev;
  /** Remember when the policy last changed: a saved edit, a setting, or new defaults after an update. */
  const stampPolicy = (next: string, prevChangedAt: number | null) => async () => {
    try {
      const saved = await bb.storage.kv.get<{ rev?: string; changedAt?: number | null }>(POLICY_REV_KEY);
      if (saved?.rev === next) { if (rev.rev === next) rev.changedAt = saved.changedAt ?? null; return; }
      const changedAt = saved?.rev ? Date.now() : prevChangedAt; // first run ever: unknown, not "just now"
      if (rev.rev === next) rev.changedAt = changedAt;
      await bb.storage.kv.set(POLICY_REV_KEY, { rev: next, changedAt });
    } catch (e) { bb.log.warn(`could not stamp policy: ${String(e)}`); }
  };
  const rebuild = () => {
    const r = build(overrides);
    compiled = r.compiled; policyErrors = r.errors;
    const next = policyRev(compiled.policy);
    if (next !== rev.rev) { const prev = rev.changedAt; rev = { rev: next, changedAt: prev }; stamping = stamping.then(stampPolicy(next, prev)); }
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
  // Spawns in flight: the child's first dispatch can reach the hook before spawn() returns and the run row exists.
  const pendingSpawns: Array<{ parentThreadId: string; model: string; at: number }> = [];
  const isPendingSpawn = (parentThreadId: string | null | undefined, model: string | null | undefined) =>
    !!parentThreadId && pendingSpawns.some((p) => p.parentThreadId === parentThreadId && p.model === model && Date.now() - p.at < 60_000);
  const failStale = () => { try { store.failStale(Date.now() - STALE_RUN_MS); } catch (e) { bb.log.warn(`stale run sweep failed: ${String(e)}`); } };
  failStale();
  const staleTimer = setInterval(failStale, 3_600_000);
  bb.onDispose(() => clearInterval(staleTimer));
  const openFor = (parent: string) => store.openRunCount(parent) + pendingSpawns.filter((p) => p.parentThreadId === parent).length;
  const openAll = () => store.openRunCount() + pendingSpawns.length;

  // Sub-agents never get the spawn tool, and nothing is offered while Gearshift is off for the thread.
  bb.agents.configure((c) => {
    const child = !!store.runForChild(c.thread.id) || (!!c.thread.parentThreadId && isPendingSpawn(c.thread.parentThreadId, c.provider.model));
    const on = cfg.enabled && threadOn(c.thread.id);
    return { tools: !child && on ? ["gearshift_spawn"] : [], skills: ["gearshift"] };
  });

  /** Catalogs for every provider the team's roles run on (the parent's is passed in). */
  async function catalogsFor(roles: readonly string[], parentProviderId: string, tier: Tier, scope: { environmentId?: string | null; hostId?: string | null; projectId?: string | null }, parentCatalog: CatalogModel[] | null) {
    const out = new Map<string, CatalogModel[]>();
    if (parentCatalog) out.set(parentProviderId, parentCatalog);
    for (const pid of providersFor(compiled.policy, roles, parentProviderId, tier)) {
      if (out.has(pid)) continue;
      const c = await catalogFor({ providerId: pid, ...(pid === parentProviderId ? scope : { hostId: scope.hostId, projectId: scope.projectId }) });
      if (c) out.set(pid, c);
    }
    return out;
  }
  async function buildNote(tier: Tier, score: number | null, signalIds: readonly string[], providerId: string, scope: { environmentId?: string | null; hostId?: string | null; projectId?: string | null }, parentCatalog: CatalogModel[] | null): Promise<string | null> {
    try {
      const catalogs = await catalogsFor(teamRoles(compiled.policy, tier, signalIds), providerId, tier, scope, parentCatalog);
      return formatRouteNote({ tier, score, signalIds, policy: compiled.policy, parentProviderId: providerId, catalogs });
    } catch (e) { bb.log.warn(`route note failed: ${String(e)}`); return null; }
  }

  interface SpawnResult { ok: true; childThreadId: string; role: string; providerId: string; label: string; effort: string | null; budget: number; tier: Tier }
  const fail = (error: string) => ({ ok: false as const, error });
  async function spawnRole(parentThreadId: string, roleName: string, prompt: string, title?: string): Promise<SpawnResult | { ok: false; error: string }> {
    let pending: (typeof pendingSpawns)[number] | null = null;
    try {
      if (!cfg.enabled || !threadOn(parentThreadId)) return fail("Gearshift is off for this thread, so it cannot spawn sub-agents");
      if (store.runForChild(parentThreadId)) return fail("A sub-agent cannot spawn sub-agents: report back to the thread that spawned you instead");
      failStale();
      if (openFor(parentThreadId) >= MAX_RUNS_PER_PARENT) return fail(`Too many open sub-agents for this thread (limit ${MAX_RUNS_PER_PARENT}): wait for one to report back`);
      if (openAll() >= MAX_RUNS_GLOBAL) return fail(`Too many open sub-agents overall (limit ${MAX_RUNS_GLOBAL}): wait for some to finish`);
      const parent = await bb.sdk.threads.get({ threadId: parentThreadId });
      const tier = (store.lastNoteworthyTier(parentThreadId) as Tier | null) ?? "medium";
      const target = roleTarget(compiled.policy, roleName, parent.providerId, tier);
      const allowed = [...compiled.policy.teams[tier].roles, ...store.lastSignalRoles(parentThreadId)];
      if (target && !allowed.includes(roleName)) return fail(`Role "${roleName}" is not in this message's team. Roles: ${[...new Set(allowed)].join(", ")}`);
      if (!target) return fail(`Unknown role "${roleName}". Roles: ${Object.keys(compiled.policy.roles).join(", ")}`);
      const hostId = (parent as { hostId?: string | null }).hostId ?? null;
      const catalog = await catalogFor({ providerId: target.providerId, ...(target.providerId === parent.providerId ? { environmentId: parent.environmentId } : {}), hostId, projectId: parent.projectId });
      const r = catalog ? resolveRole(compiled.policy, roleName, parent.providerId, tier, new Map([[target.providerId, catalog]])) : null;
      if (!r?.gear) return fail(`No model for role "${roleName}" on ${target.providerId}`);
      if (!parent.environmentId) return fail("The calling thread has no environment yet");
      const g = r.gear;
      // Re-check after the awaits, then reserve the slot (no await in between).
      if (openFor(parentThreadId) >= MAX_RUNS_PER_PARENT || openAll() >= MAX_RUNS_GLOBAL) return fail("Too many open sub-agents: wait for one to report back");
      pending = { parentThreadId, model: g.model, at: Date.now() };
      pendingSpawns.push(pending);
      const child = await bb.sdk.threads.spawn({
        projectId: parent.projectId, environment: { type: "reuse", environmentId: parent.environmentId }, parentThreadId,
        providerId: target.providerId, model: g.model, ...(g.effort ? { reasoningLevel: g.effort } : {}), ...(g.serviceTier ? { serviceTier: g.serviceTier } : {}),
        executionInputSources: { providerId: "explicit", model: "explicit", ...(g.effort ? { reasoningLevel: "explicit" as const } : {}), ...(g.serviceTier ? { serviceTier: "explicit" as const } : {}) },
        title: title ?? `${roleName}`, prompt,
      } as never);
      store.insertRun({ parent_thread_id: parentThreadId, child_thread_id: child.id, role: roleName, tier, provider: target.providerId, model: g.model, model_label: g.label, effort: g.effort, budget: target.budget, started_at: Date.now() });
      changed(parentThreadId);
      return { ok: true, childThreadId: child.id, role: roleName, providerId: target.providerId, label: g.label, effort: g.effort, budget: target.budget, tier };
    } catch (e) { return fail(e instanceof Error ? e.message : String(e)); }
    finally { if (pending) { const i = pendingSpawns.indexOf(pending); if (i >= 0) pendingSpawns.splice(i, 1); } }
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
  type GuardMode = "tick" | "active" | "idle";
  /** Children being checked right now, and a re-check queued behind a running one (an idle must never be lost). */
  const inflight = new Set<string>();
  const rerun = new Map<string, GuardMode>();

  /**
   * Spend of a child in tokens. The settled total comes from the last tokenUsage event; while a turn runs that
   * event does not move, so growth in the context window since it is added as an in-turn estimate.
   */
  async function childSpend(childId: string): Promise<number | null> {
    const rows = await bounded(bb.sdk.threads.events.list({ threadId: childId, types: ["thread/tokenUsage/updated", "thread/contextWindowUsage/updated"], order: "desc", limit: "20" }), PROVIDER_MS, []);
    const usage = rows.find((r) => (r.data as { tokenUsage?: unknown } | undefined)?.tokenUsage);
    const ctxRows = rows.filter((r) => (r.data as { contextWindowUsage?: unknown } | undefined)?.contextWindowUsage);
    const total = (usage?.data as { tokenUsage?: { total?: Record<string, number | undefined> } } | undefined)?.tokenUsage?.total;
    const ctxOf = (r: (typeof rows)[number] | undefined) => (r?.data as { contextWindowUsage?: { usedTokens?: number | null } } | undefined)?.contextWindowUsage?.usedTokens ?? null;
    let settled: number | null = null;
    if (total) {
      const split = total.cacheReadInputTokens !== undefined || total.cacheWriteInputTokens !== undefined;
      settled = spendTokens({ inputTokens: total.inputTokens ?? 0, outputTokens: total.outputTokens ?? 0, cacheReadTokens: split ? total.cacheReadInputTokens ?? 0 : total.cachedInputTokens ?? 0, cacheWriteTokens: total.cacheWriteInputTokens ?? 0 });
    }
    const newest = ctxRows[0];
    const latestCtx = ctxOf(newest);
    if (latestCtx === null || !newest) return settled;
    // In-turn growth: context now versus the context when the settled total was recorded.
    const base = usage ? ctxRows.find((r) => r.createdAt <= usage.createdAt) : undefined;
    if (usage && newest.createdAt <= usage.createdAt) return settled;
    const baseCtx = ctxOf(base);
    const growth = baseCtx === null ? 0 : Math.max(0, latestCtx - baseCtx);
    return (settled ?? 0) + (usage ? growth : latestCtx);
  }

  /**
   * Check one child against its budget: nudge once at 80%, stop at 100% and report to the parent. Touches only
   * threads in `runs`. Every transition is claimed in SQL first and acted on only by the caller that won it.
   */
  async function guard(childId: string, mode: GuardMode) {
    if (!store.runForChild(childId)) return;
    if (inflight.has(childId)) { rerun.set(childId, mode === "tick" ? rerun.get(childId) ?? "tick" : mode); return; }
    inflight.add(childId);
    try {
      let run = store.runForChild(childId);
      if (!run) return;
      if (mode === "active" && run.status === "done") {
        // A resumed child is guarded again.
        if (store.claimRun(run.id, ["done"], "running", { ended_at: null as never })) { changed(run.parent_thread_id); run = store.runForChild(childId)!; }
      }
      if (run.status !== "running" && run.status !== "nudged") return;
      const spent = await childSpend(childId);
      run = store.runForChild(childId);
      if (!run || (run.status !== "running" && run.status !== "nudged")) return;
      if (spent !== null && spent !== run.spent) { store.patchRun(run.id, { spent }); run.spent = spent; }
      if (mode === "idle") {
        // The turn is over: finished, even if it crossed the budget on its last step. Over budget is kept as a flag.
        const over = run.budget > 0 && run.spent >= run.budget ? 1 : 0;
        if (store.claimRun(run.id, ["running", "nudged"], "done", { ended_at: Date.now(), over_budget: over })) changed(run.parent_thread_id);
        return;
      }
      const act = guardAction(run.spent, run.budget, run.status);
      if (act === "nudge") {
        if (!store.claimRun(run.id, ["running"], "nudged")) return;
        await bounded(bb.sdk.threads.send({ threadId: childId, mode: "steer-if-active", input: textInput(`${NOTE_PREFIX} Budget at 80%: finish the current step, then report done vs left.`) } as never), PROVIDER_MS, null);
      } else if (act === "stop") {
        if (!store.claimRun(run.id, ["running", "nudged"], "stopped", { ended_at: Date.now(), over_budget: 1 })) return;
        await bounded(bb.sdk.threads.stop({ threadId: childId }), PROVIDER_MS, null);
        const out = await bounded(bb.sdk.threads.output({ threadId: childId }), PROVIDER_MS, null);
        const report = `${NOTE_PREFIX} run report: ${run.role} sub-agent ${childId} was stopped mid-turn at its budget (${formatBudget(run.spent)}/${formatBudget(run.budget)} tokens). Its work is INCOMPLETE: the output below was cut off and may end mid-sentence. Decide whether to finish the remaining work yourself, re-spawn with a smaller task, or raise the role's budget. Last output (truncated): ${clip(out?.output ?? null, 1500)}`;
        await bounded(bb.sdk.threads.send({ threadId: run.parent_thread_id, mode: "queue-if-active", input: textInput(report), senderThreadId: childId } as never), PROVIDER_MS, null);
      }
      changed(run.parent_thread_id);
    } catch (e) { bb.log.warn(`budget guard failed: ${String(e)}`); }
    finally {
      inflight.delete(childId);
      const next = rerun.get(childId);
      if (next && !disposed) { rerun.delete(childId); void guard(childId, next); }
    }
  }
  bb.events.on("experimental_thread.events", ({ thread }) => { void guard(thread.id, "tick"); });
  bb.events.on("thread.active", ({ thread }) => { void guard(thread.id, "active"); });
  /** A child that was deleted, archived or crashed will never report: close its run. */
  const closeRun = (threadId: string) => {
    try {
      const run = store.runForChild(threadId);
      if (run && store.claimRun(run.id, ["running", "nudged"], "failed", { ended_at: Date.now() })) changed(run.parent_thread_id);
    } catch (e) { bb.log.warn(`close run failed: ${String(e)}`); }
  };
  bb.events.on("thread.archived", ({ thread }) => closeRun(thread.id));
  bb.events.on("thread.failed", ({ thread }) => closeRun(thread.id));

  // ---- the hook --------------------------------------------------------
  // Inline first attempt (no queued rows): always a new decision. Re-attempt: rows with a decision of ours
  // proceed without deciding again; only rows we never saw get a fresh decision on their combined text.
  bb.experimental_hooks.on("message.dispatch", async (ctx) => {
    try {
      const t0 = Date.now();
      const threadId = ctx.thread.id;
      // Sub-agents we spawned keep the gear we gave them; our own run reports (sent by a child to its parent) are never routed.
      const sender = ctx.senderThreadId;
      const ourReport = ctx.input.text.startsWith(NOTE_PREFIX) && typeof sender === "string" && store.runForChild(sender)?.parent_thread_id === threadId;
      if (store.runForChild(threadId) || ourReport
        || (ctx.executionSources.model === "explicit" && isPendingSpawn((ctx.thread as { parentThreadId?: string | null }).parentThreadId, ctx.requestedExecution.model))) return { action: "proceed" };
      const text = userText(ctx.input);
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
      const deadline = Date.now() + LOOKUP_MS; // one budget: the catalog lookups and the note share it
      const looked = on
        ? await bounded(Promise.all([
          catalogFor({ providerId, environmentId: ctx.thread.environmentId, hostId: ctx.host?.id ?? null, projectId: ctx.thread.projectId }),
          currentGear(threadId, pending),
          pending ? Promise.resolve(null) : contextTokens(threadId),
        ]), LOOKUP_MS, null)
        : null;
      const [catalog, current, ctxTokens] = looked ?? [null, null, null];
      const d = decide({
        enabled: on, text, providerId, attempt: ctx.attempt, initiator: ctx.initiator,
        requested: { model: ctx.requestedExecution.model, effort: ctx.requestedExecution.reasoningLevel, serviceTier: ctx.requestedExecution.serviceTier },
        modelSource: ctx.executionSources.model === "explicit" || ctx.executionSources.model === "client-preference" ? ctx.executionSources.model : null,
        current, contextTokens: ctxTokens, catalog, policy: compiled,
      });
      const wantsNote = compiled.policy.routing.routeNotes && ctx.attempt === "start-turn" && (ctx.initiator === "user" || ctx.initiator === "agent")
        && noteWorthy(d.tier, d.tier ? signalRolesFor(compiled.policy, d.tier, d.classification.contributions.map((c) => c.id)).length : 0) && ["shift", "keep", "hold"].includes(d.action); // a manual pick is never held just for a note
      const note = wantsNote && d.tier ? await bounded(buildNote(d.tier, d.classification.score, d.classification.contributions.map((c) => c.id), providerId, { environmentId: ctx.thread.environmentId, hostId: ctx.host?.id ?? null, projectId: ctx.thread.projectId }, catalog), Math.max(0, deadline - Date.now()), null) : null;
      const id = record(ctx, d, ctxTokens, baselineFor(providerId, catalog), t0, text, current);
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

  function record(ctx: MessageDispatchHookContext, d: Decision, ctxTokens: number | null, baseline: string | null, at: number, text: string, current: { model: string; effort: string | null } | null): number {
    const c = d.classification;
    const row: NewDecision = {
      at, thread_id: ctx.thread.id, project_id: ctx.thread.projectId, provider_id: ctx.thread.providerId, initiator: ctx.initiator,
      attempt: ctx.attempt, action: d.action, reason: d.reason, tier: d.tier, score: d.tier ? c.score : null, confidence: d.tier ? c.confidence : null, scored_tier: d.scoredTier,
      signals: JSON.stringify(c.signals), signal_roles: JSON.stringify(d.tier ? signalRolesFor(compiled.policy, d.tier, c.contributions.map((x) => x.id)) : []), chars: c.chars, fingerprint: fingerprint(ctx.thread.id, text),
      requested_model: ctx.requestedExecution.model, requested_effort: ctx.requestedExecution.reasoningLevel,
      routed_model: d.gear?.model ?? null, routed_effort: d.gear?.effort ?? null, routed_label: d.gear?.label ?? null, routed_service_tier: d.gear?.serviceTier ?? null,
      baseline_model: baseline, context_tokens: ctxTokens, amend_status: null,
      hold_kind: d.holdKind, hold_origin_id: d.action === "hold" ? store.holdOrigin(ctx.thread.id) : null,
      current_model: current?.model ?? null, current_effort: current?.effort ?? null, policy_rev: currentRev(),
    };
    return store.insertDecision(row);
  }

  // ---- usage + cleanup -------------------------------------------------
  bb.events.on("thread.idle", async ({ thread }) => {
    void guard(thread.id, "idle");
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
  bb.events.on("thread.deleted", ({ thread }) => { try { store.deletePref(thread.id); } catch { /* ignore */ } closeRun(thread.id); });

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

  /**
   * Thread titles for the threads a review lists, fetched at report time. A title comes from what the user wrote, so it is
   * never stored: it goes into the printed report only. Failures and slow lookups leave a thread without one.
   */
  async function threadTitles(threadIds: string[]): Promise<Record<string, string>> {
    const ids = threadIds.slice(0, MAX_TITLES);
    const titles: Record<string, string> = {};
    await Promise.all(ids.map(async (threadId) => {
      const t = await bounded((async () => bb.sdk.threads.get({ threadId }))(), PROVIDER_MS, null);
      const title = (t as { title?: unknown } | null)?.title;
      if (typeof title === "string" && title.trim()) titles[threadId] = title.trim();
    }));
    return titles;
  }

  // ---- CLI -------------------------------------------------------------
  const usage = "Usage:\n  bb gearshift status [--thread <id>]\n  bb gearshift on --thread <id>\n  bb gearshift off --thread <id>\n  bb gearshift explain <text...> [--provider <id>]\n  bb gearshift review [--days N] [--json] [--replay [--set <path>=<value>]...]\n  bb gearshift replay [--days N] [--set <path>=<value>]... [--json]\n  bb gearshift calibrate [--days N] [--min-samples N] [--json] [--apply]\n  bb gearshift policy [set <path> <value> | unset <path> | add-pattern <classId> <regex> | remove-pattern <classId> <regex>]\n  bb gearshift spawn --role <role> [--thread <id>] <prompt...>";
  const policyUsage = `Policy paths:\n  ${POLICY_PATHS.join("\n  ")}\n  add-pattern / remove-pattern take a scoring class id and a regex`;
  bb.cli.register({
    name: "gearshift",
    summary: "Automatic model routing: status, per-thread toggle, explain a routing decision",
    commands: [
      { name: "status", summary: "Show whether Gearshift is on, and the last decision", usage: "bb gearshift status [--thread <id>]" },
      { name: "on", summary: "Turn Gearshift on for a thread", usage: "bb gearshift on --thread <id>" },
      { name: "off", summary: "Turn Gearshift off for a thread", usage: "bb gearshift off --thread <id>" },
      { name: "review", summary: "Report on the last N days of routing: tiers, holds, manual picks, overkill and underkill, tuning hints", usage: "bb gearshift review [--days N] [--json] [--replay [--set <path>=<value>]...]" },
      { name: "replay", summary: "Re-run the last N days of routing decisions under the current policy, or with --set edits, and compare tiers, holds and estimated cost", usage: "bb gearshift replay [--days N] [--set <path>=<value>]... [--json]" },
      { name: "calibrate", summary: "Learn from the last N days which cheaper gear still got good outcomes per tier, and propose (or --apply) downshift-only ladder changes", usage: "bb gearshift calibrate [--days N] [--min-samples N] [--json] [--apply]" },
      { name: "policy", summary: "Print the effective routing policy as JSON, or edit one value of it (global, validated like the editor's Save)", usage: "bb gearshift policy [set <path> <value> | unset <path> | add-pattern <classId> <regex> | remove-pattern <classId> <regex>]" },
      { name: "spawn", summary: "Spawn a sub-agent thread for a team role on its policy gear and budget", usage: "bb gearshift spawn --role <role> [--thread <id>] <prompt...>" },
      { name: "explain", summary: "Classify text and show the gear it would get", usage: "bb gearshift explain <text...> [--provider <id>]" },
    ],
    async run(argv, ctx) {
      const flag = (name: string) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
      const threadId = flag("--thread") ?? ctx.threadId;
      const [cmd] = argv;
      /** An agent may act on its own thread or one below it; a human at a terminal (no calling thread) on any. */
      const mayAct = async (target: string) => {
        const caller = ctx.threadId;
        if (!caller || target === caller) return true;
        let cur: string | null = target;
        for (let i = 0; i < 8 && cur; i++) {
          const at: string = cur;
          const t = (await bounded((async () => bb.sdk.threads.get({ threadId: at }))(), PROVIDER_MS, null)) as { parentThreadId?: string | null } | null;
          cur = t?.parentThreadId ?? null;
          if (cur === caller) return true;
        }
        return false;
      };
      const denied = { exitCode: 1, stderr: "Not allowed: --thread must be your own thread or one of its sub-agents" };
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
          if (flag("--thread") && !(await mayAct(threadId))) return denied;
          store.setPref(threadId, cmd === "on"); changed(threadId);
          return { exitCode: 0, stdout: `Gearshift ${cmd} for ${threadId}` };
        }
        case "review": case "replay": {
          const d = flag("--days");
          const days = d === undefined ? 30 : Number(d);
          if (!Number.isInteger(days) || days < 1 || days > 365) return { exitCode: 1, stderr: "--days must be a whole number from 1 to 365" };
          const json = argv.includes("--json");
          const now = Date.now();
          const sets: ReplaySet[] = [];
          for (let i = 1; i < argv.length; i++) {
            if (argv[i] !== "--set") continue;
            const parsed = parseReplaySet(argv[i + 1] ?? "");
            if ("error" in parsed) return { exitCode: 1, stderr: parsed.error };
            sets.push(parsed);
            i++;
          }
          const history = store.since(now - (days + HISTORY_EXTRA_DAYS) * DAY);
          if (cmd === "review" && !argv.includes("--replay")) {
            if (sets.length) return { exitCode: 1, stderr: "--set needs --replay (or use bb gearshift replay)" };
            const built = buildReview(history, compiled.policy, { days, now, policyRev: currentRev(), policyChangedAt: rev.changedAt });
            const review = withTitles(built, await threadTitles(reviewThreadIds(built)));
            return { exitCode: 0, stdout: json ? JSON.stringify(review, null, 2) : formatReview(review) };
          }
          const applied = applyReplaySets(compiled.policy, { ...DEFAULT_POLICY, routing: compiled.policy.routing }, sets);
          if ("error" in applied) return { exitCode: 1, stderr: applied.error };
          const providers = [...new Set(history.filter((r) => r.at >= now - days * DAY).map((r) => r.provider_id))];
          const catalogs: Record<string, CatalogModel[] | null> = {};
          await Promise.all(providers.map(async (providerId) => { catalogs[providerId] = await bounded(catalogFor({ providerId }), PROVIDER_MS, null); }));
          const replay = replayDecisions(history, applied.policy, { days, now, catalogs, edits: sets.map((x) => `${x.path}=${x.value}`) });
          return { exitCode: 0, stdout: json ? JSON.stringify(replay, null, 2) : formatReplay(replay) };
        }
        case "calibrate": {
          const d = flag("--days");
          const days = d === undefined ? 30 : Number(d);
          if (!Number.isInteger(days) || days < 1 || days > 365) return { exitCode: 1, stderr: "--days must be a whole number from 1 to 365" };
          const ms = flag("--min-samples");
          const minSamples = ms === undefined ? MIN_SAMPLES : Number(ms);
          if (!Number.isInteger(minSamples) || minSamples < 3 || minSamples > 1000) return { exitCode: 1, stderr: "--min-samples must be a whole number from 3 to 1000" };
          const apply = argv.includes("--apply");
          const now = Date.now();
          const history = store.since(now - (days + HISTORY_EXTRA_DAYS) * DAY);
          const providers = [...new Set(history.filter((r) => r.at >= now - days * DAY).map((r) => r.provider_id))];
          const catalogs: Record<string, CatalogModel[] | null> = {};
          await Promise.all(providers.map(async (providerId) => { catalogs[providerId] = await bounded(catalogFor({ providerId }), PROVIDER_MS, null); }));
          const t0 = Date.now();
          const cal = calibrate(history, compiled.policy, { days, now, catalogs, minSamples });
          const revBefore = currentRev();
          let applied = false;
          if (apply && cal.proposals.length) {
            let next = mergePolicy(DEFAULT_POLICY, overrides);
            for (const s of cal.proposals.flatMap((p) => p.sets)) {
              const r = applyPolicyEdit(next, DEFAULT_POLICY, { op: "set", path: s.path, value: s.value });
              if ("error" in r) return { exitCode: 1, stderr: `Not applied: ${s.path}: ${r.error}` };
              next = r.policy;
            }
            const saved = await storeOverrides(diffOverrides(DEFAULT_POLICY, next));
            if (!saved.ok) return { exitCode: 1, stderr: `Not saved: ${saved.errors.map((e) => `${e.path}: ${e.message}`).join("; ") || "unknown error"}` };
            applied = true;
          }
          try {
            store.insertCalibration({ at: now, days, min_samples: minSamples, turns: cal.rows, with_outcome: cal.withOutcome, proposals: cal.proposals.length, weak: cal.weak.length,
              applied: applied ? 1 : 0, policy_rev_before: revBefore || null, policy_rev_after: applied ? currentRev() || null : null, duration_ms: Date.now() - t0,
              summary: JSON.stringify({ proposals: cal.proposals.map((p) => ({ providerId: p.providerId, tier: p.tier, sets: p.sets, evidence: p.evidence })), weak: cal.weak, uncalibrated: cal.uncalibrated }) });
          } catch (e) { bb.log.warn(`calibration log failed: ${String(e)}`); }
          bb.log.info(`calibrate: ${cal.rows} turns, ${cal.withOutcome} with outcomes, ${cal.proposals.length} downshift(s)${applied ? " applied" : ""}, ${cal.weak.length} weak`);
          return { exitCode: 0, stdout: argv.includes("--json") ? JSON.stringify({ ...cal, applied }, null, 2) : formatCalibration(cal, applied) };
        }
        case "policy": {
          if (argv.length > 1) {
            const [, op, a, ...rest] = argv;
            const bad = (m: string) => ({ exitCode: 1, stderr: `${m}\n${policyUsage}` });
            let edit: PolicyEdit;
            if (op === "set") { if (!a || rest.length === 0) return bad("set needs a path and a value"); edit = { op, path: a, value: rest.join(" ") }; }
            else if (op === "unset") { if (!a || rest.length) return bad("unset needs exactly a path"); edit = { op, path: a }; }
            else if (op === "add-pattern" || op === "remove-pattern") { if (!a || rest.length === 0) return bad(`${op} needs a class id and a regex`); edit = { op, classId: a, pattern: rest.join(" ") }; }
            else return bad(`Unknown policy command "${op}"`);
            const r = applyPolicyEdit(mergePolicy(DEFAULT_POLICY, overrides), DEFAULT_POLICY, edit);
            if ("error" in r) return { exitCode: 1, stderr: r.error };
            const saved = await storeOverrides(diffOverrides(DEFAULT_POLICY, r.policy));
            if (!saved.ok) return { exitCode: 1, stderr: `Not saved: ${saved.errors.map((e) => `${e.path}: ${e.message}`).join("; ") || "unknown error"}` };
            return { exitCode: 0, stdout: `${r.path}: ${r.before} → ${r.after}` };
          }
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
          if (flag("--thread") && !(await mayAct(threadId))) return denied;
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
