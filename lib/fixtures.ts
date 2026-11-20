// Test fixtures: catalogs shaped like real providers, and a compiled default policy.
import type { CatalogModel } from "./gears";
import { DEFAULT_POLICY, compilePolicy, mergePolicy, type PolicyOverrides } from "./policy";

export const compiledDefault = compilePolicy(DEFAULT_POLICY);
export const compiledWith = (overrides: PolicyOverrides) => compilePolicy(mergePolicy(DEFAULT_POLICY, overrides));

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
