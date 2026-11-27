// Run the implement, qa and verify sub-agents on another provider than the lead. Pure, no I/O.
//
// The result is a new policy, never a change to the one passed in. It adds one derived role per affected role
// (`implement-sub`, ...) that runs on the chosen provider's default model, and points the selected tiers' teams at
// it. Roles are shared by every tier, so a derived role is the only way to move some tiers and leave the others.
import { TIERS, type Policy, type RoleGearSpec, type RoleSpec, type Tier } from "./policy";

/** The roles that move to the sub-agent provider. Review, architecture, research and explore stay with the lead's provider. */
export const SUBAGENT_ROLES = ["implement", "qa", "verify"] as const;
export const SUBAGENT_ROLE_SUFFIX = "-sub";
export const SUBAGENT_TIER_CHOICES = ["small-medium", "all"] as const;
export type SubagentTiers = (typeof SUBAGENT_TIER_CHOICES)[number];

/** The three plugin settings. All optional: anything missing or malformed means "off". */
export interface SubagentSettings {
  subagentProvider?: string;
  subagentTiers?: string;
  subagentBudgetCap?: number;
}

const TIERS_FOR: Record<SubagentTiers, readonly Tier[]> = { "small-medium": ["small", "medium"], all: TIERS };

/** The derived role's name for a base role. */
export const subagentRoleName = (role: string) => `${role}${SUBAGENT_ROLE_SUFFIX}`;

/**
 * The role `gearshift_spawn` should try for a requested name. A base role whose derived `-sub` copy is in the
 * team maps to the copy, so an agent that asks for `qa` still gets the moved role. Any other name is unchanged.
 *
 * @param editable The policy without the derived roles: a `-sub` role defined there belongs to the user.
 */
export function spawnRoleName(requested: string, allowed: readonly string[], editable: Policy): string {
  const sub = subagentRoleName(requested);
  return allowed.includes(sub) && !editable.roles[sub] && editable.roles[requested] ? sub : requested;
}

/** The base role a derived `-sub` role was copied from, or null for any other name (including a `-sub` role the user defined). */
export function fallbackRoleName(role: string, editable: Policy): string | null {
  if (!role.endsWith(SUBAGENT_ROLE_SUFFIX) || editable.roles[role]) return null;
  const base = role.slice(0, -SUBAGENT_ROLE_SUFFIX.length);
  return editable.roles[base] ? base : null;
}

/** The tiers a setting value selects. An unknown value selects the default (small and medium). */
export const tiersFor = (value: string | undefined): readonly Tier[] => TIERS_FOR[value as SubagentTiers] ?? TIERS_FOR["small-medium"];

/** The cap as a whole number of tokens, or null when there is none (zero, negative, NaN or not a number). */
const capOf = (v: number | undefined): number | null => (typeof v === "number" && Number.isFinite(v) && v >= 1 ? Math.floor(v) : null);

/**
 * Apply the sub-agent provider settings to a built policy.
 *
 * Returns the same object, untouched, whenever the feature is off or cannot work, so the default settings
 * leave the policy byte-for-byte as it was. That covers an empty provider, a provider that is not in
 * `installed` (when the list is known), and a policy with nothing to move.
 *
 * The budget cap clamps only the derived roles, never the roles the lead's provider keeps.
 *
 * @param installed Ids of the providers that are set up. Omit or pass null when unknown: the setting is trusted then.
 */
export function applySubagentProvider(policy: Policy, settings: SubagentSettings, installed?: readonly string[] | null): Policy {
  const providerId = typeof settings.subagentProvider === "string" ? settings.subagentProvider.trim() : "";
  if (!providerId) return policy;
  if (installed && !installed.includes(providerId)) return policy;

  const cap = capOf(settings.subagentBudgetCap);
  const tiers = tiersFor(settings.subagentTiers);
  const moved = new Set<string>();
  for (const tier of tiers) for (const r of policy.teams[tier].roles) if ((SUBAGENT_ROLES as readonly string[]).includes(r) && policy.roles[r]) moved.add(r);
  // A role the user already defined under the derived name stays theirs: leave that role where it is.
  for (const r of [...moved]) if (policy.roles[subagentRoleName(r)]) moved.delete(r);
  if (moved.size === 0) return policy;

  const roles: Record<string, RoleSpec> = { ...policy.roles };
  for (const r of moved) roles[subagentRoleName(r)] = derivedRole(policy.roles[r]!, providerId, cap);

  const teams = { ...policy.teams };
  for (const tier of tiers) {
    const team = policy.teams[tier];
    if (!team.roles.some((r) => moved.has(r))) continue;
    teams[tier] = { ...team, roles: team.roles.map((r) => (moved.has(r) ? subagentRoleName(r) : r)) };
  }
  return { ...policy, roles, teams };
}

/** A copy of the role that runs on the provider's default model, keeping its effort, with every tier's budget clamped to the cap. */
function derivedRole(role: RoleSpec, providerId: string, cap: number | null): RoleSpec {
  const base = role.gears["*"] ?? Object.values(role.gears)[0]!;
  const { serviceTier: _drop, ...keep } = base; // a service tier names the lead provider's plans: let the new model decide
  const spec: RoleGearSpec = { ...keep, model: "@default", providerId };
  const budget = Object.fromEntries(TIERS.map((t) => [t, cap === null ? role.budget[t] : Math.min(role.budget[t], cap)])) as Record<Tier, number>;
  return { gears: { "*": spec }, budget };
}
