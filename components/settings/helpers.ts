// Pure helpers for the policy editor: immutable path edits, change detection,
// error lookup, pattern-list edits and tier-band editing. No React, no RPC.

export type Path = ReadonlyArray<string | number>;
export const TIER_ORDER = ["trivial", "small", "medium", "large", "xlarge"] as const;
export type TierName = (typeof TIER_ORDER)[number];

export interface PolicyIssue {
  path: string;
  message: string;
}

type Json = unknown;

function isObject(value: Json): value is Record<string, Json> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function getAt(root: Json, path: Path): Json {
  let cur: Json = root;
  for (const key of path) {
    if (Array.isArray(cur) && typeof key === "number") cur = cur[key];
    else if (isObject(cur)) cur = cur[String(key)];
    else return undefined;
  }
  return cur;
}

/** Immutable set. Missing containers are created (arrays for number keys). */
export function setAt<T>(root: T, path: Path, value: Json): T {
  if (path.length === 0) return value as T;
  const [head, ...rest] = path as [string | number, ...Array<string | number>];
  if (typeof head === "number") {
    const arr = Array.isArray(root) ? [...root] : [];
    arr[head] = setAt(arr[head], rest, value);
    return arr as T;
  }
  const obj: Record<string, Json> = isObject(root) ? { ...root } : {};
  obj[head] = setAt(obj[head], rest, value);
  return obj as T;
}

/** Immutable delete; empty parent objects left behind are pruned (but never the root). */
export function delAt<T>(root: T, path: Path): T {
  if (path.length === 0) return root;
  const [head, ...rest] = path as [string | number, ...Array<string | number>];
  if (typeof head === "number") {
    if (!Array.isArray(root)) return root;
    const arr = [...root];
    if (rest.length === 0) arr.splice(head, 1);
    else arr[head] = delAt(arr[head], rest);
    return arr as T;
  }
  if (!isObject(root)) return root;
  const obj: Record<string, Json> = { ...root };
  if (rest.length === 0) delete obj[head];
  else {
    const child = delAt(obj[head], rest);
    if (isObject(child) && Object.keys(child).length === 0) delete obj[head];
    else obj[head] = child;
  }
  return obj as T;
}

export function isEqual(a: Json, b: Json): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b || a === null || b === null) return false;
  if (Array.isArray(a)) {
    return Array.isArray(b) && a.length === b.length && a.every((v, i) => isEqual(v, b[i]));
  }
  if (isObject(a) && isObject(b)) {
    const ka = Object.keys(a);
    const kb = Object.keys(b);
    return ka.length === kb.length && ka.every((k) => k in b && isEqual(a[k], b[k]));
  }
  return false;
}

/* ---- Class-aware paths: classes are an array in the draft but merge by id ---- */

function classIdAt(draft: Json, path: Path): string | null {
  if (path[0] === "scoring" && path[1] === "classes" && typeof path[2] === "number") {
    const id = getAt(draft, path.slice(0, 3));
    return isObject(id) && typeof id.id === "string" ? id.id : null;
  }
  return null;
}

/** Dotted path as the server reports errors: `scoring.classes[large].patterns[2]`. */
export function pathToString(draft: Json, path: Path): string {
  const id = classIdAt(draft, path);
  let out = "";
  path.forEach((seg, i) => {
    if (id !== null && i === 2) out += `[${id}]`;
    else if (typeof seg === "number") out += `[${seg}]`;
    else out += out === "" ? seg : `.${seg}`;
  });
  return out;
}

/** The default value at `path` (class entries are matched by id). Undefined when the default has none. */
export function defaultAt(defaults: Json, draft: Json, path: Path): Json {
  const id = classIdAt(draft, path);
  if (id !== null) {
    const list = getAt(defaults, ["scoring", "classes"]);
    const idx = Array.isArray(list) ? list.findIndex((c) => isObject(c) && c.id === id) : -1;
    if (idx < 0) return undefined;
    return getAt(defaults, ["scoring", "classes", idx, ...path.slice(3)]);
  }
  return getAt(defaults, path);
}

