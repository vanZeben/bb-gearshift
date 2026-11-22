// Pure: re-run stored routing decisions under the current policy, or under hypothetical edits ("bb gearshift replay").
// Storage holds no message text, so messages are never re-scored: each decision keeps its recorded score, which is
// re-banded under the replayed tiers. Gears, effort, holds and the hold rule are replayed with the router's own
// `routeTier`; costs are estimates (see `notes`).
import { tierForScore } from "./classify";
import { effortRank, type CatalogModel } from "./gears";
import { formatEffort, formatTier } from "./labels";
import { applyPolicyEdit } from "./policy-edit";
import { TIERS, validatePolicy, type Policy, type Tier } from "./policy";
import { costUsd, priceFor, tierMultiplier, type Usage } from "./pricing";
import { HINT_MIN_ROWS } from "./review";
import { routeTier, type CurrentGear } from "./router";
import type { DecisionRow } from "./store";

const DAY = 86_400_000;
const ROUTED = new Set(["shift", "keep", "hold"]);

export interface ReplaySet { path: string; value: string }
export interface ReplayOptions {
  days: number;
  now?: number;
  /** Live model lists per provider id; a provider without one is not replayed (its rows keep their gear). */
  catalogs: Record<string, CatalogModel[] | null>;
  /** The `--set` edits the policy carries, for the report heading. */
  edits?: string[];
}
export interface ReplaySide {
  tiers: Array<{ tier: Tier; n: number; share: number }>;
  gears: Array<{ gear: string; n: number; costUsd: number }>;
  held: number;
  costUsd: number;
}
export interface Replay {
  period: { days: number; from: string; to: string };
  edits: string[];
  /** Routed messages in the window. */
  rows: number;
  /** Routed messages whose gear was decided again. */
  replayed: number;
  /** Routed rows that kept their recorded gear, by reason. */
  notReplayed: Record<string, number>;
  /** Rows with token usage and a cost (the only ones that carry one). */
  priced: number;
  /** Rows whose new gear has no price: they keep their recorded cost. */
  unpriced: number;
  before: ReplaySide;
  after: ReplaySide;
  delta: { costUsd: number; share: number | null };
  changes: { tierMoves: number; modelChanges: number; effortLower: number; effortHigher: number; holdKinds: Record<string, number> };
  /** Rows whose effort changed with no data to estimate the effect on output tokens (priced with unchanged output). */
  effortUnestimated: number;
  notes: string[];
}

const round = (n: number, d = 4) => Math.round(n * 10 ** d) / 10 ** d;
const isTier = (t: string | null): t is Tier => !!t && (TIERS as readonly string[]).includes(t);
const gearText = (label: string, effort: string | null) => `${label}${formatEffort(effort) ? ` · ${formatEffort(effort)}` : ""}`;
const isContinuation = (r: DecisionRow) => r.hold_kind === "continuation" || (r.hold_kind == null && r.reason.startsWith("Continuing on"));
/** "You asked for Opus": the message named a model, which no policy edit changes. */
const isExplicitRequest = (r: DecisionRow) => r.reason.startsWith("You asked for ");
const sameGear = (a: CurrentGear, b: CurrentGear) => a.model === b.model && (a.effort ?? null) === (b.effort ?? null) && (a.serviceTier ?? null) === (b.serviceTier ?? null);

const BOOL_TRUE = /^(true|on|yes|1)$/i;
const BOOL_FALSE = /^(false|off|no|0)$/i;

/**
 * Apply `--set path=value` edits to a policy. `routing.holdAboveTokens` and `routing.holdEffortFollowsMessage`
 * (plugin settings, not policy paths) are accepted here so a replay can try them; every other path goes
 * through the same validation as `bb gearshift policy set`.
 */
export function applyReplaySets(policy: Policy, defaults: Policy, sets: ReplaySet[]): { policy: Policy } | { error: string } {
  let p: Policy = JSON.parse(JSON.stringify(policy)) as Policy;
  for (const s of sets) {
    const v = s.value.trim();
    if (s.path === "routing.holdAboveTokens") {
      const n = Number(v);
      if (v === "" || !Number.isInteger(n) || n < 0) return { error: `routing.holdAboveTokens takes a whole number of 0 or more, got "${s.value}"` };
      p = { ...p, routing: { ...p.routing, holdAboveTokens: n } };
      continue;
    }
    if (s.path === "routing.holdEffortFollowsMessage") {
      if (!BOOL_TRUE.test(v) && !BOOL_FALSE.test(v)) return { error: `routing.holdEffortFollowsMessage takes true or false, got "${s.value}"` };
      p = { ...p, routing: { ...p.routing, holdEffortFollowsMessage: BOOL_TRUE.test(v) } };
      continue;
    }
    if (s.path.startsWith("routing.")) return { error: `Replay can set routing.holdAboveTokens and routing.holdEffortFollowsMessage; "${s.path}" is not replayable` };
    const r = applyPolicyEdit(p, defaults, { op: "set", path: s.path, value: s.value });
    if ("error" in r) return { error: r.error };
    p = r.policy;
  }
  const errors = validatePolicy(p);
  return errors.length ? { error: errors.map((e) => `${e.path}: ${e.message}`).join("; ") } : { policy: p };
}

