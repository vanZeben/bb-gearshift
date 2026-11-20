import { useEffect, useRef, useState } from "react";
import { useRpc } from "@get-bb/plugin-sdk/app";
import type { PreviewDto, rpcContract } from "@/lib/contract";
import { Select } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { ActionBadge } from "../analytics/badges";
import { formatContribution, formatGear, formatTier } from "../format";
import { useEditor } from "./context";
import { Section } from "./fields";

interface Row { providerId: string | null; name: string; preview: PreviewDto | null; error: string | null }

const MAX_PROVIDERS = 8;

/** Debounced `preview` against the *draft* overrides, once per provider. */
export function TryTab({ overrides }: { overrides: Record<string, unknown> | null }) {
  const rpc = useRpc<typeof rpcContract>();
  const { providers } = useEditor();
  const [text, setText] = useState("");
  const [rows, setRows] = useState<Row[]>([]);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [focus, setFocus] = useState<string>("");
  const request = useRef(0);

  const targets: Array<{ id: string | null; name: string }> =
    (providers ?? []).filter((p) => !p.error).slice(0, MAX_PROVIDERS).map((p) => ({ id: p.id, name: p.displayName || p.id }));
  if (targets.length === 0) targets.push({ id: null, name: "Any provider" });
  const key = JSON.stringify([text, overrides, targets.map((t) => t.id)]);

  useEffect(() => {
    if (text.trim() === "" || overrides === null) {
      request.current++;
      setRows([]);
      setBusy(false);
      setFailure(null);
      return;
    }
    const id = ++request.current;
    setBusy(true);
    const timer = setTimeout(async () => {
      const results = await Promise.all(
        targets.map(async (t): Promise<Row> => {
          try {
            const preview = await rpc.call("preview", {
              text, providerId: t.id, model: null, effort: null, threadId: null, projectId: null, overrides,
            });
            return { providerId: t.id, name: t.name, preview, error: null };
          } catch (err) {
            return { providerId: t.id, name: t.name, preview: null, error: err instanceof Error ? err.message : "Preview failed" };
          }
        }),
      );
      if (id !== request.current) return;
      setRows(results);
      setBusy(false);
      const allFailed = results.every((r) => r.preview === null);
      setFailure(allFailed ? (results[0]?.error ?? "Preview failed") : null);
    }, 300);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `key` captures text, overrides and targets
  }, [key, rpc]);

  const lead = rows.find((r) => r.providerId === focus)?.preview ?? rows.find((r) => r.preview)?.preview ?? null;
  return (
    <div className="flex flex-col gap-3">
      <p className="text-sm text-muted-foreground">
        Type a message to see how it would be scored and where it would run. This uses your unsaved draft, so you can check a change before saving.
      </p>
      <Textarea
        aria-label="Message to try"
        rows={4}
        placeholder="e.g. port the billing service into a plugin, with tests and a PR"
        value={text}
        onChange={(e) => setText(e.target.value)}
        maxLength={50_000}
      />
      {failure ? <p role="alert" className="text-sm text-destructive">Could not preview: {failure}</p> : null}
      {text.trim() === "" ? null : lead ? (
        <div className="flex flex-col gap-3" aria-live="polite" aria-busy={busy}>
          <Section title="Score">
            <div className="flex flex-wrap items-center gap-2 text-sm">
              <span className="text-2xl font-semibold tabular-nums">{lead.score ?? "–"}</span>
              <Badge>{formatTier(lead.tier)}</Badge>
              {lead.confidence ? <Badge variant="outline">{lead.confidence} confidence</Badge> : null}
              <ActionBadge action={lead.action} />
              {busy ? <span className="text-xs text-muted-foreground">updating…</span> : null}
            </div>
            <p className="text-xs text-muted-foreground">{lead.reason}</p>
            {lead.contributions && lead.contributions.length > 0 ? (
              <ol className="flex flex-col gap-1 text-sm">
                {lead.contributions.map((c, i) => (
                  <li key={`${c.id}-${i}`} className="flex flex-wrap items-baseline gap-x-2">
                    <span className="font-medium">{formatContribution(c)}</span>
                    {c.match ? <code className="max-w-full truncate rounded bg-muted px-1 text-xs">{c.match}</code> : null}
                  </li>
                ))}
              </ol>
            ) : (
              <p className="text-xs text-muted-foreground">Nothing in the policy matched this message.</p>
            )}
          </Section>
          <Section title="Where it would run">
            {targets.length > 1 ? (
              <label className="flex items-center gap-2 text-xs text-muted-foreground">
                Score shown for
                <Select className="w-auto" value={focus} onChange={(e) => setFocus(e.target.value)} aria-label="Provider whose score is shown">
                  <option value="">First provider</option>
                  {targets.map((t) => <option key={t.id ?? "any"} value={t.id ?? ""}>{t.name}</option>)}
                </Select>
              </label>
            ) : null}
            <ul className="flex flex-col gap-1.5">
              {rows.map((r) => (
                <li key={r.providerId ?? "any"} className="flex flex-wrap items-baseline justify-between gap-2 text-sm">
                  <span className="text-muted-foreground">{r.name}</span>
                  <span className="min-w-0 break-words text-right">
                    {r.preview?.gear
                      ? <>
                          {formatGear(r.preview.gear.label, r.preview.gear.effort)}
                          {(r.preview.gear as { serviceTier?: string | null }).serviceTier ? ` · ${(r.preview.gear as { serviceTier?: string | null }).serviceTier}` : ""}
                        </>
                      : r.error ?? (r.preview?.reason || "Not routed")}
                  </span>
                </li>
              ))}
            </ul>
          </Section>
        </div>
      ) : busy ? (
        <p className="text-sm text-muted-foreground">Scoring…</p>
      ) : null}
    </div>
  );
}
