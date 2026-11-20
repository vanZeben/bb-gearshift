import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRpc } from "@get-bb/plugin-sdk/app";
import type { PolicyStateDto, ProvidersDto, rpcContract } from "@/lib/contract";
import { diffOverrides } from "@/lib/policy";
import type { Policy } from "@/lib/policy";
import { isEqual, pruneGears, revertAt, structuredCloneJson, type PolicyIssue } from "@/components/settings/helpers";

export interface PolicyEditor {
  loading: boolean;
  /** Fatal: the policy itself could not be loaded. */
  loadError: string | null;
  /** Non-fatal: the model lists could not be loaded (selects fall back to free text). */
  providersError: string | null;
  providers: ProvidersDto["providers"] | null;
  state: PolicyStateDto | null;
  defaults: Policy | null;
  draft: Policy | null;
  setDraft: (next: Policy | ((prev: Policy) => Policy)) => void;
  dirty: boolean;
  /** Overrides the draft would store (minimal diff against the defaults). */
  overrides: Record<string, unknown> | null;
  issues: PolicyIssue[];
  busy: "save" | "reset" | null;
  notice: string | null;
  reload: () => void;
  save: () => Promise<void>;
  /** Reset stored overrides under each path (null: everything), then drop them from the draft too. */
  reset: (paths: readonly string[] | null) => Promise<void>;
  discard: () => void;
}

function message(err: unknown): string {
  return err instanceof Error && err.message ? err.message : "Something went wrong. Try again.";
}

/** All policy-editor state and RPC calls. Every call is guarded; nothing here throws into React. */
export function usePolicyEditor(): PolicyEditor {
  const rpc = useRpc<typeof rpcContract>();
  const [state, setState] = useState<PolicyStateDto | null>(null);
  const [providers, setProviders] = useState<ProvidersDto["providers"] | null>(null);
  const [providersError, setProvidersError] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [draft, setDraftState] = useState<Policy | null>(null);
  const [saveIssues, setSaveIssues] = useState<PolicyIssue[]>([]);
  const [busy, setBusy] = useState<"save" | "reset" | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const reload = useCallback(() => {
    setLoading(true);
    setLoadError(null);
    rpc.call("getPolicy", null).then(
      (result) => {
        if (!alive.current) return;
        setState(result);
        setDraftState(structuredCloneJson(result.effective) as Policy);
        setLoading(false);
      },
      (err) => {
        if (!alive.current) return;
        setLoadError(message(err));
        setLoading(false);
      },
    );
    rpc.call("providers", null).then(
      (result) => {
        if (!alive.current) return;
        setProviders(result.providers);
        setProvidersError(null);
      },
      (err) => {
        if (alive.current) setProvidersError(message(err));
      },
    );
  }, [rpc]);

  useEffect(reload, [reload]);

  const setDraft = useCallback((next: Policy | ((prev: Policy) => Policy)) => {
    setNotice(null);
    setDraftState((prev) => {
      if (prev === null) return prev;
      const value = typeof next === "function" ? next(prev) : next;
      return pruneGears(value as Policy & { gears: Record<string, Record<string, unknown>> }) as Policy;
    });
  }, []);

  const defaults = (state?.defaults ?? null) as Policy | null;

  const overrides = useMemo(() => {
    if (defaults === null || draft === null) return null;
    try {
      return diffOverrides(defaults, draft) as Record<string, unknown>;
    } catch {
      return null;
    }
  }, [defaults, draft]);

  const dirty = draft !== null && state !== null && !isEqual(draft, state.effective);

  const save = useCallback(async () => {
    if (overrides === null) return;
    setBusy("save");
    setNotice(null);
    try {
      const result = await rpc.call("savePolicy", { overrides });
      if (!alive.current) return;
      setState(result);
      if (result.ok) {
        setDraftState(structuredCloneJson(result.effective) as Policy);
        setSaveIssues([]);
        setNotice("Saved. New messages use this policy.");
      } else {
        setSaveIssues(result.errors); // keep the draft so nothing is lost
      }
    } catch (err) {
      if (alive.current) setSaveIssues([{ path: "", message: `Could not save: ${message(err)}` }]);
    } finally {
      if (alive.current) setBusy(null);
    }
  }, [rpc, overrides]);

  const reset = useCallback(
    async (paths: readonly string[] | null) => {
      setBusy("reset");
      setNotice(null);
      try {
        let result: PolicyStateDto | null = null;
        for (const path of paths ?? [null]) result = await rpc.call("resetPolicy", { path });
        if (!alive.current || result === null) return;
        setState(result);
        setSaveIssues([]);
        if (paths === null) {
          setDraftState(structuredCloneJson(result.effective) as Policy);
        } else {
          // Reset only the touched sections in the draft; keep unsaved edits elsewhere.
          setDraftState((prev) => {
            if (prev === null) return prev;
            let next: Policy = prev;
            for (const path of paths) next = revertAt(result.defaults, next, path.split("."));
            return next;
          });
        }
        setNotice("Reset to defaults.");
      } catch (err) {
        if (alive.current) setSaveIssues([{ path: "", message: `Could not reset: ${message(err)}` }]);
      } finally {
        if (alive.current) setBusy(null);
      }
    },
    [rpc],
  );

  const discard = useCallback(() => {
    if (state) setDraftState(structuredCloneJson(state.effective) as Policy);
    setSaveIssues([]);
    setNotice(null);
  }, [state]);

  const issues = useMemo<PolicyIssue[]>(
    () => (saveIssues.length > 0 ? saveIssues : (state?.errors ?? [])),
    [saveIssues, state],
  );

  return {
    loading, loadError, providersError, providers, state, defaults, draft, setDraft, dirty,
    overrides, issues, busy, notice, reload, save, reset, discard,
  };
}
