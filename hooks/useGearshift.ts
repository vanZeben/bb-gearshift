import { useCallback, useEffect, useRef, useSyncExternalStore } from "react";
import { experimental_usePluginId, useComposer, useRealtime, useRpc } from "@get-bb/plugin-sdk/app";
import type { PluginRpcClient } from "@get-bb/plugin-sdk/app";
import { DECISIONS_CHANGED } from "@/lib/channels";
import type { PreviewDto, ThreadStateDto, rpcContract } from "@/lib/contract";

export type GearshiftRpc = PluginRpcClient<typeof rpcContract>;

/* ---- New-thread "off" state: per composer key, persisted so UI and server agree after a reload ---- */

const offKeys = new Map<string, boolean>();
const offListeners = new Set<() => void>();
const storageKey = (pluginId: string, key: string) => `${pluginId}:new-thread-off:${key}`;

function readOff(pluginId: string, key: string): boolean {
  const k = storageKey(pluginId, key);
  const cached = offKeys.get(k);
  if (cached !== undefined) return cached;
  let off = false;
  try {
    off = globalThis.localStorage?.getItem(k) === "1";
  } catch {
    /* storage unavailable: session-only */
  }
  offKeys.set(k, off);
  return off;
}

export function setNewThreadEnabled(pluginId: string, key: string, enabled: boolean) {
  const k = storageKey(pluginId, key);
  if (readOff(pluginId, key) === !enabled) return;
  offKeys.set(k, !enabled);
  try {
    if (enabled) globalThis.localStorage?.removeItem(k);
    else globalThis.localStorage?.setItem(k, "1");
  } catch {
    /* ignore */
  }
  for (const l of offListeners) l();
}

export function useNewThreadEnabled(): [boolean, (next: boolean) => void] {
  const pluginId = experimental_usePluginId();
  const key = useComposer().key;
  const off = useSyncExternalStore(
    (cb) => {
      offListeners.add(cb);
      return () => offListeners.delete(cb);
    },
    () => readOff(pluginId, key),
  );
  const set = useCallback((next: boolean) => setNewThreadEnabled(pluginId, key, next), [pluginId, key]);
  return [!off, set];
}

/* ---- Shared per-composer state (thread + preview) so pill and popup fetch once ---- */

interface Snapshot {
  thread: ThreadStateDto | null;
  threadLoaded: boolean;
  preview: PreviewDto | null;
}
interface PreviewParams {
  text: string; providerId: string | null; model: string | null; effort: string | null;
  threadId: string | null; projectId: string | null;
}
interface Entry {
  snap: Snapshot;
  refs: number;
  subs: Set<() => void>;
  threadId: string | null;
  threadCall: number;
  previewCall: number;
  sig: string;
  timer: ReturnType<typeof setTimeout> | undefined;
  refreshTimer: ReturnType<typeof setTimeout> | undefined;
  params: PreviewParams | null;
  rpc: GearshiftRpc | null;
}

const entries = new Map<string, Entry>();

function entryFor(key: string): Entry {
  let e = entries.get(key);
  if (!e) {
    e = {
      snap: { thread: null, threadLoaded: false, preview: null }, refs: 0, subs: new Set(),
      threadId: null, threadCall: 0, previewCall: 0, sig: "", timer: undefined, refreshTimer: undefined,
      params: null, rpc: null,
    };
    entries.set(key, e);
  }
  return e;
}

function patch(e: Entry, next: Partial<Snapshot>) {
  e.snap = { ...e.snap, ...next };
  for (const s of e.subs) s();
}

function loadThread(e: Entry) {
  const { rpc, threadId } = e;
  if (!rpc || threadId === null) return;
  const call = ++e.threadCall;
  rpc.call("threadState", { threadId }).then(
    (result) => {
      if (call !== e.threadCall || result.threadId !== threadId) return;
      patch(e, { thread: result, threadLoaded: true });
    },
    () => {
      if (call === e.threadCall) patch(e, { threadLoaded: true });
    },
  );
}

function loadPreview(e: Entry) {
  const { rpc, params } = e;
  if (!rpc || !params || params.text.trim() === "") return;
  const call = ++e.previewCall;
  rpc.call("preview", params).then(
    (result) => {
      if (call === e.previewCall) patch(e, { preview: result });
    },
    () => {},
  );
}

/** True when a realtime payload concerns this thread (or carries no thread id). */
export function matchesThread(payload: unknown, threadId: string | null): boolean {
  if (threadId === null) return false;
  if (typeof payload !== "object" || payload === null) return true;
  const id = (payload as { threadId?: unknown }).threadId;
  return typeof id !== "string" || id === threadId;
}

