// Pure routing decision: first matching rule of docs/DESIGN.md wins. No I/O.
import { classify, tierIndex, type Classification, type Confidence } from "./classify";
import { clampEffort, effortRank, gearWeight, resolveGear, resolveModel, type CatalogModel, type Gear } from "./gears";
import { formatEffort, formatGear, formatTier } from "./labels";
import { TIERS, ladderFor, type CompiledPolicy, type Policy, type Tier } from "./policy";
import { priceFor, ratesAt, tierMultiplier } from "./pricing";

export type Action = "shift" | "keep" | "hold" | "manual" | "skip" | "off";
/**
 * Why a long thread's gear was (or was not) carried into this message:
 * - `gear`: model and effort both kept (the message's tier wanted a lower gear);
 * - `effort`: model kept, effort lowered to the message's own tier;
 * - `continuation`: "go ahead" and friends keep the whole gear;
 * - `downshift`: the hold was waived because switching model costs less than holding it.
 */
export type HoldKind = "gear" | "effort" | "continuation" | "downshift";

/** Output tokens assumed for a trivial or small turn when pricing a model downshift under a hold. */
export const DOWNSHIFT_OUTPUT_TOKENS = 2_000;
/** Tiers that may move to a cheaper model under a hold when the price check says so. */
export const DOWNSHIFT_TIERS: readonly Tier[] = ["trivial", "small"];
/** Large and x-large messages never run below this effort when a hold lowers it. */
export const HOLD_EFFORT_FLOOR = "medium";
const FLOOR_TIERS: readonly Tier[] = ["large", "xlarge"];

export interface CurrentGear { model: string; effort: string | null; serviceTier?: string | null }

export interface DecideInput {
  enabled: boolean;
  text: string;
  providerId: string;
  attempt: "start-turn" | "join-turn";
  initiator: "user" | "agent" | "system" | "mixed";
  requested: { model: string | null; effort: string | null; serviceTier?: string | null };
  modelSource: "explicit" | "client-preference" | null;
  current: CurrentGear | null;
  contextTokens: number | null;
  catalog: CatalogModel[] | null;
  policy: CompiledPolicy;
}

export interface Decision {
  action: Action;
  reason: string;
  classification: Classification;
  /** The tier the message was routed as: the scored tier, or one lower when the downshift bias applied. */
  tier: Tier | null;
  /** The tier the score alone gave, before the bias; equal to `tier` when nothing moved it. */
  scoredTier: Tier | null;
  gear: Gear | null;
  needsAmend: boolean;
  holdKind: HoldKind | null;
}