/** Parse one `--set` argument ("path=value"). */
export function parseReplaySet(arg: string): ReplaySet | { error: string } {
  const at = arg.indexOf("=");
  if (at <= 0 || !arg.slice(0, at).trim()) return { error: `--set takes path=value, got "${arg}"` };
  return { path: arg.slice(0, at).trim(), value: arg.slice(at + 1) };
}

/** Mean output tokens per (model, effort) in the window, from turns with usage. */
function outputMeans(rows: DecisionRow[]): Map<string, { n: number; mean: number }> {
  const acc = new Map<string, { n: number; sum: number }>();
  for (const r of rows) {
    if (r.output_tokens === null || !r.routed_model) continue;
    const k = `${r.routed_model}\u0000${r.routed_effort ?? ""}`;
    const a = acc.get(k) ?? { n: 0, sum: 0 };
    a.n++; a.sum += r.output_tokens; acc.set(k, a);
  }
  return new Map([...acc].map(([k, a]) => [k, { n: a.n, mean: a.sum / a.n }]));
}

/**
 * Decide every routed message of the window again under `policy`, walking each thread in order so a hold sees the
 * gear the replay gave the previous message. `rows` may reach back before the window: earlier rows only tell the
 * replay which gear a thread was on when the window opened.
 */
export function replayDecisions(rows: DecisionRow[], policy: Policy, opts: ReplayOptions): Replay {
  const now = opts.now ?? Date.now();
  const from = now - opts.days * DAY;
  const ordered = rows.filter((r) => r.attempt === "start-turn" && r.at <= now).sort((a, b) => a.at - b.at || a.id - b.id);
  const means = outputMeans(ordered.filter((r) => r.at >= from));
  const notReplayed: Record<string, number> = {};
  const miss = (why: string) => { notReplayed[why] = (notReplayed[why] ?? 0) + 1; };
  const changes: Replay["changes"] = { tierMoves: 0, modelChanges: 0, effortLower: 0, effortHigher: 0, holdKinds: {} };
  let replayed = 0, priced = 0, unpriced = 0, effortUnestimated = 0, total = 0;
  const beforeT = new Map<Tier, number>(), afterT = new Map<Tier, number>();
  type GearAcc = Map<string, { n: number; costUsd: number }>;
  const beforeG: GearAcc = new Map(), afterG: GearAcc = new Map();
  let heldBefore = 0, heldAfter = 0, costBefore = 0, costAfter = 0;
  const bump = (m: GearAcc, k: string, c: number | null) => { const e = m.get(k) ?? { n: 0, costUsd: 0 }; e.n++; e.costUsd += c ?? 0; m.set(k, e); };
  /** The replayed gear each thread is on (what the next message's hold rule sees). */
  const threadGear = new Map<string, CurrentGear>();
  const labels = new Map<string, string>();
  for (const r of ordered) if (r.routed_model && r.routed_label) labels.set(r.routed_model, r.routed_label);
  for (const cat of Object.values(opts.catalogs)) for (const m of cat ?? []) labels.set(m.id, m.displayName || m.id);
  const label = (model: string) => labels.get(model) ?? model;

  for (const r of ordered) {
    const inWindow = r.at >= from;
    const recorded: CurrentGear | null = r.routed_model ? { model: r.routed_model, effort: r.routed_effort, serviceTier: r.routed_service_tier }
      : r.requested_model ? { model: r.requested_model, effort: r.requested_effort, serviceTier: null } : null;
    const routed = ROUTED.has(r.action) && isTier(r.tier);
    if (!routed || !inWindow) {
      // Hand-picked, skipped and off messages (and anything before the window) ran on a known gear; they are not re-routed.
      if (recorded) threadGear.set(r.thread_id, recorded);
      continue;
    }
    total++;
    const oldTier = r.tier as Tier;
    const newTier = r.score === null ? oldTier : tierForScore(r.score, policy.tiers);
    beforeT.set(oldTier, (beforeT.get(oldTier) ?? 0) + 1);
    afterT.set(newTier, (afterT.get(newTier) ?? 0) + 1);
    if (newTier !== oldTier) changes.tierMoves++;
    if (r.action === "hold") heldBefore++;
    if (r.cost_usd !== null) { priced++; costBefore += r.cost_usd; }
    if (recorded) bump(beforeG, gearText(label(recorded.model), recorded.effort), r.cost_usd);

    // The gear the thread was on: the replay's own previous message, else what the hook saw, else (a hold) what it held.
    const prior = threadGear.get(r.thread_id);
    const before: CurrentGear | null = prior ?? (r.current_model ? { model: r.current_model, effort: r.current_effort ?? null }
      : r.action === "hold" ? recorded : null);
    // The same, as it really was when the turn ran: what the recorded cache state reflects.
    const realBeforeModel = r.current_model ?? (r.action === "hold" ? recorded?.model ?? null : null);

    let next: CurrentGear | null = recorded;
    let kind: string | null = r.hold_kind ?? null;
    let isHold = r.action === "hold";
    const cat = opts.catalogs[r.provider_id];
    if (isExplicitRequest(r)) {
      miss("model named in the message");
    } else if (isContinuation(r)) {
      next = before ?? recorded; kind = "continuation"; replayed++;
      isHold = !!next && !(next.model === r.requested_model && (next.effort ?? null) === (r.requested_effort ?? null));
    } else if (!cat || cat.length === 0) {
      miss(`no model list for ${r.provider_id}`);
    } else {
      const route = routeTier({ tier: newTier, signals: [], providerId: r.provider_id, current: before, contextTokens: r.context_tokens, catalog: cat, policy });
      if (!route) miss(`no model for ${newTier} on ${r.provider_id}`);
      else {
        replayed++;
        const g = route.gear;
        // A tier the gear does not name keeps what the composer had; the same model keeps its recorded service tier.
        next = {
          model: g.model, effort: g.effort ?? r.requested_effort,
          serviceTier: g.serviceTier ?? (recorded && recorded.model === g.model ? recorded.serviceTier ?? null : null),
        };
        kind = route.holdKind; isHold = route.action === "hold";
      }
    }
    if (isHold) heldAfter++;
    if (kind && (isHold || kind === "downshift")) changes.holdKinds[kind] = (changes.holdKinds[kind] ?? 0) + 1;

    let after = r.cost_usd;
    if (next && recorded && !sameGear(next, recorded)) {
      if (next.model !== recorded.model) changes.modelChanges++;
      if (effortRank(next.effort) < effortRank(recorded.effort)) changes.effortLower++;
      if (effortRank(next.effort) > effortRank(recorded.effort)) changes.effortHigher++;
      if (r.cost_usd !== null && r.input_tokens !== null && r.output_tokens !== null) {
        const reads = r.cache_read_tokens ?? 0, writes = r.cache_write_tokens ?? 0;
        const switched = !!before && next.model !== before.model;
        const switchedThen = realBeforeModel !== null && recorded.model !== realBeforeModel;
        // A model switch writes the context to the new model's cache; staying reads it from cache.
        const cache = switched && !switchedThen ? { cacheReadTokens: 0, cacheWriteTokens: reads + writes }
          : !switched && switchedThen ? { cacheReadTokens: reads + writes, cacheWriteTokens: 0 } : { cacheReadTokens: reads, cacheWriteTokens: writes };
        let out = r.output_tokens;
        if ((next.effort ?? null) !== (recorded.effort ?? null)) {
          const a = means.get(`${next.model}\u0000${next.effort ?? ""}`), b = means.get(`${recorded.model}\u0000${recorded.effort ?? ""}`);
          if (a && b && a.n >= HINT_MIN_ROWS && b.n >= HINT_MIN_ROWS && b.mean > 0) out = Math.round(out * (a.mean / b.mean));
          else effortUnestimated++;
        }
        const u: Usage = { inputTokens: r.input_tokens, outputTokens: out, ...cache };
        const c = costUsd(u, priceFor(next.model, policy.prices), tierMultiplier(policy, next.serviceTier));
        if (c === null) unpriced++; else after = c;
      }
    }
    if (r.cost_usd !== null) costAfter += after ?? r.cost_usd;
    if (next) bump(afterG, gearText(label(next.model), next.effort ?? null), r.cost_usd === null ? null : after ?? r.cost_usd);
    if (next) threadGear.set(r.thread_id, next);
  }

  const side = (t: Map<Tier, number>, g: GearAcc, held: number, cost: number): ReplaySide => ({
    tiers: TIERS.map((tier) => ({ tier, n: t.get(tier) ?? 0, share: total ? round((t.get(tier) ?? 0) / total, 3) : 0 })).filter((x) => x.n > 0),
    gears: [...g].map(([gear, v]) => ({ gear, n: v.n, costUsd: round(v.costUsd) })).sort((a, b) => b.costUsd - a.costUsd || b.n - a.n || a.gear.localeCompare(b.gear)),
    held, costUsd: round(cost),
  });
  const notes = [
    "Messages are not stored, so nothing is re-scored: each decision keeps its recorded score, re-banded under the replayed tiers. Changes to scoring classes, patterns or other scoring weights cannot be replayed.",
    "Costs are estimates: each turn keeps its recorded token usage on the new gear. A model change prices the turn's cached context as cache writes (a switch) or reads (no switch).",
    `Effort changes scale output tokens by the window's own average output per model and effort when both have at least ${HINT_MIN_ROWS} turns; otherwise output is left unchanged.`,
    "Messages that name a model, hand-picked, skipped and off messages are not re-routed; turns without usage carry no cost.",
  ];
  return {
    period: { days: opts.days, from: new Date(from).toISOString(), to: new Date(now).toISOString() },
    edits: opts.edits ?? [], rows: total, replayed, notReplayed, priced, unpriced,
    before: side(beforeT, beforeG, heldBefore, costBefore),
    after: side(afterT, afterG, heldAfter, costAfter),
    delta: { costUsd: round(costAfter - costBefore), share: costBefore > 0 ? round((costAfter - costBefore) / costBefore, 3) : null },
    changes, effortUnestimated, notes,
  };
}

