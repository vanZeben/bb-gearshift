// Data-driven additive scorer: how much work does a message ask for?
//
// Pure and synchronous: (text, compiled policy) -> classification, in well under a
// millisecond, so it runs on the dispatch hot path and live in the composer as the user
// types. No LLM call. Every rule lives in the policy (lib/policy.ts), none in code.
import { TIERS, type CompiledPolicy, type Tier } from "./policy";

export { TIERS };
export type { Tier };

export type Confidence = "low" | "medium" | "high";

export interface Contribution {
  id: string;
  label: string;
  kind: "floor" | "add" | "base" | "bonus";
  value: number;
  match: string | null;
}

export interface Classification {
  tier: Tier;
  score: number;
  confidence: Confidence;
  /** The first four contribution labels. */
  signals: string[];
  /** How the score was built, in the order applied. */
  contributions: Contribution[];
  /** The message asked to keep going ("continue", "go ahead"): hold the current gear. */
  continuation: boolean;
  /** A model family the message names ("use opus", "with haiku"), lower-case. */
  requestedFamily: string | null;
  /** Characters of the human's own words that were scored. */
  chars: number;
  /** A system/harness message matched a skip pattern: never routed. */
  skip: boolean;
}

export function tierForScore(score: number, tiers: CompiledPolicy["policy"]["tiers"]): Tier {
  for (const tier of TIERS) if (score >= tiers[tier].min && score <= tiers[tier].max) return tier;
  return score < 0 ? "trivial" : "xlarge";
}

export function tierIndex(tier: Tier): number {
  return TIERS.indexOf(tier);
}

// ---------------------------------------------------------------------------
// Envelope: bb and other agents wrap text around what a person typed. Only the
// person's words are scored.

const ATTACHMENT_LINE = /^[ \t]*\[(?:Attached (?:image|file)[^\n]*|Image: original[^\n]*)\][ \t]*$/gim;
const LEADING_TAG = /^\s*\[(?:bb message from thread:|forwarded from thread:|via\s)[^\]\n]*\]\s*/i;

/** Replace every `<open ...>...</close>` span. Linear: an unclosed opener ends the scan instead of rescanning to the end. */
function replaceSpans(text: string, open: string, close: string, fn: (inner: string) => string): string {
  let out = "";
  let at = 0;
  for (;;) {
    const o = text.indexOf(open, at);
    if (o < 0) break;
    const gt = text.indexOf(">", o + open.length);
    const c = text.indexOf(close, gt < 0 ? o : gt);
    if (c < 0) break;
    const cEnd = text.indexOf(">", c + close.length);
    if (gt < 0 || cEnd < 0) break;
    out += text.slice(at, o) + fn(text.slice(gt + 1, c));
    at = cEnd + 1;
  }
  return out + text.slice(at);
}

/** The human's own words: bb envelopes, reminders and attachment notes removed. */
export function humanText(raw: string): string {
  let text = String(raw ?? "");
  text = replaceSpans(text, "<system-reminder", "</system-reminder", () => " ");
  text = text.replace(ATTACHMENT_LINE, " ");
  // Pasted material is context, not the ask: keep a size stub.
  text = replaceSpans(text, "<pasted_content", "</pasted_content", (body) => ` [pasted ${body.length} chars] `);
  for (let i = 0; i < 3 && LEADING_TAG.test(text); i++) text = text.replace(LEADING_TAG, "");
  return text.trim();
}

/** Patterns only ever see this much text, so a hostile or huge message cannot stall the dispatch hook. */
export const SKIP_SCAN_CHARS = 2_000;
export const SCORE_SCAN_CHARS = 8_000;

const PASTED_STUB = /\[pasted \d+ chars\]/g;
const snip = (s: string) => (s.length > 40 ? `${s.slice(0, 40)}...` : s);
const first = (res: RegExp[], text: string): RegExpExecArray | null => {
  for (const re of res) { const m = re.exec(text); if (m) return m; }
  return null;
};