export function decide(input: DecideInput): Decision {
  const policy = input.policy.policy;
  const c = classify(input.text, input.policy);
  let scored: Tier | null = null;
  const done = (action: Action, reason: string, gear: Gear | null = null, tier: Tier | null = null, holdKind: HoldKind | null = null): Decision => {
    let g = gear;
    if (g && g.effort === null) g = { ...g, effort: input.requested.effort };
    if (g && g.serviceTier === null) g = { ...g, serviceTier: input.requested.serviceTier ?? null };
    const same = !!g && g.model === input.requested.model && (g.effort ?? null) === (input.requested.effort ?? null)
      && (g.serviceTier ?? null) === (input.requested.serviceTier ?? null);
    const needsAmend = !!g && (action === "shift" || action === "hold") && !same;
    return { action, reason, classification: c, tier, scoredTier: scored ?? tier, gear: g, needsAmend, holdKind };
  };
  const o = policy.routing;
  const cat = input.catalog;

  if (c.skip) return done("skip", "System message");
  if (!input.enabled) return done("off", "Gearshift is off for this thread");
  if (input.attempt === "join-turn") return done("skip", "Joins the running turn; the model can't change mid-turn");
  if (input.initiator === "system") return done("skip", "A retry keeps its original model");
  if (input.initiator === "agent" && !o.routeAgentMessages) return done("skip", "Agent messages are not routed");
  if (!cat || cat.length === 0) return done("skip", `Model list unavailable for ${input.providerId}`);

  if (c.requestedFamily) {
    const m = resolveModel(c.requestedFamily, cat);
    if (m) {
      const gear: Gear = { model: m.id, label: m.displayName || m.id, effort: clampEffort(input.requested.effort ?? undefined, m) ?? m.defaultEffort, serviceTier: null };
      return done(m.id === input.requested.model ? "keep" : "shift", `You asked for ${gear.label}`, gear, c.tier);
    }
  }
  if (input.modelSource === "explicit" && o.respectManualPicks) return done("manual", "Model picked by hand", null, c.tier);

  const cur = input.current;
  const curModel = cur ? cat.find((m) => m.id === cur.model) : undefined;
  const heldGear = (): Gear => ({ model: cur!.model, label: curModel?.displayName ?? cur!.model, effort: cur!.effort, serviceTier: cur!.serviceTier ?? null });
  if (c.continuation && cur) {
    const gear = heldGear();
    const same = gear.model === input.requested.model && (cur.effort ?? null) === (input.requested.effort ?? null) && (gear.serviceTier ?? null) === (input.requested.serviceTier ?? null);
    return done(same ? "keep" : "hold", `Continuing on ${gear.label}`, gear, c.tier, "continuation");
  }

  // Downshift bias: a borderline message runs one tier lower (the hold rule below then sees the lowered tier).
  const b = biasTier(c.tier, c.score, c.confidence, policy);
  scored = c.tier;
  const tier = b.tier;
  const r = routeTier({ tier, signals: c.signals, providerId: input.providerId, current: cur, contextTokens: input.contextTokens, catalog: cat, policy });
  if (!r) return done("skip", `No model for ${tier} on ${input.providerId}`, null, tier);
  if (b.biased) r.reason += ` (leaning lower: ${b.why})`;
  if (r.action === "hold") return done("hold", r.reason, r.gear, tier, r.holdKind);
  const g2 = { ...r.gear, effort: r.gear.effort ?? input.requested.effort, serviceTier: r.gear.serviceTier ?? input.requested.serviceTier ?? null };
  const same = g2.model === input.requested.model && (g2.effort ?? null) === (input.requested.effort ?? null) && (g2.serviceTier ?? null) === (input.requested.serviceTier ?? null);
  return done(same ? "keep" : "shift", r.reason, r.gear, tier, r.holdKind);
}

export interface BiasedTier { tier: Tier; biased: boolean; /** Why it leaned lower; empty when it did not. */ why: string }

/**
 * The downshift bias: with `routing.downshiftBias` on, a message that is not trivial runs one tier lower when
 * its score is the lowest point of its band or the classifier found no clear signal (low confidence). At most
 * one tier down, never up. Only the tier → gear path uses it (not explicit requests, manual picks, continuations).
 */
export function biasTier(tier: Tier, score: number | null, confidence: Confidence | string | null, policy: Policy): BiasedTier {
  const same: BiasedTier = { tier, biased: false, why: "" };
  const i = TIERS.indexOf(tier);
  if (!policy.routing.downshiftBias || i <= 0) return same;
  const lower = TIERS[i - 1]!;
  if (score !== null && score === policy.tiers[tier].min) return { tier: lower, biased: true, why: `score ${score} is the bottom of ${tier}` };
  if (confidence === "low") return { tier: lower, biased: true, why: "no clear signal" };
  return same;
}

export interface RouteTierInput {
  tier: Tier;
  signals: readonly string[];
  providerId: string;
  current: CurrentGear | null;
  contextTokens: number | null;
  catalog: CatalogModel[];
  policy: Policy;
}
export interface TierRoute { action: "shift" | "hold"; gear: Gear; reason: string; holdKind: HoldKind | null }

