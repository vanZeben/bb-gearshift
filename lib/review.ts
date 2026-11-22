// Pure: decision rows -> a routing review the CLI prints and an agent reads ("bb gearshift review").
// No message text exists in storage, so the report is numbers, signals and thread ids only.
import { formatEffort, formatTier } from "./labels";
import { TIERS, ladderFor, type Policy, type Tier } from "./policy";
import type { DecisionRow } from "./store";

const DAY = 86_400_000;
const ROUTED = new Set(["shift", "keep", "hold"]);
const ACTIONS = ["shift", "keep", "hold", "manual", "skip", "off"] as const;

/** Output below this many tokens is "small work" (a short answer or a small edit). */
export const SMALL_OUTPUT_TOKENS = 1_500;
/** Output above this many tokens is "big work". */
export const BIG_OUTPUT_TOKENS = 10_000;
export const LIST_LIMIT = 15;
export const TOP_SIGNALS = 5;
/** Hint thresholds. */
export const HINT_XLARGE_SHARE = 0.35;
export const HINT_SMALL_OUTPUT_SHARE = 0.3;
export const HINT_SIGNAL_SHARE = 0.5;
export const HINT_SIGNAL_SMALL_SHARE = 0.4;
export const HINT_HOLD_COST_SHARE = 0.3;
export const HINT_MANUAL_LOWER_SHARE = 0.6;
/** Smallest sample a hint needs before it fires. */
export const HINT_MIN_ROWS = 5;

const EFFORT_RANK: Record<string, number> = { none: 0, minimal: 0, low: 1, medium: 2, high: 3, xhigh: 4, max: 5 };

export interface ReviewOptions { days: number; now?: number }

export interface SignalCount { signal: string; count: number }
export interface TierStats {
  tier: Tier; n: number; share: number; avgScore: number | null;
  outputP50: number | null; outputP90: number | null; turnsWithUsage: number; smallOutputShare: number | null;
  costUsd: number; topSignals: SignalCount[];
}
export interface GearStats { label: string; effort: string | null; n: number; costUsd: number }
export interface ReviewTurn {
  id: number; at: string; threadId: string; tier: Tier; score: number | null; signals: string[];
  gear: string; outputTokens: number; costUsd: number | null;
}
export interface SignalPrecision { signal: string; n: number; shareOfLargeRows: number; smallOutputShare: number | null }
export interface ReviewHint { id: string; message: string; evidence: Record<string, number | string> }
export interface Review {
  period: { days: number; from: string; to: string };
  counts: { total: number } & Record<(typeof ACTIONS)[number], number>;
  tiers: TierStats[];
  gears: GearStats[];
  holds: { n: number; costUsd: number; shareOfCost: number; avgContextTokens: number | null; gears: Array<{ gear: string; n: number }> };
  manualPicks: Array<{ tier: string; model: string; effort: string | null; n: number }>;
  overkill: ReviewTurn[];
  underkill: ReviewTurn[];
  signalPrecision: SignalPrecision[];
  policy: { tiers: Record<Tier, { min: number; max: number }>; gears: Record<string, Record<string, string>>; holdAboveTokens: number };
  hints: ReviewHint[];
}

const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
const round = (n: number, d = 2) => Math.round(n * 10 ** d) / 10 ** d;
function percentile(sorted: number[], p: number): number | null {
  if (!sorted.length) return null;
  return sorted[Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1)]!;
}
function signalsOf(r: DecisionRow): string[] {
  try { const v = JSON.parse(r.signals) as unknown; return Array.isArray(v) ? v.filter((s): s is string => typeof s === "string") : []; } catch { return []; }
}
const isTier = (t: string | null): t is Tier => !!t && (TIERS as readonly string[]).includes(t);
const gearText = (label: string | null, effort: string | null) => `${label ?? "?"}${formatEffort(effort) ? ` · ${formatEffort(effort)}` : ""}`;
function tally<K>(keys: Iterable<K>): Map<K, number> {
  const m = new Map<K, number>();
  for (const k of keys) m.set(k, (m.get(k) ?? 0) + 1);
  return m;
}

