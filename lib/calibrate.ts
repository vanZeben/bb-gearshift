// Pure: trace-driven calibration ("bb gearshift calibrate").
// Per query class (provider x the tier the score put the message in), learn from past decisions the cheapest gear
// that still had good outcomes, and propose it for that tier's ladder slot. Downshift only: a proposal is never
// heavier than the current gear on any axis (model price, effort); evidence that a tier needs a bigger gear is
// reported, never applied.
//
// The idea (group traces by query class, score each model by its outcomes, pick per class) comes from the
// TraceDrivenPolicy in Stanford's OpenJarvis (Apache-2.0). Gearshift stores no message text and no ratings, so
// the class is the scored tier and the outcome is behavioural: a turn is bad when the user re-sent the same
// message or hand-picked a heavier gear right after it. And where OpenJarvis picks the best-scoring model,
// this picks the cheapest one that is good enough, with a confidence bound instead of a raw success rate.
import { effortRank, resolveGear, sizeClass, type CatalogModel } from "./gears";
import { formatEffort, formatTier } from "./labels";
import { TIERS, ladderFor, type Policy, type Tier } from "./policy";
import { priceFor } from "./pricing";
import type { DecisionRow } from "./store";

const DAY = 86_400_000;
const EVIDENCE_ACTIONS = new Set(["shift", "keep", "hold", "manual"]);

/** A later message in the same thread within this long can mark a turn as bad. */
export const CORRECTION_WINDOW_MS = 15 * 60_000;
/** Turns with outcomes a gear needs on a class before it can be proposed (or flagged as weak). */
export const MIN_SAMPLES = 8;
/** A proposed gear's success rate, at its lower confidence bound, must reach this. */
export const SUCCESS_FLOOR = 0.7;
/** The proposed gear's raw success rate may trail the current gear's by at most this much. */
export const MAX_SUCCESS_DROP = 0.05;
/** The current gear is flagged as possibly too small when its success rate is below this (reported only). */
export const WEAK_SUCCESS = 0.8;
/** Quality floor: large and x-large work never drops below this effort. */
export const MIN_EFFORT_LARGE = "medium";
/** z for a one-sided 95% Wilson bound. */
const Z = 1.645;

export type BadOutcome = "retried" | "corrected";
export interface CalibrateOptions {
  days: number; now?: number;
  /** Live model catalogs by provider id; a provider without one is reported but never calibrated. */
  catalogs: Record<string, CatalogModel[] | null>;
  minSamples?: number;
}
export interface GearKey { model: string; effort: string | null }
export interface GearOutcome extends GearKey {
  label: string; n: number; good: number; retried: number; corrected: number;
  successRate: number; lowerBound: number; avgCostUsd: number | null;
  /** Cheaper than the current gear on at least one axis and heavier on none. */
  lower: boolean; current: boolean;
}
export interface ClassCalibration {
  providerId: string; tier: Tier; current: (GearKey & { label: string }) | null;
  turns: number; unknown: number; gears: GearOutcome[];
  proposal: Proposal | null;
  /** Why no proposal (when none). */
  note: string | null;
}
export interface Proposal {
  providerId: string; tier: Tier; from: GearKey & { label: string }; to: GearKey & { label: string };
  /** Policy edits, in order, for "bb gearshift policy set" or "bb gearshift replay --set". */
  sets: Array<{ path: string; value: string }>;
  evidence: { n: number; successRate: number; lowerBound: number; currentN: number; currentSuccessRate: number | null };
}
export interface Weak { providerId: string; tier: Tier; gear: string; n: number; successRate: number }
export interface Calibration {
  period: { days: number; from: string; to: string };
  minSamples: number;
  rows: number; withOutcome: number;
  classes: ClassCalibration[];
  proposals: Proposal[];
  /** Classes whose current gear looks too small. Reported for a person to decide; calibration never upshifts. */
  weak: Weak[];
  uncalibrated: Array<{ providerId: string; reason: string }>;
}

const round = (n: number, d = 3) => Math.round(n * 10 ** d) / 10 ** d;
const isTier = (t: string | null | undefined): t is Tier => !!t && (TIERS as readonly string[]).includes(t);
const gearOf = (r: DecisionRow): GearKey | null =>
  r.routed_model ? { model: r.routed_model, effort: r.routed_effort } : r.requested_model ? { model: r.requested_model, effort: r.requested_effort } : null;
