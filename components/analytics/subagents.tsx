import { useBbNavigate } from "@get-bb/plugin-sdk/app";
import type { OverviewDto } from "@/lib/contract";
import { Muted, SectionCard } from "./badges";
import { formatClock, formatPercent, formatTier, formatTokens } from "../format";

type Fanout = OverviewDto["fanout"];

/** Lead vs sub-agent spend, runs by role, budget-used histogram and the newest runs. Host token classes only, no prices. */
export function SubAgents({ data }: { data: Fanout }) {
  const navigate = useBbNavigate();
  const total = data.leadTokens + data.subTokens;
  const maxBucket = Math.max(1, ...data.budgetUsed.map((b) => b.count));
  return (
    <SectionCard title="Sub-agents" caption="Runs started with gearshift_spawn. Spend = input + cache writes + output + 0.1 x cache reads">
      {data.runs === 0 ? (
        <Muted>No sub-agent runs yet. Medium and larger messages tell the agent which roles to spawn.</Muted>
      ) : (
        <div className="flex flex-col gap-4">
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4 text-sm">
            <div><div className="text-xs text-muted-foreground">Lead spend</div><div className="text-lg font-semibold tabular-nums">{formatTokens(data.leadTokens)}</div></div>
            <div><div className="text-xs text-muted-foreground">Sub-agent spend</div><div className="text-lg font-semibold tabular-nums">{formatTokens(data.subTokens)}</div><div className="text-[11px] text-muted-foreground">{formatPercent(data.subTokens, total)} of all</div></div>
            <div><div className="text-xs text-muted-foreground">Runs</div><div className="text-lg font-semibold tabular-nums">{data.runs.toLocaleString("en-US")}</div></div>
            <div><div className="text-xs text-muted-foreground">Over budget</div><div className="text-lg font-semibold tabular-nums">{formatPercent(data.overBudget, data.runs)}</div></div>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full min-w-[28rem] text-xs">
              <caption className="pb-1 text-left text-xs font-medium">Runs by role</caption>
              <thead className="text-left text-muted-foreground">
                <tr><th className="py-1 pr-3 font-medium">Role</th><th className="py-1 pr-3 text-right font-medium">Runs</th><th className="py-1 pr-3 text-right font-medium">Avg spend</th><th className="py-1 text-right font-medium">Over budget</th></tr>
              </thead>
              <tbody className="divide-y divide-border">
                {data.byRole.map((r) => (
                  <tr key={r.role}>
                    <td className="py-1.5 pr-3">{r.role}</td>
                    <td className="py-1.5 pr-3 text-right tabular-nums">{r.count}</td>
                    <td className="py-1.5 pr-3 text-right tabular-nums">{formatTokens(Math.round(r.spent / r.count))}</td>
                    <td className="py-1.5 text-right tabular-nums">{formatPercent(r.over, r.count)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div>
            <h3 className="mb-1 text-xs font-medium">Budget used</h3>
            <ul className="flex flex-col gap-1">
              {data.budgetUsed.map((b) => (
                <li key={b.bucket} className="grid grid-cols-[5rem_minmax(0,1fr)_2rem] items-center gap-2 text-xs">
                  <span className="text-muted-foreground">{b.bucket}</span>
                  <div className="h-3 overflow-hidden rounded-r bg-muted"><div className="h-full rounded-r bg-foreground" style={{ width: `${(b.count / maxBucket) * 100}%` }} /></div>
                  <span className="text-right tabular-nums">{b.count}</span>
                </li>
              ))}
            </ul>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full min-w-[34rem] text-xs">
              <caption className="pb-1 text-left text-xs font-medium">Recent runs</caption>
              <thead className="text-left text-muted-foreground">
                <tr><th className="py-1 pr-3 font-medium">Time</th><th className="py-1 pr-3 font-medium">Role</th><th className="py-1 pr-3 font-medium">Model</th><th className="py-1 pr-3 text-right font-medium">Spent / budget</th><th className="py-1 pr-3 font-medium">Status</th><th className="py-1 font-medium">Thread</th></tr>
              </thead>
              <tbody className="divide-y divide-border">
                {data.recent.map((r) => (
                  <tr key={r.id}>
                    <td className="whitespace-nowrap py-1.5 pr-3 text-muted-foreground">{formatClock(r.startedAt)}</td>
                    <td className="py-1.5 pr-3">{r.role} <span className="text-muted-foreground">({formatTier(r.tier)})</span></td>
                    <td className="whitespace-nowrap py-1.5 pr-3">{r.modelLabel ?? "unknown"}{r.effort ? ` · ${r.effort}` : ""}</td>
                    <td className="whitespace-nowrap py-1.5 pr-3 text-right tabular-nums">{formatTokens(r.spent)} / {formatTokens(r.budget)}</td>
                    <td className="py-1.5 pr-3">{r.status}</td>
                    <td className="py-1.5"><button type="button" className="cursor-pointer text-primary underline-offset-4 hover:underline" onClick={() => navigate.toThread(r.childThreadId)}>{r.childThreadId.slice(0, 8)}</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </SectionCard>
  );
}