export function buildReview(rows: DecisionRow[], policy: Policy, opts: ReviewOptions): Review {
  const now = opts.now ?? Date.now();
  const from = now - opts.days * DAY;
  // Per-message stats use start-turn rows only (a join-turn row is a skip that joins a running turn).
  const inWindow = rows.filter((r) => r.attempt === "start-turn" && r.at >= from && r.at <= now);
  const routed = inWindow.filter((r) => ROUTED.has(r.action) && isTier(r.tier));

  const counts = { total: inWindow.length } as Review["counts"];
  for (const a of ACTIONS) counts[a] = inWindow.filter((r) => r.action === a).length;

  const totalCost = sum(routed.map((r) => r.cost_usd ?? 0));
  const smallOut = (r: DecisionRow) => r.output_tokens !== null && r.output_tokens < SMALL_OUTPUT_TOKENS;
  const withUsage = (rs: DecisionRow[]) => rs.filter((r) => r.output_tokens !== null);

  const tiers: TierStats[] = TIERS.map((tier) => {
    const rs = routed.filter((r) => r.tier === tier);
    const u = withUsage(rs);
    const outs = u.map((r) => r.output_tokens!).sort((a, b) => a - b);
    const scores = rs.filter((r) => r.score !== null).map((r) => r.score!);
    const sig = [...tally(rs.flatMap(signalsOf))].map(([signal, count]) => ({ signal, count })).sort((a, b) => b.count - a.count || a.signal.localeCompare(b.signal)).slice(0, TOP_SIGNALS);
    return {
      tier, n: rs.length, share: routed.length ? round(rs.length / routed.length, 3) : 0,
      avgScore: scores.length ? round(sum(scores) / scores.length) : null,
      outputP50: percentile(outs, 0.5), outputP90: percentile(outs, 0.9), turnsWithUsage: u.length,
      smallOutputShare: u.length ? round(u.filter(smallOut).length / u.length, 3) : null,
      costUsd: round(sum(rs.map((r) => r.cost_usd ?? 0)), 4), topSignals: sig,
    };
  }).filter((t) => t.n > 0);

  const gearMap = new Map<string, GearStats>();
  for (const r of routed) {
    const key = `${r.routed_label ?? r.routed_model ?? "?"}\u0000${r.routed_effort ?? ""}`;
    const g = gearMap.get(key) ?? { label: r.routed_label ?? r.routed_model ?? "?", effort: r.routed_effort, n: 0, costUsd: 0 };
    g.n++; g.costUsd += r.cost_usd ?? 0;
    gearMap.set(key, g);
  }
  const gears = [...gearMap.values()].map((g) => ({ ...g, costUsd: round(g.costUsd, 4) })).sort((a, b) => b.n - a.n);

  const heldRows = routed.filter((r) => r.action === "hold");
  const heldCost = sum(heldRows.map((r) => r.cost_usd ?? 0));
  const ctx = heldRows.filter((r) => r.context_tokens !== null).map((r) => r.context_tokens!);
  const holds: Review["holds"] = {
    n: heldRows.length, costUsd: round(heldCost, 4), shareOfCost: totalCost > 0 ? round(heldCost / totalCost, 3) : 0,
    avgContextTokens: ctx.length ? Math.round(sum(ctx) / ctx.length) : null,
    gears: [...tally(heldRows.map((r) => gearText(r.routed_label, r.routed_effort)))].map(([gear, n]) => ({ gear, n })).sort((a, b) => b.n - a.n),
  };

  const manual = inWindow.filter((r) => r.action === "manual");
  const manualMap = new Map<string, { tier: string; model: string; effort: string | null; n: number }>();
  for (const r of manual) {
    const tier = r.tier ?? "unclassified", model = r.requested_model ?? "?";
    const key = `${tier}\u0000${model}\u0000${r.requested_effort ?? ""}`;
    const e = manualMap.get(key) ?? { tier, model, effort: r.requested_effort, n: 0 };
    e.n++; manualMap.set(key, e);
  }
  const tierOrder = (t: string) => { const i = (TIERS as readonly string[]).indexOf(t); return i < 0 ? 99 : i; };
  const manualPicks = [...manualMap.values()].sort((a, b) => tierOrder(a.tier) - tierOrder(b.tier) || b.n - a.n);

  const toTurn = (r: DecisionRow): ReviewTurn => ({
    id: r.id, at: new Date(r.at).toISOString(), threadId: r.thread_id, tier: r.tier as Tier, score: r.score, signals: signalsOf(r),
    gear: gearText(r.routed_label, r.routed_effort), outputTokens: r.output_tokens!, costUsd: r.cost_usd,
  });
  const newest = (a: DecisionRow, b: DecisionRow) => b.at - a.at || b.id - a.id;
  const overkill = routed.filter((r) => (r.tier === "large" || r.tier === "xlarge") && smallOut(r)).sort(newest).slice(0, LIST_LIMIT).map(toTurn);
  const underkill = routed.filter((r) => (r.tier === "trivial" || r.tier === "small") && r.output_tokens !== null && r.output_tokens > BIG_OUTPUT_TOKENS).sort(newest).slice(0, LIST_LIMIT).map(toTurn);

  const largeRows = routed.filter((r) => r.tier === "large" || r.tier === "xlarge");
  const sigRows = new Map<string, DecisionRow[]>();
  for (const r of largeRows) for (const s of new Set(signalsOf(r))) sigRows.set(s, [...(sigRows.get(s) ?? []), r]);
  const signalPrecision: SignalPrecision[] = [...sigRows].map(([signal, rs]) => {
    const u = withUsage(rs);
    return { signal, n: rs.length, shareOfLargeRows: round(rs.length / largeRows.length, 3), smallOutputShare: u.length ? round(u.filter(smallOut).length / u.length, 3) : null };
  }).sort((a, b) => b.n - a.n || a.signal.localeCompare(b.signal));

  const providers = [...new Set(inWindow.map((r) => r.provider_id))].sort();
  const gearsByProvider: Review["policy"]["gears"] = {};
  for (const pid of providers.length ? providers : ["*"]) {
    const ladder = ladderFor(policy, pid);
    gearsByProvider[pid] = Object.fromEntries(TIERS.map((t) => [t, `${ladder[t].model}${ladder[t].effort ? ` · ${ladder[t].effort}` : ""}`]));
  }

  const review: Review = {
    period: { days: opts.days, from: new Date(from).toISOString(), to: new Date(now).toISOString() },
    counts, tiers, gears, holds, manualPicks, overkill, underkill, signalPrecision,
    policy: { tiers: policy.tiers, gears: gearsByProvider, holdAboveTokens: policy.routing.holdAboveTokens },
    hints: [],
  };
  review.hints = buildHints(review, largeRows.length, manual, policy);
  return review;
}

