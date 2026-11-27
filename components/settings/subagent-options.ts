// Pure helpers for the "Sub-agents on another provider" section of the settings editor.
import type { ProvidersDto } from "@/lib/contract";

export interface ProviderOption { value: string; label: string; disabled: boolean }

export const SAME_AS_LEAD = "Same as lead";

/**
 * The provider select's options: "Same as lead" first, then each enabled provider by display name.
 * A provider whose catalog failed stays selectable, labelled "(models unavailable)": the setting is still valid and
 * the server reports whether it can be used. A saved id that is not listed (removed or disabled since) stays visible
 * and disabled, so the select shows what is stored instead of silently changing it. While the list is still loading
 * (`providers` is null) a saved id shows as just the id, because "not available" would be a guess.
 */
export function providerOptions(providers: ProvidersDto["providers"] | null, current: string): ProviderOption[] {
  const out: ProviderOption[] = [{ value: "", label: SAME_AS_LEAD, disabled: false }];
  for (const p of providers ?? []) out.push({ value: p.id, label: p.error ? `${p.displayName || p.id} (models unavailable)` : p.displayName || p.id, disabled: false });
  if (current && !(providers ?? []).some((p) => p.id === current)) {
    out.push({ value: current, label: providers === null ? current : `${current} (not available)`, disabled: providers !== null });
  }
  return out;
}

export const TIER_OPTIONS = [
  { value: "small-medium", label: "Small and medium tiers" },
  { value: "all", label: "All tiers" },
] as const;

/** Whole tokens from the number field's text: empty means no cap, anything else must be a whole number of 0 or more. */
export function parseCapInput(text: string): { value: number } | { error: string } {
  const t = text.trim();
  if (t === "") return { value: 0 };
  const n = Number(t);
  if (!Number.isInteger(n) || n < 0) return { error: "Enter a whole number of tokens, 0 or more (0 = no cap)." };
  return { value: n };
}
