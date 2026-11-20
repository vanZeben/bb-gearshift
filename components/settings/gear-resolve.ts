// Client-side approximation of how the server resolves a gear spec against a provider's models.
// Only used for the "Resolves to" column; routing itself always resolves on the server.

export interface ModelInfo {
  id: string;
  label: string;
  isDefault: boolean;
  efforts: string[];
  serviceTiers: string[];
  sizeClass: "small" | "medium" | "large";
}

const FALLBACK: Record<ModelInfo["sizeClass"], ModelInfo["sizeClass"][]> = {
  small: ["small", "medium", "large"],
  medium: ["medium", "large", "small"],
  large: ["large", "medium", "small"],
};

export function resolveModelClient(spec: string, models: readonly ModelInfo[]): ModelInfo | null {
  const want = spec.trim();
  if (want === "" || models.length === 0) return null;
  const exact = models.find((m) => m.id === want);
  if (exact) return exact;
  if (want === "@default") return models.find((m) => m.isDefault) ?? models[0] ?? null;
  if (want === "@small" || want === "@medium" || want === "@large") {
    const wanted = want.slice(1) as ModelInfo["sizeClass"];
    for (const cls of FALLBACK[wanted]) {
      const members = models.filter((m) => m.sizeClass === cls);
      if (members.length === 0) continue;
      return (cls === "medium" ? members.find((m) => m.isDefault) : undefined) ?? members[0] ?? null;
    }
    return models[0] ?? null;
  }
  const word = want.toLowerCase();
  return models.find((m) => `${m.id} ${m.label}`.toLowerCase().includes(word)) ?? null;
}

const EFFORTS = ["none", "low", "medium", "high", "xhigh", "max"];

/** Describe where a spec lands: `Sonnet 5.5 · high`, or why it does not resolve. */
export function describeResolution(
  spec: { model: string; effort?: string; serviceTier?: string },
  models: readonly ModelInfo[] | null,
): string {
  if (models === null) return "Models unavailable";
  if (models.length === 0) return "No models listed";
  const model = resolveModelClient(spec.model, models);
  if (!model) return "No matching model";
  const parts = [model.label || model.id];
  if (spec.effort && model.efforts.length > 0) {
    parts.push(clampClient(spec.effort, model.efforts));
  }
  if (spec.serviceTier && model.serviceTiers.includes(spec.serviceTier)) parts.push(spec.serviceTier);
  return parts.join(" · ");
}

function clampClient(effort: string, supported: readonly string[]): string {
  if (supported.includes(effort)) return effort;
  const target = EFFORTS.indexOf(effort);
  if (target < 0) return supported[0] ?? effort;
  let best = supported[0] ?? effort;
  let bestDistance = Infinity;
  for (const candidate of supported) {
    const idx = EFFORTS.indexOf(candidate);
    if (idx < 0) continue;
    const d = Math.abs(idx - target);
    if (d < bestDistance || (d === bestDistance && idx < target)) {
      best = candidate;
      bestDistance = d;
    }
  }
  return best;
}

export const STANDARD_EFFORTS = ["low", "medium", "high", "xhigh"];
