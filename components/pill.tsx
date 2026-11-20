import { useComposer } from "@get-bb/plugin-sdk/app";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";
import { useGearshiftComposer } from "@/hooks/useGearshift";
import { GEARSHIFT_ICON, POPUP_ID } from "./ids";
import { formatGear, truncate } from "./format";

/** The composer pill: `Auto · Sonnet 5.5 · High`, or `Gearshift off`. */
export function GearshiftPill() {
  const composer = useComposer();
  const { enabled, ready, preview, thread, hasDraft } = useGearshiftComposer();

  let label = ready ? "Gearshift off" : "Gearshift";
  if (ready && enabled) {
    label = "Auto";
    const previewGear =
      hasDraft && preview?.gear ? formatGear(preview.gear.label, preview.gear.effort) : null;
    const lastGear =
      !hasDraft && thread?.last?.routedLabel
        ? formatGear(thread.last.routedLabel, thread.last.routedEffort)
        : null;
    const shown = previewGear ?? lastGear;
    if (shown !== null) label = `Auto · ${truncate(shown, 28)}`;
  }

  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      className={cn(
        "h-7 max-w-[14rem] shrink-0 gap-1.5 px-2 text-xs font-normal",
        ready && enabled ? "text-foreground" : "text-muted-foreground",
      )}
      aria-label={`Gearshift: ${label}. Open details`}
      aria-haspopup="dialog"
      onClick={() => composer.experimental_openPopup(POPUP_ID)}
    >
      <Icon name={GEARSHIFT_ICON} className="size-3.5 shrink-0" aria-hidden="true" />
      <span className="min-w-0 truncate">{label}</span>
    </Button>
  );
}