export function classify(raw: string, cp: CompiledPolicy): Classification {
  const p = cp.policy;
  const base = { requestedFamily: null as string | null, continuation: false, skip: false };
  const result = (score: number, confidence: Confidence, contributions: Contribution[], chars: number, extra: Partial<Classification> = {}): Classification => ({
    tier: tierForScore(score, p.tiers), score, confidence, contributions, signals: contributions.slice(0, 4).map((c) => c.label), chars, ...base, ...extra,
  });

  const text = String(raw ?? "");
  const head = text.slice(0, SKIP_SCAN_CHARS);
  if (cp.skip.some((re) => re.test(head))) {
    return result(0, "high", [], 0, { skip: true });
  }

  const full = humanText(text).replace(PASTED_STUB, " ").replace(/\s+/g, " ").trim();
  const len = full.length; // length rules use the whole message
  const body = full.length > SCORE_SCAN_CHARS ? full.slice(0, SCORE_SCAN_CHARS) : full;
  const em = cp.explicit ? cp.explicit.exec(body) : null;
  const requestedFamily = em?.[1] ? em[1].toLowerCase().replace(/^claude[- ]/, "") : null;
  const ex = { requestedFamily };

  if (len === 0) return result(0, "high", [{ id: "empty", label: "empty", kind: "base", value: 0, match: null }], 0, ex);

  if (len <= cp.continuation.maxChars) {
    const m = first(cp.continuation.patterns, body);
    if (m) return result(p.scoring.unmatchedScore, "low", [{ id: "continuation", label: "continuation", kind: "base", value: p.scoring.unmatchedScore, match: snip(m[0]) }], len, { ...ex, continuation: true });
  }
  if (len <= cp.trivial.maxChars) {
    const m = first(cp.trivial.patterns, body);
    if (m) return result(0, "high", [{ id: "trivial", label: "acknowledgement", kind: "base", value: 0, match: snip(m[0]) }], len, ex);
  }

  const matched = cp.classes.flatMap((c) => {
    const m = first(c.patterns, body);
    return m ? [{ c, m }] : [];
  });
  const contributions: Contribution[] = [];
  const floorHit = matched.filter((x) => x.c.floor !== undefined).reduce<(typeof matched)[number] | null>((best, x) => (!best || x.c.floor! > best.c.floor! ? x : best), null);
  const questionHit = floorHit ? null : first(cp.question.patterns, body);
  let start: number;
  if (floorHit) {
    start = floorHit.c.floor!;
    contributions.push({ id: floorHit.c.id, label: floorHit.c.label, kind: "floor", value: start, match: snip(floorHit.m[0]) });
  } else if (questionHit) {
    start = cp.question.score;
    contributions.push({ id: "question", label: "question", kind: "base", value: start, match: snip(questionHit[0]) });
  } else {
    start = p.scoring.unmatchedScore;
    contributions.push({ id: "unmatched", label: "no clear signals", kind: "base", value: start, match: null });
  }
  let total = start;
  for (const { c, m } of matched) {
    if (c.add === undefined || c.add === 0) continue;
    total += c.add;
    contributions.push({ id: c.id, label: c.label, kind: "add", value: c.add, match: snip(m[0]) });
  }

  const hitGroups = cp.groups.filter((g) => g.re.test(body));
  const compBonus = Math.min(p.scoring.components.cap, Math.max(0, hitGroups.length - 1) * p.scoring.components.addPerExtraGroup);
  if (compBonus > 0) {
    total += compBonus;
    contributions.push({ id: "components", label: `${hitGroups.length} areas`, kind: "bonus", value: compBonus, match: hitGroups.map((g) => g.id).join(", ") });
  }

  const files = new Set(body.match(cp.files.re) ?? []);
  if (files.size >= cp.files.atLeast && cp.files.add > 0) {
    total += cp.files.add;
    contributions.push({ id: "files", label: `${files.size} files`, kind: "bonus", value: cp.files.add, match: null });
  }

  const lengthAdd = p.scoring.length.filter((r) => len > r.overChars).reduce((m, r) => Math.max(m, r.add), 0);
  if (lengthAdd > 0) {
    total += lengthAdd;
    contributions.push({ id: "length", label: "long brief", kind: "bonus", value: lengthAdd, match: null });
  }

  const score = Math.max(0, Math.min(p.tiers.xlarge.max, total));
  const tier = tierForScore(score, p.tiers);
  const { min, max } = p.tiers[tier];
  const onEdge = (score === min && tier !== TIERS[0]) || (score === max && tier !== TIERS[TIERS.length - 1]);
  const confidence: Confidence = matched.length === 0 && !questionHit ? "low" : matched.length > 0 && !onEdge ? "high" : "medium";
  return result(score, confidence, contributions, len, ex);
}