const pct = (x: number) => `${Math.round(x * 100)}%`;

function buildHints(rv: Review, largeN: number, manual: DecisionRow[], policy: Policy): ReviewHint[] {
  const hints: ReviewHint[] = [];
  const x = rv.tiers.find((t) => t.tier === "xlarge");
  if (x && x.n >= HINT_MIN_ROWS && x.share > HINT_XLARGE_SHARE && (x.smallOutputShare ?? 0) > HINT_SMALL_OUTPUT_SHARE) {
    hints.push({
      id: "xlarge-share",
      message: `X-large takes ${pct(x.share)} of routed messages and ${pct(x.smallOutputShare!)} of those answered in under ${SMALL_OUTPUT_TOKENS} tokens. Consider raising the xlarge band start (tiers.xlarge.min) or lowering the xlarge gear's effort.`,
      evidence: { share: x.share, smallOutputShare: x.smallOutputShare!, n: x.n, xlargeMin: policy.tiers.xlarge.min },
    });
  }
  if (largeN >= HINT_MIN_ROWS) {
    for (const s of rv.signalPrecision) {
      if (s.shareOfLargeRows > HINT_SIGNAL_SHARE && (s.smallOutputShare ?? 0) > HINT_SIGNAL_SMALL_SHARE) {
        hints.push({
          id: `broad-signal:${s.signal}`,
          message: `Signal "${s.signal}" is in ${pct(s.shareOfLargeRows)} of large/x-large messages and ${pct(s.smallOutputShare!)} of those had small output. It is broad: remove a pattern from its class or lower its add/floor.`,
          evidence: { signal: s.signal, n: s.n, shareOfLargeRows: s.shareOfLargeRows, smallOutputShare: s.smallOutputShare! },
        });
      }
    }
  }
  if (rv.holds.n >= HINT_MIN_ROWS && rv.holds.shareOfCost > HINT_HOLD_COST_SHARE) {
    hints.push({
      id: "hold-cost",
      message: `Held messages are ${pct(rv.holds.shareOfCost)} of cost. A hold keeps the gear an earlier message chose, so a large/x-large effort carries into every held turn. Consider a lower effort on the xlarge/large gear, or accept it (a hold is cheaper than re-reading a big context).`,
      evidence: { holds: rv.holds.n, costUsd: rv.holds.costUsd, shareOfCost: rv.holds.shareOfCost },
    });
  }
  for (const t of TIERS) {
    const picks = manual.filter((r) => r.tier === t && r.requested_effort);
    if (picks.length < HINT_MIN_ROWS) continue;
    const lower = picks.filter((r) => {
      const want = ladderFor(policy, r.provider_id)[t].effort;
      return want !== undefined && (EFFORT_RANK[r.requested_effort!] ?? 0) < (EFFORT_RANK[want] ?? 0);
    });
    if (lower.length / picks.length >= HINT_MANUAL_LOWER_SHARE) {
      hints.push({
        id: `manual-lower:${t}`,
        message: `${lower.length} of ${picks.length} manual picks in ${formatTier(t)} chose a lower effort than the ${t} gear. Consider lowering gears.<provider>.${t}.effort.`,
        evidence: { tier: t, picks: picks.length, lower: lower.length },
      });
    }
  }
  return hints;
}

