import { useCallback, useEffect, useState } from "react";
import { useRealtime, useRpc } from "@get-bb/plugin-sdk/app";
import { DECISIONS_CHANGED } from "@/lib/channels";
import type { OverviewDto, rpcContract } from "@/lib/contract";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { CostChart } from "./cost-chart";
import { ModelMix, TierDistribution, Transitions } from "./distribution";
import { Kpis } from "./kpis";
import { RecentDecisions } from "./recent";
import { SubAgents } from "./subagents";

const RANGES = [7, 30, 90] as const;

export function AnalyticsPage() {
  const rpc = useRpc<typeof rpcContract>();
  const [days, setDays] = useState<number>(30);
  const [data, setData] = useState<OverviewDto | null>(null);
  const [failed, setFailed] = useState(false);

  const load = useCallback(() => {
    rpc.call("overview", { days }).then(
      (result) => {
        setData(result);
        setFailed(false);
      },
      () => setFailed(true),
    );
  }, [rpc, days]);

  useEffect(() => {
    load();
    const timer = setInterval(load, 60_000);
    return () => clearInterval(timer);
  }, [load]);
  useRealtime(DECISIONS_CHANGED, load);

  const empty = data !== null && data.totals.decisions === 0;

  return (
    <div className="h-full min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto box-border flex w-full max-w-5xl flex-col gap-4 px-4 pb-6 pt-3 md:px-5 md:pt-4">
        <header className="flex flex-wrap items-start justify-between gap-3">
          <p className="min-w-0 max-w-2xl text-sm text-muted-foreground">
            How Gearshift decides: it sizes each message, picks the smallest model and effort that fits, never
            downshifts a large cached context, and leaves models you pick by hand alone.
          </p>
          <div role="group" aria-label="Range" className="inline-flex rounded-md border border-border p-0.5">
            {RANGES.map((r) => (
              <Button
                key={r}
                type="button"
                size="sm"
                variant="ghost"
                aria-pressed={days === r}
                className={cn("h-7 px-3", days === r && "bg-state-active text-foreground")}
                onClick={() => setDays(r)}
              >
                {r} days
              </Button>
            ))}
          </div>
        </header>

        {data === null ? (
          <div role="status" className="rounded-lg border border-dashed border-border px-4 py-6 text-center text-sm text-muted-foreground">
            {failed ? "Analytics are unavailable right now. Retrying…" : "Loading…"}
          </div>
        ) : empty ? (
          <div role="status" className="rounded-lg border border-dashed border-border px-4 py-8 text-center text-sm text-muted-foreground">
            No routed messages yet. Send a message in any thread with Gearshift on.
          </div>
        ) : (
          <>
            <Kpis data={data} />
            <div className="grid gap-4 md:grid-cols-2">
              <TierDistribution data={data} />
              <ModelMix data={data} />
            </div>
            <CostChart daily={data.daily} />
            <Transitions data={data} />
            <SubAgents data={data.fanout} />
            <RecentDecisions rows={data.recent} />
            <p className="text-xs text-muted-foreground">
              Costs are estimates: each turn's token usage priced at public API list prices, not what a subscription or invoice charges.
              Savings compare against running every message on the provider's top gear.
              {data.threadsOff > 0 ? ` Gearshift is off for ${data.threadsOff} thread${data.threadsOff === 1 ? "" : "s"}.` : ""}
            </p>
          </>
        )}
      </div>
    </div>
  );
}
