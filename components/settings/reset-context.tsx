import { createContext, useContext } from "react";

export interface Resetter {
  reset: (paths: readonly string[] | null) => void;
  busy: boolean;
}
export const ResetContext = createContext<{ reset: Resetter["reset"]; busy: boolean }>({ reset: () => {}, busy: false });
export function useResetter(): { reset: Resetter["reset"]; busy: boolean } {
  return useContext(ResetContext);
}