const usd = (n: number) => `$${n.toFixed(2)}`;
const num = (n: number | null) => (n === null ? "n/a" : String(n));

export function formatReview(rv: Review): string {
  const L: string[] = [];
  const { counts: c } = rv;
  L.push(`Gearshift routing review: last ${rv.period.days} days (${rv.period.from.slice(0, 10)} to ${rv.period.to.slice(0, 10)})`);
  L.push(`Decisions: ${c.total} (shift ${c.shift}, keep ${c.keep}, hold ${c.hold}, manual ${c.manual}, skip ${c.skip}, off ${c.off})`);
  if (!rv.tiers.length) { L.push("", "No routed messages in this period."); return L.join("\n"); }

  L.push("", "Tiers (routed messages; output tokens from turns with usage)");
  for (const t of rv.tiers) {
    L.push(`- ${formatTier(t.tier)}: ${t.n} (${pct(t.share)}), avg score ${num(t.avgScore)}, output p50 ${num(t.outputP50)} / p90 ${num(t.outputP90)}, small output (<${SMALL_OUTPUT_TOKENS}) ${t.smallOutputShare === null ? "n/a" : pct(t.smallOutputShare)}, cost ${usd(t.costUsd)}`);
    if (t.topSignals.length) L.push(`    signals: ${t.topSignals.map((s) => `${s.signal} ${s.count}`).join(", ")}`);
  }
  L.push("", "Gears used");
  for (const g of rv.gears) L.push(`- ${gearText(g.label, g.effort)}: ${g.n} messages, ${usd(g.costUsd)}`);

  L.push("", "Holds");
  L.push("A hold keeps the gear (model and effort) an earlier message put the thread on, so the effort of the large and x-large gears carries into every held turn of a long thread.");
  L.push(`- ${rv.holds.n} held, ${usd(rv.holds.costUsd)} (${pct(rv.holds.shareOfCost)} of cost), avg context ${num(rv.holds.avgContextTokens)} tokens`);
  if (rv.holds.gears.length) L.push(`- held gears: ${rv.holds.gears.map((g) => `${g.gear} ${g.n}`).join(", ")}`);

  L.push("", "Manual picks (you overrode Gearshift)");
  if (!rv.manualPicks.length) L.push("- none");
  for (const m of rv.manualPicks) L.push(`- ${m.tier}: ${m.model}${m.effort ? ` · ${m.effort}` : ""} x${m.n}`);

  const turns = (title: string, list: ReviewTurn[]) => {
    L.push("", title);
    if (!list.length) L.push("- none");
    for (const r of list) L.push(`- #${r.id} ${r.at.slice(0, 16)}Z thread ${r.threadId} ${r.tier} score ${num(r.score)} [${r.signals.join(", ")}] on ${r.gear}, output ${r.outputTokens}${r.costUsd !== null ? `, ${usd(r.costUsd)}` : ""}`);
  };
  turns(`Possible overkill (large/x-large, output under ${SMALL_OUTPUT_TOKENS} tokens)`, rv.overkill);
  turns(`Possible underkill (trivial/small, output over ${BIG_OUTPUT_TOKENS} tokens)`, rv.underkill);

  L.push("", "Signal precision (in large/x-large messages)");
  if (!rv.signalPrecision.length) L.push("- none");
  for (const s of rv.signalPrecision) L.push(`- ${s.signal}: ${s.n} ${s.n === 1 ? "message" : "messages"} (${pct(s.shareOfLargeRows)}), small output ${s.smallOutputShare === null ? "n/a" : pct(s.smallOutputShare)}`);

  L.push("", "Current policy");
  L.push(`- bands: ${TIERS.map((t) => `${t} ${rv.policy.tiers[t].min}-${rv.policy.tiers[t].max}`).join(", ")}`);
  for (const [pid, g] of Object.entries(rv.policy.gears)) L.push(`- gears ${pid}: ${TIERS.map((t) => `${t} ${g[t]}`).join("; ")}`);
  L.push(`- holdAboveTokens: ${rv.policy.holdAboveTokens}`);

  L.push("", "Hints (starting points, not actions)");
  if (!rv.hints.length) L.push("- none fired");
  for (const h of rv.hints) L.push(`- ${h.message}`);
  return L.join("\n");
}
