import { useState } from "react";
import type { OverviewDto } from "@/lib/contract";
import { Button } from "@/components/ui/button";
import { formatDay, formatUsd } from "../format";
import { Muted, SectionCard } from "./badges";

const W = 600;
const H = 160;
const PAD = { l: 4, r: 4, t: 8, b: 4 };

type Day = OverviewDto["daily"][number];

/** Daily cost (solid) against the same usage on the top gear (dashed). */
export function CostChart({ daily }: { daily: Day[] }) {
  const [table, setTable] = useState(false);
  const [hover, setHover] = useState<number | null>(null);

  const max = Math.max(0.0001, ...daily.map((d) => Math.max(d.costUsd, d.baselineCostUsd)));
  const n = daily.length;
  const x = (i: number) => (n <= 1 ? W / 2 : PAD.l + (i / (n - 1)) * (W - PAD.l - PAD.r));
  const y = (v: number) => PAD.t + (1 - v / max) * (H - PAD.t - PAD.b);
  const line = (values: number[]) =>
    values.map((v, i) => `${i === 0 ? "M" : "L"}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(" ");
  const cost = daily.map((d) => d.costUsd);
  const base = daily.map((d) => d.baselineCostUsd);
  const costPath = line(cost);
  const area = n > 1 ? `${costPath} L${x(n - 1).toFixed(1)},${H - PAD.b} L${x(0).toFixed(1)},${H - PAD.b} Z` : "";
  const active = hover !== null ? daily[hover] : undefined;
  const totalCost = cost.reduce((s, v) => s + v, 0);
  const totalBase = base.reduce((s, v) => s + v, 0);
  const step = n <= 1 ? W : (W - PAD.l - PAD.r) / (n - 1);

  return (
    <SectionCard
      title="Daily cost vs always top gear"
      caption="Estimated from token usage at public API list prices, not a bill"
      actions={
        <Button type="button" variant="ghost" size="sm" aria-pressed={table} onClick={() => setTable((t) => !t)}>
          {table ? "Show chart" : "Show table"}
        </Button>
      }
    >
      {n === 0 ? (
        <Muted>No daily data in this range.</Muted>
      ) : table ? (
        <div className="max-h-64 overflow-auto">
          <table className="w-full text-xs">
            <thead className="text-left text-muted-foreground">
              <tr>
                <th className="py-1 pr-2 font-medium">Day</th>
                <th className="py-1 pr-2 text-right font-medium">Routed</th>
                <th className="py-1 pr-2 text-right font-medium">Cost</th>
                <th className="py-1 text-right font-medium">Top gear</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {daily.map((d) => (
                <tr key={d.day}>
                  <td className="py-1 pr-2">{formatDay(d.day)}</td>
                  <td className="py-1 pr-2 text-right tabular-nums">{d.routed}</td>
                  <td className="py-1 pr-2 text-right tabular-nums">{formatUsd(d.costUsd)}</td>
                  <td className="py-1 text-right tabular-nums">{formatUsd(d.baselineCostUsd)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <>
          <div className="mb-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs">
            <span className="inline-flex items-center gap-1.5">
              <span className="inline-block h-0.5 w-4 bg-foreground" aria-hidden="true" />
              With Gearshift <span className="tabular-nums text-muted-foreground">{formatUsd(totalCost)}</span>
            </span>
            <span className="inline-flex items-center gap-1.5">
              <span className="inline-block w-4 border-t-2 border-dashed border-muted-foreground" aria-hidden="true" />
              Top gear <span className="tabular-nums text-muted-foreground">{formatUsd(totalBase)}</span>
            </span>
            <span className="min-h-4 tabular-nums text-muted-foreground sm:ml-auto" aria-live="polite">
              {active
                ? `${formatDay(active.day)}: ${formatUsd(active.costUsd)} vs ${formatUsd(active.baselineCostUsd)} · ${active.routed} routed`
                : "Hover for a day"}
            </span>
          </div>
          <svg
            viewBox={`0 0 ${W} ${H}`}
            className="h-40 w-full"
            preserveAspectRatio="none"
            role="img"
            aria-label={`Daily cost with Gearshift ${formatUsd(totalCost)} against ${formatUsd(totalBase)} on the top gear`}
            onMouseLeave={() => setHover(null)}
          >
            <line x1={PAD.l} x2={W - PAD.r} y1={H - PAD.b} y2={H - PAD.b} className="stroke-border" strokeWidth={1} vectorEffect="non-scaling-stroke" />
            {area ? <path d={area} className="fill-foreground/10" /> : null}
            <path d={line(base)} className="fill-none stroke-muted-foreground" strokeWidth={2} strokeDasharray="5 4" vectorEffect="non-scaling-stroke" />
            <path d={costPath} className="fill-none stroke-foreground" strokeWidth={2} strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
            {hover !== null ? (
              <line x1={x(hover)} x2={x(hover)} y1={PAD.t} y2={H - PAD.b} className="stroke-muted-foreground" strokeWidth={1} vectorEffect="non-scaling-stroke" />
            ) : null}
            {daily.map((d, i) => (
              <rect
                key={d.day}
                x={x(i) - step / 2}
                width={step}
                y={0}
                height={H}
                className="fill-transparent"
                onMouseEnter={() => setHover(i)}
              />
            ))}
          </svg>
          <div className="mt-1 flex justify-between text-[11px] text-muted-foreground">
            <span>{formatDay(daily[0]!.day)}</span>
            <span>{formatDay(daily[n - 1]!.day)}</span>
          </div>
        </>
      )}
    </SectionCard>
  );
}
