import { useId } from "react";
import { useBbNavigate, useComposer } from "@get-bb/plugin-sdk/app";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Icon } from "@/components/ui/icon";
import { useGearshiftComposer } from "@/hooks/useGearshift";
import { PLUGIN_PANEL_PATH } from "./ids";
import { ActionBadge } from "./analytics/badges";
import { formatContributions, formatGear, formatRelativeTime, formatTier, shortModel } from "./format";

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex w-full items-start justify-between gap-3 text-xs">
      <dt className="shrink-0 text-muted-foreground">{label}</dt>
      <dd className="ml-auto min-w-0 text-right">{children}</dd>
    </div>
  );
}

/** Popup opened from the pill: switch, draft routing and the last decision. */
export function GearshiftPopup() {
  const composer = useComposer();
  const navigate = useBbNavigate();
  const switchId = useId();
  const { enabled, ready, preview, thread, hasDraft, setEnabled, isNewThread } = useGearshiftComposer();
  const last = thread?.last ?? null;
  const previewGear = preview?.gear ? formatGear(preview.gear.label, preview.gear.effort) : null;
  const serviceTier = preview?.gear?.serviceTier ?? null;
  const score = formatContributions(preview?.contributions);

  return (
    <div className="flex w-full min-w-0 flex-col gap-3 p-3 sm:min-w-80">
      <div className="flex items-center justify-between gap-3">
        <label htmlFor={switchId} className="text-sm font-medium">
          {isNewThread ? "Gearshift for this new thread" : "Gearshift for this thread"}
        </label>
        <Switch id={switchId} checked={enabled} disabled={!ready} onCheckedChange={(next) => void setEnabled(next)} />
      </div>

      {!ready ? (
        <p className="text-xs text-muted-foreground">Loading this thread…</p>
      ) : enabled ? (
        <>
          <section aria-label="This draft">
            <h3 className="mb-1 text-xs font-medium text-muted-foreground">This draft</h3>
            {hasDraft && preview ? (
              <dl className="flex w-full flex-col gap-1">
                <Row label="Tier">
                  {formatTier(preview.tier)}
                  {preview.confidence ? (
                    <span className="text-muted-foreground"> · {preview.confidence} confidence</span>
                  ) : null}
                </Row>
                {previewGear ? <Row label="Would run on">{previewGear}{serviceTier ? ` · ${serviceTier}` : ""}</Row> : null}
                {score ? <Row label="Score">{score}</Row> : null}
                {preview.signals.length > 0 ? (
                  <Row label="Signals">{preview.signals.join(", ")}</Row>
                ) : null}
                <Row label="Why">{preview.reason}</Row>
              </dl>
            ) : (
              <p className="text-xs text-muted-foreground">
                {hasDraft ? "Reading your draft…" : "Type a message to see where it would run."}
              </p>
            )}
          </section>

          {!isNewThread ? (
            <section aria-label="Last decision">
              <h3 className="mb-1 text-xs font-medium text-muted-foreground">Last decision</h3>
              {last ? (
                <dl className="flex w-full flex-col gap-1">
                  <Row label="Action">
                    <ActionBadge action={last.action} />
                  </Row>
                  <Row label="Model">
                    {last.requestedLabel ?? shortModel(last.requestedModel)} <span className="text-muted-foreground">→</span>{" "}
                    {formatGear(last.routedLabel, last.routedEffort) ?? shortModel(last.routedModel)}
                  </Row>
                  <Row label="Why">{last.reason}</Row>
                  <Row label="When">{formatRelativeTime(last.at)}</Row>
                </dl>
              ) : (
                <p className="text-xs text-muted-foreground">Nothing routed in this thread yet.</p>
              )}
            </section>
          ) : null}
        </>
      ) : (
        <p className="text-xs text-muted-foreground">
          Messages here keep whatever model and effort the composer has selected.
        </p>
      )}

      <Button
        type="button"
        variant="outline"
        size="sm"
        className="w-full"
        onClick={() => {
          composer.experimental_closePopup();
          navigate.toPluginPanel(PLUGIN_PANEL_PATH);
        }}
      >
        <Icon name="ChartColumn" className="size-3.5" aria-hidden="true" />
        Open analytics
      </Button>
    </div>
  );
}