export interface GearshiftComposerState {
  /** Gearshift is on for this thread / draft. */
  enabled: boolean;
  /** Thread state is known (always true for new threads). */
  ready: boolean;
  preview: PreviewDto | null;
  thread: ThreadStateDto | null;
  hasDraft: boolean;
  setEnabled: (next: boolean) => Promise<void>;
  isNewThread: boolean;
}

/** State for the composer the pill or popup is mounted in. RPC failures degrade quietly. */
export function useGearshiftComposer(): GearshiftComposerState {
  const composer = useComposer();
  const rpc = useRpc<typeof rpcContract>();
  const { key, scope, text, selection } = composer;
  const threadId = scope.kind === "thread" ? scope.threadId : null;
  const projectId = scope.kind === "new-thread" ? scope.projectId : null;
  const isNewThread = scope.kind === "new-thread";
  const [newEnabled, setNewEnabled] = useNewThreadEnabled();

  const entry = entryFor(key);
  const subscribe = useCallback(
    (cb: () => void) => {
      const e = entryFor(key);
      e.subs.add(cb);
      return () => e.subs.delete(cb);
    },
    [key],
  );
  const snap = useSyncExternalStore(subscribe, () => entryFor(key).snap);

  // Lifetime: free the shared entry when the last user unmounts.
  useEffect(() => {
    const e = entryFor(key);
    e.refs++;
    return () => {
      if (--e.refs <= 0) {
        clearTimeout(e.timer);
        clearTimeout(e.refreshTimer);
        e.threadCall++;
        e.previewCall++;
        entries.delete(key);
      }
    };
  }, [key]);

  // Thread state: load once per (key, thread); stale replies are dropped.
  useEffect(() => {
    const e = entryFor(key);
    e.rpc = rpc;
    if (e.threadId === threadId && (e.snap.threadLoaded || threadId === null)) return;
    e.threadId = threadId;
    patch(e, { thread: null, threadLoaded: false });
    loadThread(e);
  }, [key, rpc, threadId]);

  // Preview: one debounced request per distinct input, shared across pill and popup.
  const providerId = selection?.providerId ?? null;
  const model = selection?.model ?? null;
  const effort = selection?.reasoningLevel ?? null;
  const hasDraft = text.trim() !== "";
  useEffect(() => {
    const e = entryFor(key);
    e.rpc = rpc;
    if (!hasDraft) {
      clearTimeout(e.timer);
      e.previewCall++;
      e.sig = "";
      e.params = null;
      if (e.snap.preview !== null) patch(e, { preview: null });
      return;
    }
    const params: PreviewParams = { text, providerId, model, effort, threadId, projectId };
    const sig = JSON.stringify(params);
    if (sig === e.sig) return;
    e.sig = sig;
    e.params = params;
    clearTimeout(e.timer);
    e.timer = setTimeout(() => loadPreview(e), 250);
  }, [key, rpc, hasDraft, text, providerId, model, effort, threadId, projectId]);

  const refs = useRef({ threadId });
  refs.current.threadId = threadId;
  useRealtime(DECISIONS_CHANGED, (payload) => {
    if (!matchesThread(payload, refs.current.threadId)) return;
    const e = entryFor(key);
    clearTimeout(e.refreshTimer);
    e.refreshTimer = setTimeout(() => {
      loadThread(e);
      loadPreview(e);
    }, 0);
  });

  const enabled = isNewThread ? newEnabled : (snap.thread?.enabled ?? true);
  const ready = isNewThread || (snap.threadLoaded && snap.thread !== null);

  const setEnabled = useCallback(
    async (next: boolean) => {
      if (isNewThread) {
        setNewEnabled(next); // the new-thread banner syncs the server
        return;
      }
      if (threadId === null) return;
      const e = entryFor(key);
      const prev = e.snap.thread;
      if (prev) patch(e, { thread: { ...prev, enabled: next } });
      const call = ++e.threadCall;
      try {
        const result = await rpc.call("setThreadEnabled", { threadId, enabled: next });
        if (call === e.threadCall && result.threadId === threadId) patch(e, { thread: result });
      } catch {
        if (prev) patch(e, { thread: prev });
        loadThread(e);
      }
    },
    [isNewThread, setNewEnabled, key, rpc, threadId],
  );

  void entry;
  return { enabled, ready, preview: snap.preview, thread: snap.thread, hasDraft, setEnabled, isNewThread };
}