const keyOf = (g: GearKey) => `${g.model}\u0000${g.effort ?? ""}`;

/** Wilson score lower bound for good/n. */
export function wilsonLower(good: number, n: number, z = Z): number {
  if (n === 0) return 0;
  const p = good / n, z2 = z * z;
  return (p + z2 / (2 * n) - z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / (1 + z2 / n);
}

/**
 * The model axis of a gear's cost: the policy's output price when known, else a size-class rank scaled far below
 * any real price ordering. Two models compare by price only when both have one.
 */
function modelCost(model: string, policy: Policy, catalog: CatalogModel[]): { price: number | null; cls: number } {
  const entry = catalog.find((m) => m.id === model);
  const cls = sizeClass(entry ?? { id: model, displayName: "" });
  return { price: priceFor(model, policy.prices)?.output ?? null, cls: cls === "small" ? 0 : cls === "medium" ? 1 : 2 };
}
/** -1 when a is cheaper, 0 same, 1 heavier. */
function compareModel(a: string, b: string, policy: Policy, catalog: CatalogModel[]): number {
  if (a === b) return 0;
  const ca = modelCost(a, policy, catalog), cb = modelCost(b, policy, catalog);
  if (ca.price !== null && cb.price !== null && ca.price !== cb.price) return ca.price < cb.price ? -1 : 1;
  if (ca.price !== null && cb.price !== null) return 0;
  return Math.sign(ca.cls - cb.cls);
}
/** Is `a` cheaper than `b` on at least one axis and heavier on none? */
export function isDownshift(a: GearKey, b: GearKey, policy: Policy, catalog: CatalogModel[]): boolean {
  const m = compareModel(a.model, b.model, policy, catalog);
  const e = Math.sign(effortRank(a.effort) - effortRank(b.effort));
  return m <= 0 && e <= 0 && (m < 0 || e < 0);
}
const notBelow = (a: GearKey, floor: GearKey, policy: Policy, catalog: CatalogModel[]) =>
  compareModel(a.model, floor.model, policy, catalog) >= 0 && effortRank(a.effort) >= effortRank(floor.effort);

/**
 * Outcome of each turn: bad when, within the correction window, the same thread re-sent the same message
 * (retried) or the next message was a hand-picked gear heavier than this turn's (corrected). Turns without usage
 * never finished as far as Gearshift knows, so their outcome is unknown.
 */
export function outcomes(rows: DecisionRow[], policy: Policy, catalogs: Record<string, CatalogModel[] | null>): Map<number, BadOutcome | "good" | "unknown"> {
  const out = new Map<number, BadOutcome | "good" | "unknown">();
  const byThread = new Map<string, DecisionRow[]>();
  for (const r of rows) if (r.attempt === "start-turn") (byThread.get(r.thread_id) ?? byThread.set(r.thread_id, []).get(r.thread_id)!).push(r);
  for (const list of byThread.values()) {
    list.sort((a, b) => a.at - b.at || a.id - b.id);
    list.forEach((r, i) => {
      if (r.output_tokens === null || r.output_tokens === undefined) { out.set(r.id, "unknown"); return; }
      const gear = gearOf(r);
      const catalog = catalogs[r.provider_id] ?? [];
      let verdict: BadOutcome | "good" = "good";
      for (let j = i + 1; j < list.length && list[j]!.at - r.at <= CORRECTION_WINDOW_MS; j++) {
        const later = list[j]!;
        if (r.fingerprint && later.fingerprint === r.fingerprint) { verdict = "retried"; break; }
      }
      const next = list[i + 1];
      if (verdict === "good" && next && next.at - r.at <= CORRECTION_WINDOW_MS && next.action === "manual" && gear) {
        const picked = gearOf(next);
        if (picked && isDownshift(gear, picked, policy, catalog)) verdict = "corrected";
      }
      out.set(r.id, verdict);
    });
  }
  return out;
}

export function calibrate(rows: DecisionRow[], policy: Policy, opts: CalibrateOptions): Calibration {
  const now = opts.now ?? Date.now();
  const from = now - opts.days * DAY;
  const minSamples = opts.minSamples ?? MIN_SAMPLES;
  // Outcomes look forward in time, so they are computed on every row; evidence is the in-window rows only.
  const verdicts = outcomes(rows.filter((r) => r.at <= now + CORRECTION_WINDOW_MS), policy, opts.catalogs);
  const evidence = rows.filter((r) => r.attempt === "start-turn" && r.at >= from && r.at <= now && EVIDENCE_ACTIONS.has(r.action));
  const labels = new Map<string, string>();
  for (const r of rows) if (r.routed_model && r.routed_label) labels.set(r.routed_model, r.routed_label);
  for (const cat of Object.values(opts.catalogs)) for (const m of cat ?? []) labels.set(m.id, m.displayName || m.id);
  const label = (g: GearKey) => `${labels.get(g.model) ?? g.model}${formatEffort(g.effort) ? ` · ${formatEffort(g.effort)}` : ""}`;

  const classes: ClassCalibration[] = [];
  const proposals: Proposal[] = [];
  const weak: Weak[] = [];
  const uncalibrated: Calibration["uncalibrated"] = [];
  let withOutcome = 0;

  const providers = [...new Set(evidence.map((r) => r.provider_id))].sort();
  for (const providerId of providers) {
    const catalog = opts.catalogs[providerId];
    if (!catalog || catalog.length === 0) { uncalibrated.push({ providerId, reason: "no model catalog" }); continue; }
    const ladder = ladderFor(policy, providerId);
    // Tiers bottom-up, so a tier is never proposed below the (possibly just lowered) gear of the tier beneath it.
    let below: GearKey | null = null;
    for (const tier of TIERS) {
      const resolved = resolveGear(ladder[tier], catalog);
      const current = resolved ? { model: resolved.model, effort: resolved.effort, label: label(resolved) } : null;
      const classRows = evidence.filter((r) => r.provider_id === providerId && (isTier(r.scored_tier) ? r.scored_tier : r.tier) === tier);
      const acc = new Map<string, GearOutcome & { cost: number; priced: number }>();
      let unknown = 0;
      for (const r of classRows) {
        const v = verdicts.get(r.id) ?? "unknown";
        const g = gearOf(r);
        if (v === "unknown" || !g) { unknown++; continue; }
        withOutcome++;
        const k = keyOf(g);
        const e = acc.get(k) ?? { ...g, label: label(g), n: 0, good: 0, retried: 0, corrected: 0, successRate: 0, lowerBound: 0, avgCostUsd: null, lower: false, current: false, cost: 0, priced: 0 };
        e.n++;
        if (v === "good") e.good++; else e[v]++;
        if (r.cost_usd !== null) { e.cost += r.cost_usd; e.priced++; }
        acc.set(k, e);
      }
      const gears: GearOutcome[] = [...acc.values()].map(({ cost, priced, ...g }) => ({
        ...g, successRate: round(g.good / g.n), lowerBound: round(wilsonLower(g.good, g.n)), avgCostUsd: priced ? round(cost / priced, 4) : null,
        current: !!current && keyOf(g) === keyOf(current), lower: !!current && isDownshift(g, current, policy, catalog),
      })).sort((a, b) => b.n - a.n);
      const cur = gears.find((g) => g.current) ?? null;
      const cls: ClassCalibration = { providerId, tier, current, turns: classRows.length, unknown, gears, proposal: null, note: null };
      classes.push(cls);
      if (cur && cur.n >= minSamples && cur.successRate < WEAK_SUCCESS) weak.push({ providerId, tier, gear: cur.label, n: cur.n, successRate: cur.successRate });
      if (!current) { cls.note = "the ladder gear does not resolve on this provider"; below = null; continue; }

      const floorEffort = tier === "large" || tier === "xlarge" ? effortRank(MIN_EFFORT_LARGE) : -1;
      const candidates = gears.filter((g) => g.lower && g.n >= minSamples && g.lowerBound >= SUCCESS_FLOOR
        && (!cur || cur.n < minSamples || g.successRate >= cur.successRate - MAX_SUCCESS_DROP)
        && effortRank(g.effort) >= floorEffort
        && (!below || notBelow(g, below, policy, catalog)));
      if (candidates.length === 0) {
        cls.note = !gears.some((g) => g.lower) ? "no cheaper gear has run on this class yet"
          : !gears.some((g) => g.lower && g.n >= minSamples) ? `cheaper gears have fewer than ${minSamples} turns with outcomes`
          : "cheaper gears did not keep good enough outcomes";
        below = current;
        continue;
      }
      // Cheapest first: model price/class, then effort, then the better outcome.
      candidates.sort((a, b) => compareModel(a.model, b.model, policy, catalog) || effortRank(a.effort) - effortRank(b.effort) || b.lowerBound - a.lowerBound);
      const pick = candidates[0]!;
      const sets: Proposal["sets"] = [];
      if (pick.model !== current.model) sets.push({ path: `gears.${providerId}.${tier}.model`, value: pick.model });
      if ((pick.effort ?? null) !== (current.effort ?? null)) {
        if (pick.effort) sets.push({ path: `gears.${providerId}.${tier}.effort`, value: pick.effort });
      }
      if (sets.length === 0) { cls.note = "no change"; below = current; continue; }
      const proposal: Proposal = {
        providerId, tier, from: current, to: { model: pick.model, effort: pick.effort, label: pick.label }, sets,
        evidence: { n: pick.n, successRate: pick.successRate, lowerBound: pick.lowerBound, currentN: cur?.n ?? 0, currentSuccessRate: cur?.successRate ?? null },
      };
      cls.proposal = proposal;
      proposals.push(proposal);
      below = { model: pick.model, effort: pick.effort };
    }
  }
  return {
    period: { days: opts.days, from: new Date(from).toISOString(), to: new Date(now).toISOString() },
    minSamples, rows: evidence.length, withOutcome, classes, proposals, weak, uncalibrated,
  };
}

const pct = (x: number) => `${Math.round(x * 100)}%`;

export function formatCalibration(c: Calibration, applied = false): string {
  const lines: string[] = [];
  lines.push(`Gearshift calibration, last ${c.period.days} days: ${c.rows} routed turns, ${c.withOutcome} with outcomes (min ${c.minSamples} per gear).`);
  lines.push("A turn is bad when the same message was re-sent, or a heavier gear was hand-picked right after it. Downshift only.");
  for (const u of c.uncalibrated) lines.push(`  ${u.providerId}: not calibrated (${u.reason})`);
  for (const cls of c.classes) {
    if (cls.turns === 0) continue;
    lines.push("");
    lines.push(`${cls.providerId} · ${formatTier(cls.tier)}: ${cls.turns} turns${cls.unknown ? ` (${cls.unknown} without outcome)` : ""}, ladder gear ${cls.current?.label ?? "?"}`);
    for (const g of cls.gears) {
      const tag = g.current ? " (current)" : g.lower ? " (cheaper)" : "";
      lines.push(`  ${g.label}${tag}: ${g.n} turns, ${pct(g.successRate)} good (≥${pct(g.lowerBound)} at 95%)${g.retried ? `, ${g.retried} retried` : ""}${g.corrected ? `, ${g.corrected} corrected` : ""}`);
    }
    lines.push(cls.proposal ? `  → ${cls.proposal.from.label} → ${cls.proposal.to.label}` : `  → keep (${cls.note})`);
  }
  lines.push("");
  if (c.proposals.length === 0) lines.push("No routing change.");
  else {
    lines.push(applied ? `Applied ${c.proposals.length} downshift(s):` : `Proposed ${c.proposals.length} downshift(s). Check with replay, then apply with --apply:`);
    const sets = c.proposals.flatMap((p) => p.sets);
    for (const p of c.proposals) lines.push(`  ${p.providerId} · ${formatTier(p.tier)}: ${p.from.label} → ${p.to.label}`);
    if (!applied) lines.push(`  bb gearshift replay ${sets.map((s) => `--set ${s.path}=${s.value}`).join(" ")}`);
  }
  for (const w of c.weak) lines.push(`Possibly too small (not changed): ${w.providerId} · ${formatTier(w.tier)} on ${w.gear}, ${pct(w.successRate)} good over ${w.n} turns.`);
  return lines.join("\n");
}
