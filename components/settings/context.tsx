import { createContext, useContext } from "react";
import type { Policy } from "@/lib/policy";
import type { ProvidersDto } from "@/lib/contract";
import type { Path, PolicyIssue } from "./helpers";

export interface EditorCtx {
  draft: Policy;
  defaults: Policy;
  issues: readonly PolicyIssue[];
  providers: ProvidersDto["providers"] | null;
  /** Write a value at a path in the draft. */
  set: (path: Path, value: unknown) => void;
  /** Update the whole draft. */
  update: (fn: (prev: Policy) => Policy) => void;
  /** Restore the default at a path (or remove the entry when the default has none). */
  revert: (path: Path) => void;
}

export const EditorContext = createContext<EditorCtx | null>(null);

export function useEditor(): EditorCtx {
  const ctx = useContext(EditorContext);
  if (ctx === null) throw new Error("useEditor must be used inside the policy editor");
  return ctx;
}