export function isChanged(defaults: Json, draft: Json, path: Path): boolean {
  return !isEqual(getAt(draft, path), defaultAt(defaults, draft, path));
}

/** Put the default back at `path`; removes the entry when the default has none. */
export function revertAt<T>(defaults: Json, draft: T, path: Path): T {
  const def = defaultAt(defaults, draft, path);
  const id = classIdAt(draft, path);
  if (path.length === 3 && id !== null && def === undefined) return delAt(draft, path); // custom class
  return def === undefined ? delAt(draft, path) : setAt(draft, path, structuredCloneJson(def));
}

export function structuredCloneJson<T>(value: T): T {
  return value === undefined ? value : (JSON.parse(JSON.stringify(value)) as T);
}

/* ---- Errors ---- */

export function matchesPath(errorPath: string, prefix: string): boolean {
  return (
    errorPath === prefix ||
    errorPath.startsWith(`${prefix}.`) ||
    errorPath.startsWith(`${prefix}[`)
  );
}

export function issuesUnder(issues: readonly PolicyIssue[], prefix: string): PolicyIssue[] {
  return issues.filter((e) => matchesPath(e.path, prefix));
}

export function issuesUnderAny(issues: readonly PolicyIssue[], prefixes: readonly string[]): PolicyIssue[] {
  return issues.filter((e) => prefixes.some((p) => matchesPath(e.path, p)));
}

/** Compile error for a regex source as the editor runs it (case-insensitive), or null. */
export function regexError(source: string): string | null {
  try {
    new RegExp(source, /[^\x00-\x7f]/.test(source) ? "iu" : "i");
    return null;
  } catch (err) {
    return err instanceof Error ? err.message.replace(/^Invalid regular expression: /, "") : "Invalid regular expression";
  }
}

/* ---- Pattern lists ---- */

export function listUpdate(list: readonly string[], index: number, value: string): string[] {
  return list.map((item, i) => (i === index ? value : item));
}
export function listRemove(list: readonly string[], index: number): string[] {
  return list.filter((_, i) => i !== index);
}
export function listAdd(list: readonly string[], value = ""): string[] {
  return [...list, value];
}
export function listMove(list: readonly string[], index: number, delta: -1 | 1): string[] {
  const to = index + delta;
  if (to < 0 || to >= list.length) return [...list];
  const next = [...list];
  const [item] = next.splice(index, 1);
  next.splice(to, 0, item as string);
  return next;
}

/* ---- Tier bands ---- */

export type Bands = Record<TierName, { min: number; max: number }>;

/** Set a tier's upper bound and keep the bands contiguous (the next tier starts right after). */
export function setBandMax(bands: Bands, tier: TierName, max: number): Bands {
  const next: Bands = structuredCloneJson(bands);
  const idx = TIER_ORDER.indexOf(tier);
  next[tier].max = max;
  const following = TIER_ORDER[idx + 1];
  if (following) next[following].min = max + 1;
  return next;
}

/* ---- Record rows (component groups) ---- */

/** Rename a key while keeping its position. Returns the original when the new key is empty or taken. */
export function renameKey<V>(rec: Record<string, V>, from: string, to: string): Record<string, V> {
  if (from === to || to.trim() === "" || to in rec) return rec;
  const out: Record<string, V> = {};
  for (const [k, v] of Object.entries(rec)) out[k === from ? to : k] = v;
  return out;
}

/** A key not yet in `rec`: base, base-2, base-3 … */
export function uniqueKey(rec: Record<string, unknown>, base: string): string {
  if (!(base in rec)) return base;
  let n = 2;
  while (`${base}-${n}` in rec) n++;
  return `${base}-${n}`;
}

/** Drop empty per-provider gear maps so they never leak into the diff. */
export function pruneGears<T extends { gears: Record<string, Record<string, unknown>> }>(policy: T): T {
  const gears: Record<string, Record<string, unknown>> = {};
  for (const [k, v] of Object.entries(policy.gears)) if (Object.keys(v).length > 0) gears[k] = v;
  return { ...policy, gears };
}
