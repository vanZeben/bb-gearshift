// Pure: one plain edit of the effective policy ("bb gearshift policy set <path> <value>").
// The caller diffs the result against the defaults and stores it through the same path as the editor's Save.
import { TIERS, validatePolicy, type Policy, type Tier } from "./policy";

export type PolicyEdit =
  | { op: "set"; path: string; value: string }
  | { op: "unset"; path: string }
  | { op: "add-pattern"; classId: string; pattern: string }
  | { op: "remove-pattern"; classId: string; pattern: string };

export interface PolicyEditError { error: string }
export interface PolicyEditResult { policy: Policy; path: string; before: string; after: string }

/** The path grammar, for help text and error messages. */
export const POLICY_PATHS = [
  "tiers.<tier>.min | max",
  "gears.<providerId|*>.<tier>.model | effort | serviceTier",
  "scoring.classes.<classId>.enabled | floor | add",
  "scoring.question.score",
  "scoring.trivial.maxChars",
  "scoring.continuation.maxChars",
  "scoring.components.addPerExtraGroup | cap",
  "scoring.files.atLeast | add",
  "scoring.unmatchedScore",
  "roles.<role>.budget.<tier>",
] as const;

type Kind = "number" | "boolean" | "string";
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
const bad = (error: string): PolicyEditError => ({ error });
const validPaths = () => `Valid paths:\n  ${POLICY_PATHS.join("\n  ")}`;
const isTier = (s: string): s is Tier => (TIERS as readonly string[]).includes(s);
const show = (v: unknown) => (v === undefined || v === null ? "(default/unset)" : typeof v === "string" ? v : JSON.stringify(v));

/** A parsed path: where it lives, its value type, and whether an absent value is legal (the key is optional). */
interface Target {
  kind: Kind; optional: boolean;
  read: (p: Policy) => unknown;
  write: (p: Policy, v: unknown) => string | null; // null on success, else an error
}

function resolveTarget(path: string): Target | PolicyEditError {
  const s = path.split(".");
  const unknown = () => bad(`Unknown path "${path}". ${validPaths()}`);
  const scalar = (get: (p: Policy) => Record<string, unknown> | undefined, key: string, kind: Kind): Target => ({
    kind, optional: false,
    read: (p) => get(p)?.[key],
    write: (p, v) => { const o = get(p); if (!o) return `No such section for "${path}"`; o[key] = v; return null; },
  });
  if (s[0] === "tiers" && s.length === 3 && isTier(s[1]!) && (s[2] === "min" || s[2] === "max")) {
    const t = s[1], k = s[2];
    return scalar((p) => p.tiers[t], k, "number");
  }
  if (s[0] === "gears" && s.length === 4 && isTier(s[2]!) && ["model", "effort", "serviceTier"].includes(s[3]!)) {
    const [, pid, t, k] = s as [string, string, Tier, "model" | "effort" | "serviceTier"];
    return {
      kind: "string", optional: k !== "model",
      read: (p) => p.gears[pid]?.[t]?.[k],
      write: (p, v) => {
        const row = (p.gears[pid] ??= {});
        const gear = row[t] ?? (p.gears["*"]?.[t] ? clone(p.gears["*"][t]!) : undefined);
        if (v === undefined) {
          if (!gear) return null;
          if (k === "model") delete row[t]; else delete gear[k];
          if (gear && k !== "model") row[t] = gear;
        } else {
          if (!gear && k !== "model") return `gears.${pid}.${t} has no model yet: set gears.${pid}.${t}.model first`;
          const g = gear ?? { model: String(v) };
          (g as unknown as Record<string, unknown>)[k] = v;
          row[t] = g;
        }
        if (Object.keys(row).length === 0) delete p.gears[pid];
        return null;
      },
    };
  }
  if (s[0] === "scoring" && s[1] === "classes" && s.length === 4 && ["enabled", "floor", "add"].includes(s[3]!)) {
    const id = s[2]!, k = s[3] as "enabled" | "floor" | "add";
    return {
      kind: k === "enabled" ? "boolean" : "number", optional: true,
      read: (p) => p.scoring.classes.find((c) => c.id === id)?.[k],
      write: (p, v) => {
        const c = p.scoring.classes.find((x) => x.id === id);
        if (!c) return `Unknown scoring class "${id}". Classes: ${p.scoring.classes.map((x) => x.id).join(", ")}`;
        if (v === undefined) delete c[k]; else (c as unknown as Record<string, unknown>)[k] = v;
        return null;
      },
    };
  }
  if (s[0] === "scoring" && s.length === 3 && ((s[1] === "question" && s[2] === "score") || (s[1] === "trivial" && s[2] === "maxChars") || (s[1] === "continuation" && s[2] === "maxChars")
    || (s[1] === "components" && (s[2] === "addPerExtraGroup" || s[2] === "cap")) || (s[1] === "files" && (s[2] === "atLeast" || s[2] === "add")))) {
    const sec = s[1] as "question" | "trivial" | "continuation" | "components" | "files";
    return scalar((p) => p.scoring[sec] as unknown as Record<string, unknown>, s[2]!, "number");
  }
  if (s[0] === "scoring" && s.length === 2 && s[1] === "unmatchedScore") return scalar((p) => p.scoring as unknown as Record<string, unknown>, "unmatchedScore", "number");
  if (s[0] === "roles" && s.length === 4 && s[2] === "budget" && isTier(s[3]!)) {
    const role = s[1]!, t = s[3];
    return {
      kind: "number", optional: false,
      read: (p) => p.roles[role]?.budget[t],
      write: (p, v) => { const r = p.roles[role]; if (!r) return `Unknown role "${role}". Roles: ${Object.keys(p.roles).join(", ")}`; r.budget[t] = v as number; return null; },
    };
  }
  return unknown();
}

