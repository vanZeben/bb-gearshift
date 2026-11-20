import { useBbNavigate } from "@get-bb/plugin-sdk/app";
import type { DecisionDto } from "@/lib/contract";
import { ActionBadge, Muted, SectionCard } from "./badges";
import { formatClock, formatGear, formatTier, formatTokens, formatUsd, shortModel, truncate } from "../format";

function tokensOf(d: DecisionDto): number | null {
  if (!d.usage) return null;
  return d.usage.inputTokens + d.usage.outputTokens + d.usage.cacheReadTokens + d.usage.cacheWriteTokens;
}

export function RecentDecisions({ rows }: { rows: DecisionDto[] }) {
  const navigate = useBbNavigate();
  return (
    <SectionCard title="Recent decisions" caption="Newest 50 across all threads">
      {rows.length === 0 ? (
        <Muted>Nothing yet.</Muted>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[44rem] text-xs">
            <thead className="text-left text-muted-foreground">
              <tr>
                <th className="py-1 pr-3 font-medium">Time</th>
                <th className="py-1 pr-3 font-medium">Thread</th>
                <th className="py-1 pr-3 font-medium">Tier</th>
                <th className="py-1 pr-3 font-medium">Requested → routed</th>
                <th className="py-1 pr-3 font-medium">Action</th>
                <th className="py-1 pr-3 font-medium">Reason</th>
                <th className="py-1 pr-3 text-right font-medium">Tokens</th>
                <th className="py-1 text-right font-medium">Cost</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border align-top">
              {rows.map((d) => (
                <tr key={d.id}>
                  <td className="whitespace-nowrap py-1.5 pr-3 text-muted-foreground">{formatClock(d.at)}</td>
                  <td className="py-1.5 pr-3">
                    <button
                      type="button"
                      className="cursor-pointer text-primary underline-offset-4 hover:underline"
                      onClick={() => navigate.toThread(d.threadId)}
                    >
                      {d.threadId.slice(0, 8)}
                    </button>
                  </td>
                  <td className="py-1.5 pr-3">{formatTier(d.tier)}</td>
                  <td className="whitespace-nowrap py-1.5 pr-3">
                    {d.requestedLabel ?? shortModel(d.requestedModel)} <span className="text-muted-foreground">→</span>{" "}
                    {formatGear(d.routedLabel, d.routedEffort) ?? shortModel(d.routedModel)}
                  </td>
                  <td className="py-1.5 pr-3"><ActionBadge action={d.action} /></td>
                  <td className="max-w-[18rem] py-1.5 pr-3 text-muted-foreground" title={d.reason}>{truncate(d.reason, 80)}</td>
                  <td className="py-1.5 pr-3 text-right tabular-nums">{formatTokens(tokensOf(d))}</td>
                  <td className="py-1.5 text-right tabular-nums">{formatUsd(d.costUsd)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </SectionCard>
  );
}
