/** Display labels for tiers, efforts and gears. Pure and SDK-free: the router and the app both use them. */

export function formatEffort(effort: string | null | undefined): string | null {
  if (effort === null || effort === undefined || effort === "") return null;
  if (effort === "xhigh") return "XHigh";
  return effort.charAt(0).toUpperCase() + effort.slice(1);
}

/** "Sonnet 5.5 · High", or just the label when there is no effort. */
export function formatGear(
  label: string | null | undefined,
  effort: string | null | undefined,
): string | null {
  if (label === null || label === undefined || label === "") return null;
  const e = formatEffort(effort);
  return e === null ? label : `${label} · ${e}`;
}

export function formatTier(tier: string | null | undefined): string {
  if (tier === null || tier === undefined) return "n/a";
  return tier === "xlarge" ? "X-large" : tier.charAt(0).toUpperCase() + tier.slice(1);
}
