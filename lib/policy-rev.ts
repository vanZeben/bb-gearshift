// Pure: a short, stable fingerprint of an effective policy, stamped on each decision so a review
// can tell which gears were chosen under an earlier policy. SDK- and node-free (FNV-1a over sorted JSON).
import type { Policy } from "./policy";

function sorted(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sorted);
  if (v && typeof v === "object") return Object.fromEntries(Object.keys(v as object).sort().map((k) => [k, sorted((v as Record<string, unknown>)[k])]));
  return v;
}

/** 8 hex characters; equal policies (key order aside) give equal revs. */
export function policyRev(policy: Policy): string {
  const s = JSON.stringify(sorted(policy));
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return h.toString(16).padStart(8, "0");
}
