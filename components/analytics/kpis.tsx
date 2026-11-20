import type { OverviewDto } from "@/lib/contract";
import { formatMs, formatPercent, formatUsd } from "../format";

function Tile({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="min-w-0 rounded-lg border border-border bg-card p-3">
      <div className="truncate text-xs text-muted-foreground">{label}</div>
      <div className="mt-1 truncate text-2xl font-semibold tabular-nums">{value}</div>
      {hint ? <div className="mt-0.5 truncate text-[11px] text-muted-foreground">{hint}</div> : null}
    </div>
  );
}

export function Kpis({ data }: { data: OverviewDto }) {
  const t = data.totals;
  const eligible = t.routed + t.manual; // messages Gearshift could have shifted
  return (
    <div className="grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-5">
      <Tile label="Messages routed" value={t.routed.toLocaleString("en-US")} hint={`of ${t.decisions.toLocaleString("en-US")} seen`} />
      <Tile label="Shift rate" value={formatPercent(t.shifted, t.routed)} hint={`${t.shifted.toLocaleString("en-US")} shifted · ${t.held.toLocaleString("en-US")} held`} />
      <Tile
        label="Estimated saving"
        value={t.turnsWithUsage > 0 ? formatUsd(t.savedUsd) : "n/a"}
        hint={t.turnsWithUsage > 0 ? `vs ${formatUsd(t.baselineCostUsd)} if all ran on the top gear` : "no turns with known prices yet"}
      />
      <Tile label="Manual-pick rate" value={formatPercent(t.manual, eligible)} hint={`${t.manual.toLocaleString("en-US")} picked by hand`} />
      <Tile label="Avg hold delay" value={formatMs(t.avgLatencyMs)} hint="held messages only" />
    </div>
  );
}