function parseValue(raw: string, kind: Kind, optional: boolean, path: string): { value: unknown } | PolicyEditError {
  const text = raw.trim();
  if (optional && (text === "" || text === "null")) return { value: undefined };
  if (kind === "number") {
    const n = Number(text);
    if (text === "" || !Number.isFinite(n)) return bad(`${path} takes a number, got "${raw}"`);
    return { value: n };
  }
  if (kind === "boolean") {
    if (/^(true|on|yes|1)$/i.test(text)) return { value: true };
    if (/^(false|off|no|0)$/i.test(text)) return { value: false };
    return bad(`${path} takes true or false, got "${raw}"`);
  }
  if (text === "") return bad(`${path} cannot be empty`);
  return { value: text };
}

/** Keep the five bands contiguous after tiers.<t>.min|max changed; error if a band would be empty. */
function reflowBands(p: Policy, t: Tier, k: "min" | "max"): string | null {
  const i = TIERS.indexOf(t);
  if (k === "max" && i < TIERS.length - 1) p.tiers[TIERS[i + 1]!].min = p.tiers[t].max + 1;
  if (k === "min" && i > 0) p.tiers[TIERS[i - 1]!].max = p.tiers[t].min - 1;
  if (!Number.isInteger(p.tiers[t][k])) return `${t}.${k} must be a whole number`;
  for (const x of TIERS) {
    if (p.tiers[x].max < p.tiers[x].min) return `That would leave the ${x} band empty (${p.tiers[x].min} to ${p.tiers[x].max}). Move the neighbouring band first.`;
  }
  return null;
}

/** The default value at the path, for unset. */
function defaultOf(defaults: Policy, path: string): unknown {
  const t = resolveTarget(path);
  return "error" in t ? undefined : t.read(defaults);
}

export function applyPolicyEdit(effective: Policy, defaults: Policy, edit: PolicyEdit): PolicyEditResult | PolicyEditError {
  const next = clone(effective);
  let path: string, before: string, after: string;

  if (edit.op === "add-pattern" || edit.op === "remove-pattern") {
    path = `scoring.classes.${edit.classId}.patterns`;
    const c = next.scoring.classes.find((x) => x.id === edit.classId);
    if (!c) return bad(`Unknown scoring class "${edit.classId}". Classes: ${next.scoring.classes.map((x) => x.id).join(", ")}`);
    if (!edit.pattern.trim()) return bad("The pattern cannot be empty");
    before = `${c.patterns.length} patterns`;
    if (edit.op === "add-pattern") {
      if (c.patterns.includes(edit.pattern)) return bad(`Class "${c.id}" already has that pattern`);
      c.patterns.push(edit.pattern);
    } else {
      const at = c.patterns.indexOf(edit.pattern);
      if (at < 0) return bad(`Class "${c.id}" has no such pattern. Patterns:\n  ${c.patterns.join("\n  ")}`);
      c.patterns.splice(at, 1);
    }
    after = `${c.patterns.length} patterns (${edit.op === "add-pattern" ? "+" : "-"} ${edit.pattern})`;
  } else {
    path = edit.path.trim();
    const target = resolveTarget(path);
    if ("error" in target) return target;
    before = show(target.read(effective));
    let value: unknown;
    if (edit.op === "unset") {
      value = defaultOf(defaults, path);
    } else {
      const parsed = parseValue(edit.value, target.kind, target.optional, path);
      if ("error" in parsed) return parsed;
      value = parsed.value;
    }
    const err = target.write(next, value);
    if (err) return bad(err);
    const tm = /^tiers\.([a-z]+)\.(min|max)$/.exec(path);
    if (tm) { const e = reflowBands(next, tm[1] as Tier, tm[2] as "min" | "max"); if (e) return bad(e); }
    after = show(target.read(next));
  }

  const errors = validatePolicy(next);
  if (errors.length) return bad(errors.map((e) => `${e.path}: ${e.message}`).join("; "));
  return { policy: next, path, before, after };
}
