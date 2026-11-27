// Pure: one plain edit of the effective policy ("bb gearshift policy set <path> <value>").
// The caller diffs the result against the defaults and stores it through the same path as the editor's Save.
import { TIERS, mergePolicy, removeOverridePath, validatePolicy, type Policy, type PolicyOverrides, type Tier } from "./policy";

export type PolicyEdit =
  | { op: "set"; path: string; value: string }
  | { op: "unset"; path: string }
  | { op: "add-pattern"; classId: string; pattern: string }
  | { op: "remove-pattern"; classId: string; pattern: string };

export interface PolicyEditError { error: string }
export interface PolicyEditResult { policy: Policy; path: string; before: string; after: string }

/** Plain pattern lists that add-pattern / remove-pattern can edit besides a scoring class's own patterns. */
const PATTERN_LISTS: Record<string, (p: Policy) => string[]> = {
  "scoring.trivial.patterns": (p) => p.scoring.trivial.patterns,
  "scoring.trivial.leading": (p) => p.scoring.trivial.leading,
  "scoring.continuation.patterns": (p) => p.scoring.continuation.patterns,
  "scoring.question.patterns": (p) => p.scoring.question.patterns,
  skipPatterns: (p) => p.skipPatterns,
};
const listNames = () => Object.keys(PATTERN_LISTS).join(", ");

