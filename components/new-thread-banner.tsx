import { useEffect, useRef, useState } from "react";
import { useComposer, useRpc } from "@get-bb/plugin-sdk/app";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { useNewThreadEnabled } from "@/hooks/useGearshift";
import type { rpcContract } from "@/lib/contract";
import { GEARSHIFT_ICON } from "./ids";

/**
 * Always mounted for new-thread composers. Owns arming: it tells the server the current
 * state on mount and on every toggle, and while off re-arms as the draft text changes.
 */
export function NewThreadBanner() {
  const composer = useComposer();
  const rpc = useRpc<typeof rpcContract>();
  const [enabled, setEnabled] = useNewThreadEnabled();
  const [failed, setFailed] = useState(false);
  const { key, text, scope } = composer;
  const projectId = scope.kind === "new-thread" ? scope.projectId : null;
  const armedText = useRef<string | null>(null);
  const latest = useRef({ text, retry: 0 });
  latest.current.text = text;

  const arm = (payloadText: string, on: boolean) => {
    armedText.current = payloadText;
    rpc.call("armNewThread", { key, projectId, text: payloadText, enabled: on }).then(
      () => setFailed(false),
      () => setFailed(true),
    );
  };

  // Mount, toggle, composer or project change: sync immediately.
  useEffect(() => {
    arm(latest.current.text, enabled);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- arm only on these inputs
  }, [enabled, key, projectId, rpc, failed ? latest.current.retry : 0]);

  // While off, follow the draft so the server can match it by exact text.
  useEffect(() => {
    if (enabled || armedText.current === text) return;
    const timer = setTimeout(() => arm(text, false), 120);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, text]);

  if (enabled) return null;
  return (
    <div className="flex min-w-0 items-center gap-2 px-1 text-xs text-muted-foreground" role="status">
      <Icon name={GEARSHIFT_ICON} className="size-3.5 shrink-0" aria-hidden="true" />
      <span className="min-w-0 truncate">
        {failed ? "Gearshift is off here, but that could not be saved" : "Gearshift is off for this new thread"}
      </span>
      <span aria-hidden="true">·</span>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="h-6 px-1.5 text-xs"
        onClick={() => (failed ? arm(text, false) : setEnabled(true))}
      >
        {failed ? "Retry" : "Turn on"}
      </Button>
    </div>
  );
}
