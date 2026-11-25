// Test fixtures: catalogs shaped like real providers, and a compiled default policy.
import type { CatalogModel } from "./gears";
import { DEFAULT_POLICY, compilePolicy, mergePolicy, type PolicyOverrides } from "./policy";
import type { GearSpec, Tier } from "./policy";

export const compiledDefault = compilePolicy(DEFAULT_POLICY);
export const compiledWith = (overrides: PolicyOverrides) => compilePolicy(mergePolicy(DEFAULT_POLICY, overrides));

/**
 * The pre-0.5 tiered default ladder (cheaper models on the lower tiers). The default now keeps the lead on
 * the capable model at every tier, so tests of mechanisms that need a different model per tier (holds, the
 * downshift price check, replay re-tiering, the review's lower-gear suggestions, gear weights) use this.
 */
export const TIERED_GEARS: Record<string, Record<Tier, GearSpec>> = {
  "*": {
    trivial: { model: "@small", effort: "low" },
    small: { model: "@small", effort: "medium" },
    medium: { model: "@medium", effort: "medium" },
    large: { model: "@large", effort: "high" },
    xlarge: { model: "@large", effort: "xhigh" },
  },
  "claude-code": {
    trivial: { model: "haiku", effort: "low" },
    small: { model: "sonnet", effort: "medium" },
    medium: { model: "sonnet", effort: "high" },
    large: { model: "opus", effort: "high" },
    xlarge: { model: "opus", effort: "xhigh" },
  },
  codex: {
    trivial: { model: "@small", effort: "low" },
    small: { model: "@small", effort: "medium" },
    medium: { model: "@default", effort: "medium" },
    large: { model: "@default", effort: "high" },
    xlarge: { model: "@default", effort: "xhigh" },
  },
};
/** The default policy with {@link TIERED_GEARS} swapped in: the pre-0.5 tiered ladder, for mechanism tests. */
export const compiledTiered = compiledWith({ gears: TIERED_GEARS });

const full = ["low", "medium", "high", "xhigh"];
const m = (id: string, displayName: string, o: Partial<CatalogModel> = {}): CatalogModel => ({
  id, displayName, isDefault: false, efforts: full, defaultEffort: "medium", serviceTiers: [], ...o,
});

/** Newest first, like a live catalog. */
export const CLAUDE_CATALOG: CatalogModel[] = [
  m("claude-opus-5-5", "Opus 5.5", { isDefault: true, efforts: [...full, "ultracode"], serviceTiers: ["fast"] }),
  m("claude-fable-5-2", "Fable 5.2"),
  m("claude-sonnet-5-5", "Sonnet 5.5"),
  m("claude-haiku-5-5", "Haiku 5.5"),
  m("claude-haiku-4-5-20251001", "Haiku 4.5", { efforts: ["low"], defaultEffort: "low" }),
];

export const CODEX_CATALOG: CatalogModel[] = [
  m("gpt-6", "GPT-6", { isDefault: true }),
  m("gpt-6-mini", "GPT-6 mini"),
  m("gpt-5", "GPT-5"),
];

export const GENERIC_CATALOG: CatalogModel[] = [
  m("acme-ultra-2", "Acme Ultra 2"),
  m("acme-core-2", "Acme Core 2", { isDefault: true }),
  m("acme-flash-2", "Acme Flash 2"),
];
