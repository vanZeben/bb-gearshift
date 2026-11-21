/** Pure formatting helpers shared by the pill, popup and analytics page. */

export { formatEffort, formatGear, formatTier } from "../lib/labels";

export function formatUsd(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "n/a";
  const abs = Math.abs(value);
  const sign = value < 0 ? "-" : "";
  if (abs === 0) return "$0.00";
  if (abs < 0.01) return `${sign}<$0.01`;
  if (abs < 100) return `${sign}$${abs.toFixed(2)}`;
  return `${sign}$${Math.round(abs).toLocaleString("en-US")}`;
}

export function formatTokens(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "n/a";
  if (value < 1000) return String(Math.round(value));
  if (value < 1_000_000) {
    const k = value / 1000;
    return `${k < 10 ? k.toFixed(1) : Math.round(k)}k`;
  }
  return `${(value / 1_000_000).toFixed(1)}M`;
}

export function formatPercent(part: number, whole: number): string {
  if (whole <= 0) return "0%";
  const pct = (part / whole) * 100;
  return `${pct < 10 && pct > 0 ? pct.toFixed(1) : Math.round(pct)}%`;
}

export function formatMs(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "n/a";
  if (value >= 1000) return `${(value / 1000).toFixed(1)} s`;
  return `${Math.round(value)} ms`;
}

export function formatRelativeTime(at: number, now: number = Date.now()): string {
  const diff = Math.max(0, now - at);
  const s = Math.floor(diff / 1000);
  if (s < 45) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} h ago`;
  const d = Math.round(h / 24);
  if (d < 30) return `${d} d ago`;
  return new Date(at).toLocaleDateString();
}

export function formatClock(at: number): string {
  return new Date(at).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

/** "2026-11-20" -> "Nov 20" without time zone drift. */
export function formatDay(day: string): string {
  const [y, m, d] = day.split("-").map(Number);
  if (!y || !m || !d) return day;
  return new Date(y, m - 1, d).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });
}

export function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, Math.max(0, max - 1))}…`;
}

/** Drops a trailing date stamp from a model id. */
export function shortModel(model: string | null | undefined): string {
  if (model === null || model === undefined || model === "") return "n/a";
  return truncate(model.replace(/-\d{8}$/, ""), 28);
}

export interface ContributionLike {
  label: string;
  kind: "floor" | "add" | "base" | "bonus";
  value: number;
}

/** One contribution as short text: `large build +9 floor`, `3 areas +4`, `question 1`. */
export function formatContribution(c: ContributionLike): string {
  if (c.kind === "base") return `${c.label} ${c.value}`;
  const sign = c.value < 0 ? "" : "+";
  return `${c.label} ${sign}${c.value}${c.kind === "floor" ? " floor" : ""}`;
}

/** The "why" line: `large build +9 floor · 3 areas +4 · over 500 chars +1`. */
export function formatContributions(list: readonly ContributionLike[] | null | undefined): string {
  return (list ?? []).map(formatContribution).join(" · ");
}
