// Gears: which model and effort each tier runs on, per provider.
//
// A ladder maps the five tiers to a gear spec. A spec names a model loosely (an exact
// id, a family word like "sonnet", or a size class like "@small") so one ladder keeps
// working as providers ship new versions: the spec is resolved against the provider's
// live model catalog at routing time, newest first.

import { TIERS, type GearSpec, type Tier } from "./policy";

export type { GearSpec };

export interface CatalogModel {
  id: string;
  displayName: string;
  isDefault: boolean;
  /** Reasoning levels the model accepts, in the provider's order. Empty: none to set. */
  efforts: string[];
  defaultEffort: string | null;
  /** Service tiers the model lists (supportedServiceTiers ids). */
  serviceTiers: string[];
}

export type Ladder = Record<Tier, GearSpec>;

export interface Gear {
  model: string;
  label: string;
  /** Null when the model takes no reasoning level (keep whatever was requested). */
  effort: string | null;
  /** Null: keep the composer's. Set only when the resolved model lists it. */
  serviceTier: string | null;
}

/** Reasoning levels from least to most thinking. */
export const EFFORT_ORDER = ["none", "low", "medium", "high", "xhigh", "max"] as const;

export type SizeClass = "small" | "medium" | "large";

const SMALL_WORDS = /(?:^|[^a-z])(?:haiku|mini|nano|flash|lite|small|tiny|spark|instant|8b|7b|3b)(?:$|[^a-z])/i;
const LARGE_WORDS = /(?:^|[^a-z])(?:opus|fable|mythos|ultra|large|pro|max|xl|405b|70b)(?:$|[^a-z])/i;

export function sizeClass(model: Pick<CatalogModel, "id" | "displayName">): SizeClass {
  const name = `${model.id} ${model.displayName}`;
  if (SMALL_WORDS.test(name)) return "small";
  if (LARGE_WORDS.test(name)) return "large";
  return "medium";
}

const CLASS_FALLBACK: Record<SizeClass, SizeClass[]> = {
  small: ["small", "medium", "large"],
  medium: ["medium", "large", "small"],
  large: ["large", "medium", "small"],
};

function pickClass(catalog: CatalogModel[], wanted: SizeClass): CatalogModel | null {
  for (const cls of CLASS_FALLBACK[wanted]) {
    const members = catalog.filter((m) => sizeClass(m) === cls);
    if (members.length === 0) continue;
    // The provider's default is the best "medium"; elsewhere the catalog's own order (newest first) wins.
    if (cls === "medium") return members.find((m) => m.isDefault) ?? members[0]!;
    return members[0]!;
  }
  return catalog[0] ?? null;
}

/** Resolve a loose model spec against a catalog. Null when nothing fits. */
export function resolveModel(spec: string, catalog: CatalogModel[]): CatalogModel | null {
  const want = spec.trim();
  if (want === "" || catalog.length === 0) return null;
  const exact = catalog.find((m) => m.id === want);
  if (exact) return exact;
  if (want === "@default") return catalog.find((m) => m.isDefault) ?? catalog[0]!;
  if (want === "@small" || want === "@medium" || want === "@large") return pickClass(catalog, want.slice(1) as SizeClass);
  const word = want.toLowerCase();
  // Family word: the first (newest) catalog entry that names it. "gpt-5" must not pick "gpt-5-mini"
  // when a plain "gpt-5" variant exists, so prefer entries where the word is not followed by a size word.
  const named = catalog.filter((m) => `${m.id} ${m.displayName}`.toLowerCase().includes(word));
  if (named.length === 0) return null;
  if (!SMALL_WORDS.test(word)) {
    const plain = named.find((m) => sizeClass(m) !== "small" || SMALL_WORDS.test(word));
    if (plain) return plain;
  }
  return named[0]!;
}

/** The closest reasoning level the model accepts; ties go to the lower level. Null when it takes none. */
export function clampEffort(effort: string | undefined | null, model: CatalogModel): string | null {
  if (!effort || model.efforts.length === 0) return null;
  if (model.efforts.includes(effort)) return effort;
  const target = EFFORT_ORDER.indexOf(effort as (typeof EFFORT_ORDER)[number]);
  if (target < 0) return model.defaultEffort;
  let best: string | null = null;
  let bestDistance = Infinity;
  for (const candidate of model.efforts) {
    const idx = EFFORT_ORDER.indexOf(candidate as (typeof EFFORT_ORDER)[number]);
    if (idx < 0) continue; // provider-specific levels ("ultracode") are never picked implicitly
    const distance = Math.abs(idx - target);
    if (distance < bestDistance || (distance === bestDistance && idx < target)) {
      best = candidate;
      bestDistance = distance;
    }
  }
  return best ?? model.defaultEffort;
}

export function resolveGear(spec: GearSpec, catalog: CatalogModel[]): Gear | null {
  const model = resolveModel(spec.model, catalog);
  if (!model) return null;
  const serviceTier = spec.serviceTier && model.serviceTiers.includes(spec.serviceTier) ? spec.serviceTier : null;
  return { model: model.id, label: model.displayName || model.id, effort: clampEffort(spec.effort, model), serviceTier };
}

export function effortRank(effort: string | null | undefined): number {
  const idx = EFFORT_ORDER.indexOf((effort ?? "") as (typeof EFFORT_ORDER)[number]);
  return idx < 0 ? 2 : idx;
}

/**
 * How "high" a gear sits, for deciding whether a change is a downshift. The model's place
 * on the ladder dominates; effort breaks ties within one model.
 */
export function gearWeight(model: string, effort: string | null | undefined, ladder: Ladder, catalog: CatalogModel[]): number {
  let modelRank = -1;
  TIERS.forEach((tier, idx) => {
    if (modelRank >= 0) return;
    const resolved = resolveModel(ladder[tier].model, catalog);
    if (resolved?.id === model) modelRank = idx;
  });
  if (modelRank < 0) {
    const entry = catalog.find((m) => m.id === model);
    const cls = entry ? sizeClass(entry) : sizeClass({ id: model, displayName: "" });
    modelRank = cls === "small" ? 0 : cls === "medium" ? 2 : 3;
  }
  return modelRank * 10 + effortRank(effort);
}

/** Normalise the SDK's model list into the shape the router needs. */
export function toCatalog(models: ReadonlyArray<{ id: string; displayName?: string; isDefault?: boolean; defaultReasoningEffort?: string; supportedReasoningEfforts?: ReadonlyArray<{ reasoningEffort: string }>; supportedServiceTiers?: ReadonlyArray<{ id: string }> }>): CatalogModel[] {
  return models.map((m) => ({
    id: m.id,
    displayName: m.displayName ?? m.id,
    isDefault: Boolean(m.isDefault),
    efforts: (m.supportedReasoningEfforts ?? []).map((e) => e.reasoningEffort),
    defaultEffort: m.defaultReasoningEffort ?? null,
    serviceTiers: (m.supportedServiceTiers ?? []).map((t) => t.id),
  }));
}