/**
 * The gear for a message of `tier` on a thread that is on `current`: the tier's gear, unless the
 * hold rule applies (docs/routing-policy.md "Why long threads hold"). Pure; `decide` and the
 * replay both use it. `shift` here means "run on this gear" (the caller turns it into `keep`
 * when the request already is that gear). Null when no model fits the tier.
 */
export function routeTier(i: RouteTierInput): TierRoute | null {
  const o = i.policy.routing;
  const ladder = ladderFor(i.policy, i.providerId);
  const gear = resolveGear(ladder[i.tier], i.catalog);
  if (!gear) return null;
  const signals = i.signals.length ? ` (${i.signals.join(", ")})` : "";
  const why = `${formatTier(i.tier)} task${signals} → ${formatGear(gear.label, gear.effort)}`;
  const cur = i.current;
  if (!cur || o.holdAboveTokens <= 0 || i.contextTokens === null || i.contextTokens < o.holdAboveTokens) return { action: "shift", gear, reason: why, holdKind: null };
  // Never upshift through a hold: a higher gear always wins.
  if (gearWeight(gear.model, gear.effort, ladder, i.catalog) >= gearWeight(cur.model, cur.effort, ladder, i.catalog)) return { action: "shift", gear, reason: why, holdKind: null };

  const k = `${Math.round(i.contextTokens / 1000)}k`;
  const curModel = i.catalog.find((m) => m.id === cur.model);
  const label = curModel?.displayName ?? cur.model;
  // A trivial or small message may leave the model when that is cheaper even counting the uncached re-read.
  if (gear.model !== cur.model && DOWNSHIFT_TIERS.includes(i.tier)
    && switchSaves(i.policy, cur, { model: gear.model, serviceTier: gear.serviceTier ?? cur.serviceTier ?? null }, i.contextTokens)) {
    return { action: "shift", gear, reason: `${why}: cheaper than holding ${label} even with the ${k}-token context re-read uncached`, holdKind: "downshift" };
  }
  const held: Gear = { model: cur.model, label, effort: cur.effort, serviceTier: cur.serviceTier ?? null };
  if (o.holdEffortFollowsMessage && curModel) {
    let want = clampEffort(ladder[i.tier].effort, curModel);
    if (want && FLOOR_TIERS.includes(i.tier) && effortRank(want) < effortRank(HOLD_EFFORT_FLOOR)) want = clampEffort(HOLD_EFFORT_FLOOR, curModel);
    if (want && cur.effort && effortRank(want) < effortRank(cur.effort)) {
      return {
        action: "hold", gear: { ...held, effort: want }, holdKind: "effort",
        reason: `Holding ${label}, effort ${formatEffort(cur.effort)} → ${formatEffort(want)} for a ${formatTier(i.tier).toLowerCase()} task: a ${k}-token context would be re-read uncached on another model`,
      };
    }
  }
  return { action: "hold", gear: held, reason: `Holding ${label}: a ${k}-token context would be re-read uncached`, holdKind: "gear" };
}

/**
 * True when one trivial/small turn on `to` costs less than on `from` for a thread of `contextTokens`:
 * staying reads the context from cache; moving writes it to the new model's cache. Both add
 * DOWNSHIFT_OUTPUT_TOKENS of output. False when either model has no price.
 */
export function switchSaves(policy: Pick<Policy, "prices" | "serviceTierMultipliers">, from: CurrentGear, to: { model: string; serviceTier: string | null }, contextTokens: number): boolean {
  const pf = priceFor(from.model, policy.prices), pt = priceFor(to.model, policy.prices);
  if (!pf || !pt) return false;
  const rf = ratesAt(pf, contextTokens), rt = ratesAt(pt, contextTokens);
  const stay = (contextTokens * rf.cacheRead + DOWNSHIFT_OUTPUT_TOKENS * rf.output) * tierMultiplier(policy, from.serviceTier);
  const move = (contextTokens * rt.cacheWrite + DOWNSHIFT_OUTPUT_TOKENS * rt.output) * tierMultiplier(policy, to.serviceTier);
  return move < stay;
}
export { tierIndex };
