// Teams and roles: which sub-agents a tier gets, what each runs on, and when its budget runs out. Pure, no I/O.
import { resolveGear, type CatalogModel, type Gear } from "./gears";
import type { Policy, RoleGearSpec, Tier } from "./policy";
import { TIERS } from "./policy";
import type { Usage } from "./pricing";

export const NUDGE_AT = 0.8;
export const STOP_AT = 1;
const AT_LEAST_MEDIUM = new Set<Tier>(["medium", "large", "xlarge"]);
export const noteWorthy = (tier: Tier | null): boolean => !!tier && AT_LEAST_MEDIUM.has(tier);
export const NOTE_PREFIX = "[gearshift]";

/** Spend tokens: input + cache writes + output + 0.1 x cache reads. */
export function spendTokens(u: Usage): number {
  return Math.round(u.inputTokens + u.cacheWriteTokens + u.outputTokens + 0.1 * u.cacheReadTokens);
}

export interface RoleTarget { role: string; providerId: string; spec: RoleGearSpec; effort: string | undefined; budget: number }

/** The role's gear spec for the parent's provider ("*" fallback), the provider it runs on, and its budget at the tier. Null for an unknown role. */
export function roleTarget(policy: Policy, role: string, parentProviderId: string, tier: Tier): RoleTarget | null {
  const r = policy.roles[role];
  if (!r) return null;
  const spec = r.gears[parentProviderId] ?? r.gears["*"];
  if (!spec) return null;
  const effort = AT_LEAST_MEDIUM.has(tier) && spec.effortMediumUp ? spec.effortMediumUp : spec.effort;
  return { role, providerId: spec.providerId ?? parentProviderId, spec, effort, budget: r.budget[tier] };
}

export interface ResolvedRole extends RoleTarget { gear: Gear | null }

export function resolveRole(policy: Policy, role: string, parentProviderId: string, tier: Tier, catalogs: ReadonlyMap<string, CatalogModel[]>): ResolvedRole | null {
  const t = roleTarget(policy, role, parentProviderId, tier);
  if (!t) return null;
  const cat = catalogs.get(t.providerId);
  const gear = cat ? resolveGear({ model: t.spec.model, effort: t.effort, serviceTier: t.spec.serviceTier }, cat) : null;
  return { ...t, gear };
}

/** Provider ids whose model catalogs are needed to resolve these roles. */
export function providersFor(policy: Policy, roles: readonly string[], parentProviderId: string, tier: Tier): string[] {
  const out = new Set<string>();
  for (const r of roles) { const t = roleTarget(policy, r, parentProviderId, tier); if (t) out.add(t.providerId); }
  return [...out];
}

const kfmt = (n: number) => (n >= 1_000_000 ? `${+(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${Math.round(n / 1000)}k` : String(n));
export const formatBudget = kfmt;
export const gearLabel = (g: Gear | null, fallback: string) => (g ? `${g.label}${g.effort ? ` · ${g.effort}` : ""}` : fallback);

/** The single agent-only line appended to a medium-or-larger message. */
export function formatRouteNote(a: { tier: Tier; score: number | null; policy: Policy; parentProviderId: string; catalogs: ReadonlyMap<string, CatalogModel[]> }): string {
  const team = a.policy.teams[a.tier];
  const roles = team.roles.map((name) => {
    const r = resolveRole(a.policy, name, a.parentProviderId, a.tier, a.catalogs);
    if (!r) return null;
    const where = r.providerId === a.parentProviderId ? "" : ` on ${r.providerId}`;
    return `${name} → ${gearLabel(r.gear, r.spec.model)}${where} (budget ${kfmt(r.budget)})`;
  }).filter((x): x is string => !!x);
  const parts = [`${NOTE_PREFIX} tier=${a.tier}`, `score=${a.score ?? "?"}`, `team: ${team.summary}`];
  if (roles.length) parts.push(`roles: ${roles.join(", ")}`);
  parts.push("spawn sub-agents with the gearshift_spawn tool");
  return parts.join(" · ");
}

export type GuardAction = "none" | "nudge" | "stop";
/** What the budget guard does at this spend. Thresholds are 80% (once) and 100%; a zero budget never triggers. */
export function guardAction(spent: number, budget: number, status: "running" | "nudged" | string): GuardAction {
  if (!(budget > 0)) return "none";
  const f = spent / budget;
  if (f >= STOP_AT && (status === "running" || status === "nudged")) return "stop";
  if (f >= NUDGE_AT && status === "running") return "nudge";
  return "none";
}

export const TIER_LIST = TIERS;
