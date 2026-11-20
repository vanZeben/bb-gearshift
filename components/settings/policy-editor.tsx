import { Component, useCallback, useMemo, useState, type ErrorInfo, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Tabs, tabDomId } from "@/components/ui/tabs";
import { usePolicyEditor } from "@/hooks/usePolicyEditor";
import type { Policy } from "@/lib/policy";
import { EditorContext, type EditorCtx } from "./context";
import { ConfirmButton } from "./fields";
import { GearsTab } from "./gears-tab";
import { TeamsTab } from "./teams-tab";
import { ResetContext } from "./reset-context";
import { ScoringTab } from "./scoring-tab";
import { TryTab } from "./try-tab";
import {
  delAt, isEqual, issuesUnderAny, revertAt, setAt, type Path, type PolicyIssue,
} from "./helpers";

const ID_PREFIX = "gearshift-policy";

type TabId = "gears" | "teams" | "scoring" | "try";

/** Which top-level policy keys (and error path prefixes) belong to each tab. */
const TAB_KEYS: Partial<Record<TabId, string[]>> = {
  gears: ["gears"],
  teams: ["teams", "roles"],
  scoring: ["tiers", "scoring", "explicitModel", "skipPatterns"],
};

/** A render error inside the editor must never take the settings page down. */
class Boundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null };
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  componentDidCatch(_error: Error, _info: ErrorInfo) {}
  render() {
    if (this.state.error) {
      return (
        <div role="alert" className="flex flex-col gap-2 rounded-lg border border-destructive p-3 text-sm">
          <p className="font-medium text-destructive">The routing policy editor hit a problem.</p>
          <p className="text-xs text-muted-foreground">{this.state.error.message}</p>
          <div>
            <Button type="button" size="sm" variant="outline" onClick={() => this.setState({ error: null })}>Try again</Button>
          </div>
          <p className="text-xs text-muted-foreground">Your saved policy is unaffected.</p>
        </div>
      );
    }
    return this.props.children;
  }
}

export function PolicyEditor() {
  return (
    <Boundary>
      <PolicyEditorInner />
    </Boundary>
  );
}