const usd = (n: number) => `${n < 0 ? "-" : ""}$${Math.abs(n).toFixed(2)}`;
const pct = (x: number) => `${Math.round(x * 100)}%`;

export function formatReplay(rp: Replay): string {
  const L: string[] = [];
  L.push(`Gearshift replay: last ${rp.period.days} days (${rp.period.from.slice(0, 10)} to ${rp.period.to.slice(0, 10)})`);
  L.push(rp.edits.length ? `Under the current policy with: ${rp.edits.join(", ")}` : "Under the current policy (and the current hold rule)");
  if (!rp.rows) { L.push("", "No routed messages in this period."); return L.join("\n"); }
  const kept = Object.entries(rp.notReplayed).map(([k, n]) => `${k} ${n}`).join(", ");
  L.push(`Routed messages: ${rp.rows}, replayed ${rp.replayed}${kept ? ` (kept as recorded: ${kept})` : ""}; ${rp.priced} with usage`);
  L.push("", "Tier shares (before → after)");
  for (const t of TIERS) {
    const b = rp.before.tiers.find((x) => x.tier === t), a = rp.after.tiers.find((x) => x.tier === t);
    if (!b && !a) continue;
    L.push(`- ${formatTier(t)}: ${b?.n ?? 0} (${pct(b?.share ?? 0)}) → ${a?.n ?? 0} (${pct(a?.share ?? 0)})`);
  }
  L.push("", "Cost (estimated)");
  L.push(`- before ${usd(rp.before.costUsd)} → after ${usd(rp.after.costUsd)}: ${usd(rp.delta.costUsd)}${rp.delta.share === null ? "" : ` (${rp.delta.share > 0 ? "+" : ""}${pct(rp.delta.share)})`}`);
  const kinds = Object.entries(rp.changes.holdKinds).map(([k, n]) => `${k} ${n}`).join(", ");
  L.push(`- held: ${rp.before.held} → ${rp.after.held}${kinds ? ` (${kinds})` : ""}`);
  L.push(`- changed: ${rp.changes.tierMoves} tier moves, ${rp.changes.modelChanges} model changes, ${rp.changes.effortLower} lower effort, ${rp.changes.effortHigher} higher effort`);
  if (rp.effortUnestimated) L.push(`- ${rp.effortUnestimated} effort changes had too little data to estimate output; priced with unchanged output`);
  if (rp.unpriced) L.push(`- ${rp.unpriced} turns moved to a model with no price; they keep their recorded cost`);
  L.push("", "Gears after (by cost)");
  for (const g of rp.after.gears.slice(0, 10)) L.push(`- ${g.gear}: ${g.n} messages, ${usd(g.costUsd)}`);
  L.push("", "What is estimated");
  for (const n of rp.notes) L.push(`- ${n}`);
  return L.join("\n");
}
