// Pure routing decision: first matching rule of docs/DESIGN.md wins. No I/O.
import { classify, tierIndex, type Classification } from "./classify";
import { clampEffort, gearWeight, resolveGear, resolveModel, type CatalogModel, type Gear } from "./gears";
import { formatGear, formatTier } from "./labels";
import { ladderFor, type CompiledPolicy, type Tier } from "./policy";

export type Action = "shift" | "keep" | "hold" | "manual" | "skip" | "off";

export interface DecideInput {
  enabled: boolean;
  text: string;
  providerId: string;
  attempt: "start-turn" | "join-turn";
  initiator: "user" | "agent" | "system" | "mixed";
  requested: { model: string | null; effort: string | null; serviceTier?: string | null };
  modelSource: "explicit" | "client-preference" | null;
  current: { model: string; effort: string | null; serviceTier?: string | null } | null;
  contextTokens: number | null;
  catalog: CatalogModel[] | null;
  policy: CompiledPolicy;
}

export interface Decision {
  action: Action;
  reason: string;
  classification: Classification;
  tier: Tier | null;
  gear: Gear | null;
  needsAmend: boolean;
}

export function decide(input: DecideInput): Decision {
  const policy = input.policy.policy;
  const c = classify(input.text, input.policy);
  const done = (action: Action, reason: string, gear: Gear | null = null, tier: Tier | null = null): Decision => {
    let g = gear;
    if (g && g.effort === null) g = { ...g, effort: input.requested.effort };
    if (g && g.serviceTier === null) g = { ...g, serviceTier: input.requested.serviceTier ?? null };
    const same = !!g && g.model === input.requested.model && (g.effort ?? null) === (input.requested.effort ?? null)
      && (g.serviceTier ?? null) === (input.requested.serviceTier ?? null);
    const needsAmend = !!g && (action === "shift" || action === "hold") && !same;
    return { action, reason, classification: c, tier, gear: g, needsAmend };
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
    return done(same ? "keep" : "hold", `Continuing on ${gear.label}`, gear, c.tier);
  }

  const ladder = ladderFor(policy, input.providerId);
  const gear = resolveGear(ladder[c.tier], cat);
  if (!gear) return done("skip", `No model for ${c.tier} on ${input.providerId}`, null, c.tier);
  const signals = c.signals.length ? ` (${c.signals.join(", ")})` : "";
  const why = `${formatTier(c.tier)} task${signals} → ${formatGear(gear.label, gear.effort)}`;

  if (cur && o.holdAboveTokens > 0 && input.contextTokens !== null && input.contextTokens >= o.holdAboveTokens) {
    const target = gearWeight(gear.model, gear.effort, ladder, cat);
    const now = gearWeight(cur.model, cur.effort, ladder, cat);
    if (target < now) {
      return done("hold", `Holding ${heldGear().label}: a ${Math.round(input.contextTokens / 1000)}k-token context would be re-read uncached`, heldGear(), c.tier);
    }
  }
  const g2 = { ...gear, effort: gear.effort ?? input.requested.effort, serviceTier: gear.serviceTier ?? input.requested.serviceTier ?? null };
  const same = g2.model === input.requested.model && (g2.effort ?? null) === (input.requested.effort ?? null) && (g2.serviceTier ?? null) === (input.requested.serviceTier ?? null);
  return done(same ? "keep" : "shift", why, gear, c.tier);
}
export { tierIndex };