/** The path grammar, for help text and error messages. */
export const POLICY_PATHS = [
  "tiers.<tier>.min | max",
  "gears.<providerId|*>.<tier>.model | effort | serviceTier",
  "scoring.classes.<classId>.enabled | floor | add",
  "scoring.question.score",
  "scoring.trivial.maxChars",
  "scoring.continuation.maxChars",
  "scoring.components.addPerExtraGroup | cap",
  "scoring.files.atLeast | add | pattern",
  "scoring.length.<index>.overChars | add",
  "scoring.unmatchedScore",
  "explicitModel.enabled | pattern",
  "roles.<role>.budget.<tier>",
  `(add-pattern | remove-pattern) <target> <regex>, where <target> is a scoring class id or one of: ${listNames()}`,
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
  if (s[0] === "scoring" && s[1] === "files" && s.length === 3 && s[2] === "pattern") return scalar((p) => p.scoring.files as unknown as Record<string, unknown>, "pattern", "string");
  if (s[0] === "explicitModel" && s.length === 2 && (s[1] === "enabled" || s[1] === "pattern")) {
    return scalar((p) => p.explicitModel as unknown as Record<string, unknown>, s[1], s[1] === "enabled" ? "boolean" : "string");
  }
  if (s[0] === "scoring" && s[1] === "length" && s.length >= 4 && (s[s.length - 1] === "overChars" || s[s.length - 1] === "add")) {
    const rawIndex = s.slice(2, -1).join("."), k = s[s.length - 1] as "overChars" | "add";
    if (!/^\d+$/.test(rawIndex)) return bad(`scoring.length index must be a whole number from 0, got "${rawIndex}"`);
    const i = Number(rawIndex);
    return {
      kind: "number", optional: false,
      read: (p) => p.scoring.length[i]?.[k],
      write: (p, v) => {
        const rule = p.scoring.length[i];
        if (!rule) {
          const rules = p.scoring.length.map((r, n) => `${n}: over ${r.overChars} chars +${r.add}`).join(", ");
          return `No length rule at index ${i}. Rules: ${rules || "(none)"}`;
        }
        if (v === undefined) return `The defaults have no length rule at index ${i}`;
        rule[k] = v as number;
        return null;
      },
    };
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
    const listOf = Object.hasOwn(PATTERN_LISTS, edit.classId) ? PATTERN_LISTS[edit.classId] : undefined;
    const c = listOf ? undefined : next.scoring.classes.find((x) => x.id === edit.classId);
    if (!listOf && !c) return bad(`Unknown scoring class or pattern list "${edit.classId}". Lists: ${listNames()}. Classes: ${next.scoring.classes.map((x) => x.id).join(", ")}`);
    const list = listOf ? listOf(next) : c!.patterns;
    const label = listOf ? `List "${edit.classId}"` : `Class "${edit.classId}"`;
    path = listOf ? edit.classId : `scoring.classes.${edit.classId}.patterns`;
    if (!edit.pattern.trim()) return bad("The pattern cannot be empty");
    before = `${list.length} patterns`;
    if (edit.op === "add-pattern") {
      if (list.includes(edit.pattern)) return bad(`${label} already has that pattern`);
      list.push(edit.pattern);
    } else {
      const at = list.indexOf(edit.pattern);
      if (at < 0) return bad(`${label} has no such pattern. Patterns:\n  ${list.join("\n  ")}`);
      list.splice(at, 1);
    }
    after = `${list.length} patterns (${edit.op === "add-pattern" ? "+" : "-"} ${edit.pattern})`;
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

/** The override subtrees that `unset` can remove as a whole, for help text and error messages. */
export const UNSET_SUBTREE_PATHS = [
  "roles.<role>",
  "teams.<tier>",
  "gears.<providerId|*>",
  "gears.<providerId>.<tier>",
] as const;

/**
 * A path that names a whole override subtree (a role, a team, a gears entry) instead of one leaf value.
 * Only the shape is checked: whether anything is overridden there is up to `unsetOverrideSubtree`.
 */
export function isSubtreePath(path: string): boolean {
  const s = path.trim().split(".");
  if (s.some((x) => x === "")) return false;
  if (s[0] === "roles") return s.length === 2;
  if (s[0] === "teams") return s.length === 2 && isTier(s[1]!);
  if (s[0] === "gears") return s.length === 2 || (s.length === 3 && isTier(s[2]!));
  return false;
}

export interface SubtreeUnsetResult { overrides: PolicyOverrides; policy: Policy; path: string; before: string; after: string }

const getIn = (node: unknown, parts: string[]): unknown => {
  let cur: unknown = node;
  for (const k of parts) {
    if (!cur || typeof cur !== "object" || Array.isArray(cur) || !Object.hasOwn(cur, k)) return undefined;
    cur = (cur as Record<string, unknown>)[k];
  }
  return cur;
};
const hasIn = (node: unknown, parts: string[]): boolean => {
  const parent = getIn(node, parts.slice(0, -1));
  return !!parent && typeof parent === "object" && !Array.isArray(parent) && Object.hasOwn(parent, parts[parts.length - 1]!);
};

/**
 * Remove the saved override at `roles.<role>`, `teams.<tier>`, `gears.<providerId|*>` or `gears.<providerId>.<tier>`,
 * so that part of the policy falls back to the defaults (a custom role or gears row disappears).
 * Errors when the path is not one of those shapes, when nothing is overridden there, and when the policy that would be
 * left does not validate (for example a custom role that a team override still lists).
 */
export function unsetOverrideSubtree(overrides: PolicyOverrides, defaults: Policy, rawPath: string): SubtreeUnsetResult | PolicyEditError {
  const path = rawPath.trim();
  if (!isSubtreePath(path)) return bad(`Cannot unset "${path}" as a whole. Valid shapes:\n  ${UNSET_SUBTREE_PATHS.join("\n  ")}`);
  const parts = path.split(".");
  if (!hasIn(overrides, parts)) return bad(`There is no override at "${path}", so there is nothing to unset.`);
  const nextOverrides = removeOverridePath(overrides, path);
  const policy = mergePolicy(defaults, nextOverrides);
  const errors = validatePolicy(policy);
  if (errors.length) {
    const teams = [...new Set(errors.flatMap((e) => /^teams\.([a-z]+)\.roles$/.exec(e.path)?.[1] ?? []))];
    const signals = [...new Set(errors.filter((e) => e.path.startsWith("signalRoles.")).map((e) => e.path))];
    const hints = [
      teams.length ? `Unset ${teams.map((t) => `teams.${t}`).join(" and ")} first.` : "",
      signals.length ? `Remove the role from ${signals.join(" and ")} first.` : "",
    ].filter(Boolean);
    const hint = hints.length ? ` ${hints.join(" ")}` : "";
    return bad(`Cannot unset "${path}": ${errors.map((e) => `${e.path}: ${e.message}`).join("; ")}.${hint}`);
  }
  const fallsBack = getIn(defaults, parts) !== undefined;
  return { overrides: nextOverrides, policy, path, before: "overridden", after: fallsBack ? "default" : "removed" };
}
