import type { OverviewDto } from "@/lib/contract";
import { cn } from "@/lib/utils";
import { formatPercent, formatTier, formatTokens, formatUsd } from "../format";
import { Muted, SectionCard } from "./badges";

const TIERS = ["trivial", "small", "medium", "large", "xlarge"] as const;

/** Horizontal bars, one per tier, in ladder order. */
export function TierDistribution({ data }: { data: OverviewDto }) {
  const rows = TIERS.map((tier) => ({
    tier,
    count: data.byTier.find((r) => r.tier === tier)?.count ?? 0,
  }));
  const total = rows.reduce((s, r) => s + r.count, 0);
  const max = Math.max(1, ...rows.map((r) => r.count));
  return (
    <SectionCard title="Tier distribution" caption="How big the classifier judged each message">
      {total === 0 ? (
        <Muted>No classified messages in this range.</Muted>
      ) : (
        <ul className="flex flex-col gap-2">
          {rows.map((r) => (
            <li key={r.tier} className="grid grid-cols-[4.5rem_1fr_6rem] items-center gap-2 text-xs">
              <span className="text-muted-foreground">{formatTier(r.tier)}</span>
              <div className="h-3 overflow-hidden rounded-r bg-muted">
                <div
                  className="h-full rounded-r bg-foreground"
                  style={{ width: `${(r.count / max) * 100}%` }}
                  role="img"
                  aria-label={`${formatTier(r.tier)}: ${r.count} messages`}
                />
              </div>
              <span className="text-right tabular-nums">
                {r.count.toLocaleString("en-US")}{" "}
                <span className="text-muted-foreground">{formatPercent(r.count, total)}</span>
              </span>
            </li>
          ))}
        </ul>
      )}
    </SectionCard>
  );
}

// Opacity steps of the foreground colour: one hue, dark to light, with a legend carrying the numbers.
const SHADES = ["bg-foreground", "bg-foreground/75", "bg-foreground/55", "bg-foreground/40", "bg-foreground/25", "bg-foreground/15"];

export function ModelMix({ data }: { data: OverviewDto }) {
  const sorted = [...data.byModel].sort((a, b) => b.count - a.count);
  const top = sorted.slice(0, SHADES.length - 1);
  const rest = sorted.slice(SHADES.length - 1);
  const items = [
    ...top.map((m) => ({ key: m.model, label: m.label, count: m.count, tokens: m.tokens, cost: m.costUsd })),
    ...(rest.length > 0
      ? [{
          key: "other",
          label: "Other",
          count: rest.reduce((s, m) => s + m.count, 0),
          tokens: rest.reduce((s, m) => s + m.tokens, 0),
          cost: rest.reduce((s, m) => s + (m.costUsd ?? 0), 0) as number | null,
        }]
      : []),
  ];
  const total = items.reduce((s, i) => s + i.count, 0);
  return (
    <SectionCard title="Model mix" caption="Which model messages were routed to">
      {total === 0 ? (
        <Muted>No routed messages in this range.</Muted>
      ) : (
        <>
          <div className="flex h-4 w-full gap-0.5 overflow-hidden rounded-md" role="img" aria-label="Share of messages by model">
            {items.map((i, idx) => (
              <div
                key={i.key}
                className={cn("h-full", SHADES[idx])}
                style={{ width: `${(i.count / total) * 100}%` }}
                title={`${i.label}: ${formatPercent(i.count, total)}`}
              />
            ))}
          </div>
          <ul className="mt-3 flex flex-col gap-1.5 text-xs">
            {items.map((i, idx) => (
              <li key={i.key} className="flex items-center gap-2">
                <span className={cn("size-2.5 shrink-0 rounded-sm border border-border", SHADES[idx])} aria-hidden="true" />
                <span className="min-w-0 flex-1 truncate">{i.label}</span>
                <span className="shrink-0 tabular-nums text-muted-foreground">
                  {i.count.toLocaleString("en-US")} · {formatPercent(i.count, total)} · {formatTokens(i.tokens)} tok
                  {i.cost !== null && i.cost > 0 ? ` · ${formatUsd(i.cost)}` : ""}
                </span>
              </li>
            ))}
          </ul>
        </>
      )}
    </SectionCard>
  );
}

export function Transitions({ data }: { data: OverviewDto }) {
  const rows = [...data.transitions].sort((a, b) => b.count - a.count).slice(0, 8);
  return (
    <SectionCard title="Model transitions" caption="Requested model → routed model, shifts only">
      {rows.length === 0 ? (
        <Muted>No shifts yet.</Muted>
      ) : (
        <ul className="flex flex-col divide-y divide-border text-xs">
          {rows.map((r) => (
            <li key={`${r.from}>${r.to}`} className="flex items-center gap-2 py-1.5">
              <span className="min-w-0 flex-1 truncate">
                {r.from} <span className="text-muted-foreground">→</span> {r.to}
              </span>
              <span className="shrink-0 tabular-nums text-muted-foreground">{r.count.toLocaleString("en-US")}</span>
            </li>
          ))}
        </ul>
      )}
    </SectionCard>
  );
}