function PolicyEditorInner() {
  const ed = usePolicyEditor();
  const [tab, setTab] = useState<TabId>("gears");
  const { draft, defaults, setDraft } = ed;

  const set = useCallback(
    (path: Path, value: unknown) =>
      setDraft((prev) => (value === undefined ? delAt(prev, path) : setAt(prev, path, value)) as Policy),
    [setDraft],
  );
  const update = useCallback((fn: (prev: Policy) => Policy) => setDraft(fn), [setDraft]);
  const revert = useCallback(
    (path: Path) => {
      if (defaults) setDraft((prev) => revertAt(defaults, prev, path));
    },
    [defaults, setDraft],
  );

  const issues: readonly PolicyIssue[] = ed.issues;
  const ctx = useMemo<EditorCtx | null>(
    () =>
      draft && defaults
        ? { draft, defaults, issues, providers: ed.providers, set, update, revert }
        : null,
    [draft, defaults, issues, ed.providers, set, update, revert],
  );
  const resetCtx = useMemo(() => ({ reset: (p: readonly string[] | null) => void ed.reset(p), busy: ed.busy !== null }), [ed]);

  if (ed.loading && !draft) {
    return <p className="text-sm text-muted-foreground" role="status">Loading routing policy…</p>;
  }
  if (ed.loadError || !ctx || !draft || !defaults) {
    return (
      <div role="alert" className="flex flex-col gap-2 rounded-lg border border-border p-3 text-sm">
        <p className="font-medium">Could not load the routing policy.</p>
        <p className="text-xs text-muted-foreground">{ed.loadError ?? "No data came back."}</p>
        <div>
          <Button type="button" size="sm" variant="outline" onClick={ed.reload}>Retry</Button>
        </div>
      </div>
    );
  }

  const tabBadge = (id: TabId) => {
    const keys = TAB_KEYS[id];
    if (!keys) return undefined;
    const errors = issuesUnderAny(issues, keys).length;
    if (errors > 0) return <Badge variant="destructive">{errors}</Badge>;
    const changed = keys.some((k) => !isEqual((draft as unknown as Record<string, unknown>)[k], (defaults as unknown as Record<string, unknown>)[k]));
    return changed ? <span className="size-1.5 rounded-full bg-foreground" role="img" aria-label="has changes" /> : undefined;
  };

  const hasOverrides = ed.state !== null && Object.keys(ed.state.overrides).length > 0;

  return (
    <EditorContext.Provider value={ctx}>
      <ResetContext.Provider value={resetCtx}>
        <div className="flex min-w-0 flex-col gap-4">
          <p className="text-xs text-muted-foreground">
            Switches like &lsquo;Start new threads with Gearshift on&rsquo; are in the settings above.
          </p>
          {ed.providersError ? (
            <p className="text-xs text-muted-foreground" role="status">
              Model lists are unavailable ({ed.providersError}). You can still type model names by hand.
            </p>
          ) : null}

          {issues.length > 0 ? (
            <div role="alert" className="rounded-lg border border-destructive p-3 text-sm">
              <p className="font-medium text-destructive">
                {issues.length === 1 ? "1 problem" : `${issues.length} problems`} with this policy
                {ed.state && !ed.state.ok ? " (not saved)" : ""}
              </p>
              <ul className="mt-1 flex flex-col gap-0.5 text-xs">
                {issues.map((e, i) => (
                  <li key={`${e.path}-${i}`}>
                    {e.path ? <code className="rounded bg-muted px-1">{e.path}</code> : null} {e.message}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}

          <Tabs
            idPrefix={ID_PREFIX}
            label="Routing policy sections"
            value={tab}
            onValueChange={(v) => setTab(v as TabId)}
            tabs={[
              { id: "gears", label: "Gears", badge: tabBadge("gears") },
              { id: "teams", label: "Teams", badge: tabBadge("teams") },
              { id: "scoring", label: "Scoring", badge: tabBadge("scoring") },
              { id: "try", label: "Try a message" },
            ]}
          />

          <div id={`${ID_PREFIX}-panel`} role="tabpanel" aria-labelledby={tabDomId(ID_PREFIX, tab)} tabIndex={0} className="min-w-0 focus-visible:outline-none">
            {tab === "gears" ? <GearsTab /> : null}
            {tab === "teams" ? <TeamsTab /> : null}
            {tab === "scoring" ? <ScoringTab /> : null}
            {tab === "try" ? <TryTab overrides={ed.overrides} /> : null}
          </div>

          <div className="sticky bottom-0 z-10 -mx-1 flex flex-wrap items-center gap-2 border-t border-border bg-background/95 px-1 py-3 backdrop-blur">
            <Button type="button" size="sm" onClick={() => void ed.save()} disabled={!ed.dirty || ed.busy !== null || ed.overrides === null}>
              {ed.busy === "save" ? "Saving…" : "Save"}
            </Button>
            <Button type="button" size="sm" variant="outline" onClick={ed.discard} disabled={!ed.dirty || ed.busy !== null}>
              Discard changes
            </Button>
            <span className="text-xs text-muted-foreground" role="status" aria-live="polite">
              {ed.dirty ? "Unsaved changes" : ed.notice ?? (hasOverrides ? "Your changes are saved on top of the defaults." : "Using the defaults.")}
            </span>
            <span className="ml-auto">
              <ConfirmButton
                label="Reset all"
                prompt="Reset the whole policy to defaults?"
                disabled={ed.busy !== null || (!hasOverrides && !ed.dirty)}
                onConfirm={() => void ed.reset(null)}
              />
            </span>
          </div>
        </div>
      </ResetContext.Provider>
    </EditorContext.Provider>
  );
}
