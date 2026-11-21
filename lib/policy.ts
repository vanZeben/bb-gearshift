// The routing policy: one document that drives scoring, gears, prices and routing switches.
// Defaults ship in code; a user's policy is only their overrides, merged on top (docs/DESIGN.md "Policy").
import { z } from "zod";

export const TIERS = ["trivial", "small", "medium", "large", "xlarge"] as const;
export type Tier = (typeof TIERS)[number];

export interface GearSpec {
  /** Exact model id, a family word in the model's name ("sonnet", "mini"), "@default", or "@small" | "@medium" | "@large". */
  model: string;
  /** Wanted reasoning level, clamped to the model's. Omit to keep the composer's. */
  effort?: string;
  /** Provider service tier ("default", "fast", ...). Omit to keep the composer's. Only applied when the model lists it. */
  serviceTier?: string;
}

/** A sub-agent role's gear: a GearSpec that may run on another provider than the parent thread. */
export interface RoleGearSpec extends GearSpec {
  /** Run the sub-agent on this provider instead of the parent's. */
  providerId?: string;
  /** Reasoning level used from the medium tier up (overrides `effort` there). */
  effortMediumUp?: string;
}
export interface RoleSpec {
  /** Keyed by the parent thread's provider id; "*" is the fallback. */
  gears: Record<string, RoleGearSpec>;
  /** Spend-token budget per tier: input + cache writes + output + 0.1 x cache reads. */
  budget: Record<Tier, number>;
}
export interface TeamSpec { summary: string; roles: string[] }

export interface Price {
  input: number; // USD per million tokens
  output: number;
  cacheRead?: number; // default input x 0.1
  cacheWrite?: number; // default input x 1.25
}

export interface ScoreClass {
  id: string; // stable key; overrides merge by id
  label: string; // shown as the signal ("large build")
  patterns: string[]; // JS regex sources, matched case-insensitively against the message
  floor?: number; // the score starts at least here when matched
  add?: number; // added to the score when matched
  enabled?: boolean; // default true; false disables a default class
}

export interface Policy {
  version: 1;
  tiers: Record<Tier, { min: number; max: number }>;
  gears: Record<string, Partial<Record<Tier, GearSpec>>>;
  prices: Record<string, Price>;
  serviceTierMultipliers: Record<string, number>;
  baselineModel: string | null;
  routing: { defaultOn: boolean; respectManualPicks: boolean; routeAgentMessages: boolean; holdAboveTokens: number; routeNotes: boolean };
  teams: Record<Tier, TeamSpec>;
  roles: Record<string, RoleSpec>;
  /** Scoring class id -> roles that join the tier's team when that class contributed to the score. */
  signalRoles: Record<string, string[]>;
  scoring: {
    trivial: { maxChars: number; patterns: string[]; leading: string[] };
    continuation: { maxChars: number; patterns: string[] };
    question: { score: number; patterns: string[] };
    classes: ScoreClass[];
    components: { addPerExtraGroup: number; cap: number; groups: Record<string, string> };
    files: { pattern: string; atLeast: number; add: number };
    length: Array<{ overChars: number; add: number }>;
    unmatchedScore: number;
  };
  explicitModel: { enabled: boolean; pattern: string };
  skipPatterns: string[];
}

export type PolicyOverrides = Record<string, unknown>;
export interface PolicyError { path: string; message: string }

const nonNeg = z.number().finite().min(0);
const score = z.number().finite().min(0).max(100);
const tierEnum = z.enum(TIERS);
const gearSpecSchema = z.object({ model: z.string().min(1), effort: z.string().optional(), serviceTier: z.string().optional() });
const roleGearSchema = gearSpecSchema.extend({ providerId: z.string().min(1).optional(), effortMediumUp: z.string().optional() });
const budgetSchema = z.object({ trivial: nonNeg, small: nonNeg, medium: nonNeg, large: nonNeg, xlarge: nonNeg });
const priceSchema = z.object({ input: nonNeg, output: nonNeg, cacheRead: nonNeg.optional(), cacheWrite: nonNeg.optional() });
const patterns = z.array(z.string());
function teamSchema() { return z.object({ summary: z.string(), roles: z.array(z.string().min(1)) }); }
const band = z.object({ min: nonNeg, max: nonNeg });

export const policySchema: z.ZodType<Policy> = z.object({
  version: z.literal(1),
  tiers: z.object({ trivial: band, small: band, medium: band, large: band, xlarge: band }),
  gears: z.record(z.string(), z.partialRecord(tierEnum, gearSpecSchema)),
  prices: z.record(z.string(), priceSchema),
  serviceTierMultipliers: z.record(z.string(), nonNeg),
  baselineModel: z.string().nullable(),
  routing: z.object({ defaultOn: z.boolean(), respectManualPicks: z.boolean(), routeAgentMessages: z.boolean(), holdAboveTokens: nonNeg, routeNotes: z.boolean() }),
  teams: z.object({ trivial: teamSchema(), small: teamSchema(), medium: teamSchema(), large: teamSchema(), xlarge: teamSchema() }),
  roles: z.record(z.string(), z.object({ gears: z.record(z.string(), roleGearSchema), budget: budgetSchema })),
  signalRoles: z.record(z.string(), z.array(z.string().min(1))),
  scoring: z.object({
    trivial: z.object({ maxChars: nonNeg, patterns, leading: patterns }),
    continuation: z.object({ maxChars: nonNeg, patterns }),
    question: z.object({ score, patterns }),
    classes: z.array(z.object({ id: z.string().min(1), label: z.string(), patterns, floor: score.optional(), add: score.optional(), enabled: z.boolean().optional() })),
    components: z.object({ addPerExtraGroup: nonNeg, cap: nonNeg, groups: z.record(z.string(), z.string()) }),
    files: z.object({ pattern: z.string(), atLeast: nonNeg, add: nonNeg }),
    length: z.array(z.object({ overChars: nonNeg, add: nonNeg })),
    unmatchedScore: score,
  }),
  explicitModel: z.object({ enabled: z.boolean(), pattern: z.string() }),
  skipPatterns: patterns,
}) as unknown as z.ZodType<Policy>;

/** Any JSON object; whether it merges into a valid policy is checked by validatePolicy. */
export const policyOverridesSchema = z.record(z.string(), z.unknown());

// ---------------------------------------------------------------------------
// Defaults (docs/DESIGN.md "Default policy")

const DEFAULT_TEAMS: Record<Tier, TeamSpec> = {
  trivial: { summary: "answer directly, no sub-agents", roles: [] },
  small: { summary: "one implementer, run tests directly", roles: ["implement"] },
  medium: { summary: "implementers on disjoint files + qa + verify", roles: ["implement", "qa", "verify"] },
  large: { summary: "implementers; qa; review of the diff", roles: ["implement", "qa", "review"] },
  xlarge: { summary: "architecture plans first, then the large team", roles: ["architecture", "implement", "qa", "review"] },
};
const budgets = (trivial: number, small: number, medium: number, large: number, xlarge: number): Record<Tier, number> => ({ trivial, small, medium, large, xlarge });
const role = (claude: RoleGearSpec, star: RoleGearSpec, budget: Record<Tier, number>): RoleSpec => ({ gears: { "claude-code": claude, "*": star }, budget });
const DEFAULT_ROLES: Record<string, RoleSpec> = {
  implement: role({ model: "sonnet", effort: "medium", effortMediumUp: "high" }, { model: "@medium", effort: "medium", effortMediumUp: "high" }, budgets(80_000, 160_000, 360_000, 700_000, 1_200_000)),
  research: role({ model: "sonnet", effort: "medium" }, { model: "@medium", effort: "medium" }, budgets(80_000, 150_000, 250_000, 300_000, 350_000)),
  explore: role({ model: "haiku", effort: "medium" }, { model: "@small", effort: "medium" }, budgets(100_000, 150_000, 250_000, 250_000, 250_000)),
  qa: role({ model: "haiku", effort: "low" }, { model: "@small", effort: "low" }, budgets(60_000, 80_000, 120_000, 150_000, 150_000)),
  verify: role({ model: "haiku", effort: "medium" }, { model: "@small", effort: "medium" }, budgets(60_000, 80_000, 120_000, 150_000, 150_000)),
  review: role({ model: "opus", effort: "medium" }, { model: "@large", effort: "medium" }, budgets(100_000, 150_000, 250_000, 300_000, 300_000)),
  architecture: role({ model: "fable", effort: "high" }, { model: "@large", effort: "high" }, budgets(450_000, 450_000, 450_000, 500_000, 550_000)),
};

export const DEFAULT_POLICY: Policy = {
  "version": 1,
  "tiers": {
    "trivial": {
      "min": 0,
      "max": 2
    },
    "small": {
      "min": 3,
      "max": 5
    },
    "medium": {
      "min": 6,
      "max": 8
    },
    "large": {
      "min": 9,
      "max": 11
    },
    "xlarge": {
      "min": 12,
      "max": 14
    }
  },
  "gears": {
    "*": {
      "trivial": {
        "model": "@small",
        "effort": "low"
      },
      "small": {
        "model": "@small",
        "effort": "medium"
      },
      "medium": {
        "model": "@medium",
        "effort": "medium"
      },
      "large": {
        "model": "@large",
        "effort": "high"
      },
      "xlarge": {
        "model": "@large",
        "effort": "xhigh"
      }
    },
    "claude-code": {
      "trivial": {
        "model": "haiku",
        "effort": "low"
      },
      "small": {
        "model": "sonnet",
        "effort": "medium"
      },
      "medium": {
        "model": "sonnet",
        "effort": "high"
      },
      "large": {
        "model": "opus",
        "effort": "high"
      },
      "xlarge": {
        "model": "opus",
        "effort": "xhigh"
      }
    },
    "codex": {
      "trivial": {
        "model": "@small",
        "effort": "low"
      },
      "small": {
        "model": "@small",
        "effort": "medium"
      },
      "medium": {
        "model": "@default",
        "effort": "medium"
      },
      "large": {
        "model": "@default",
        "effort": "high"
      },
      "xlarge": {
        "model": "@default",
        "effort": "xhigh"
      }
    }
  },
  "prices": {
    "claude-fable-5-2": {
      "input": 8,
      "output": 40,
      "cacheRead": 0.2
    },
    "claude-mythos-5-2": {
      "input": 8,
      "output": 40,
      "cacheRead": 0.2
    },
    "claude-fable-5-1": {
      "input": 10,
      "output": 50
    },
    "claude-fable-5": {
      "input": 10,
      "output": 50
    },
    "claude-opus-5-5": {
      "input": 4,
      "output": 20,
      "cacheRead": 0.2
    },
    "claude-opus-5": {
      "input": 5,
      "output": 25
    },
    "claude-opus-4": {
      "input": 5,
      "output": 25
    },
    "claude-sonnet-5-5": {
      "input": 2,
      "output": 10,
      "cacheRead": 0.1
    },
    "claude-sonnet-5": {
      "input": 2,
      "output": 10
    },
    "claude-sonnet-4-6": {
      "input": 3,
      "output": 15
    },
    "claude-haiku-5-5": {
      "input": 0.1,
      "output": 0.5
    },
    "claude-haiku-4-5": {
      "input": 1,
      "output": 5
    }
  },
  "serviceTierMultipliers": {
    "fast": 2
  },
  "baselineModel": null,
  "routing": {
    "defaultOn": true,
    "respectManualPicks": true,
    "routeAgentMessages": true,
    "holdAboveTokens": 60000,
    "routeNotes": true
  },
  "teams": DEFAULT_TEAMS,
  "roles": DEFAULT_ROLES,
  "signalRoles": { "research": ["research"], "investigation": ["explore"] },
  "scoring": {
    "trivial": {
      "maxChars": 60,
      "patterns": [
        "^(?:thanks|thank you|thx|ty|ok|okay|k|cool|nice|great|perfect|awesome|lgtm|sounds good|got it|yes|yep|yeah|no|nope|sure)\\b[.!\\s]*$",
        "^(?:👍|🙏|✅|👌|🎉)+\\s*$"
      ],
      "leading": [
        "^(?:thanks|thank you|thx|ty|cheers)(?:[\\s,.!;:—–-]*$|[\\s,.!;:—–-]+(?:for|that|this|it|so|a|very|much|again|all|you)\\b)(?!.*\\b(?:now\\b(?![.!\\s]*$)|also|next|then|but|and|please|plz|pls|need|want|lets?|still|instead|another|more|actually|however|(?:can|could|would|will|should) (?:you|we|u)|how|what|when|where|which|who|why)\\b)",
        "^(?:ok|okay|great|perfect|nice|cool|awesome|good|excellent)[\\s,.!;:—–-]+(?:that|this|it|thanks|thank you|thx|ty|looks|works?|worked|makes sense|got it)\\b(?!.*\\b(?:now\\b(?![.!\\s]*$)|also|next|then|but|and|please|plz|pls|need|want|lets?|still|instead|another|more|actually|however|(?:can|could|would|will|should) (?:you|we|u)|how|what|when|where|which|who|why)\\b)"
      ]
    },
    "continuation": {
      "maxChars": 80,
      "patterns": [
        "^(?:continue|go ahead|go on|proceed|keep going|carry on|do it|ship it|resume|next|try again|retry)\\b[.!\\s]*$",
        "^yes,? (?:please|do it|go ahead)[.!\\s]*$"
      ]
    },
    "question": {
      "score": 1,
      "patterns": [
        "^\\s*(?:what|what's|whats|why|how|where|when|which|who|explain|show me|tell me|is there|are there|does|do we|can you explain)\\b",
        "\\?\\s*$"
      ]
    },
    "classes": [
      {
        "id": "action",
        "label": "change",
        "floor": 3,
        "patterns": [
          "\\b(?:fix|rename|bump|typo|update|add|implement|create|write|change|remove|make|move|delete|wire|configure|install)\\b"
        ]
      },
      {
        "id": "investigation",
        "label": "investigation",
        "add": 3,
        "patterns": [
          "\\b(?:slow|figure out|investigat\\w*|debug\\w*|root cause|intermittent\\w*|sometimes|flaky|leak\\w*|crash\\w*)\\b",
          "\\bwhy (?:is|does|do|are)\\b"
        ]
      },
      {
        "id": "breadth",
        "label": "breadth",
        "add": 3,
        "patterns": [
          "\\b(?:every|across|entire|whole|everywhere)\\b",
          "\\ball (?:the )?\\w+s\\b"
        ]
      },
      {
        "id": "research",
        "label": "research",
        "floor": 6,
        "patterns": [
          "\\b(?:research|compare|benchmark\\w*|evaluate|trade-?offs?|market)\\b"
        ]
      },
      {
        "id": "large",
        "label": "large build",
        "floor": 9,
        "patterns": [
          "(?<!\\b(?:the|fix|ci|nightly|a broken) )\\bbuild(?:ing)?\\b(?!\\s+(?:is|was|fails?|failed|failing|broke|broken|errors?|logs?|step|output|time)\\b)",
          "\\bport(?:ing)? (?:\\w+ ){0,3}(?:to|into|from)\\b",
          "\\b(?:redesign|refactor\\w*|migrat(?:e[sd]?|ing)|architect\\w*|overhaul|rewrite|re-?implement)\\b",
          "\\bend[- ]to[- ]end\\b",
          "\\bfrom scratch\\b",
          "\\b(?:new|design (?:a|the)) (?:system|service|app|plugin|platform)\\b"
        ]
      },
      {
        "id": "risk",
        "label": "risk",
        "add": 2,
        "patterns": [
          "\\b(?:production|prod deploy|deploy to prod|drop table|delete|secrets?|credentials?|customer data|pii|payments?|refunds?|force[- ]push|rm -rf|publish|release)\\b",
          "\\bauth(?:n|z|entication|orization)?\\b",
          "\\b(?:sso|saml|oauth|log ?in|sessions?)\\b"
        ]
      }
    ],
    "components": {
      "addPerExtraGroup": 2,
      "cap": 6,
      "groups": {
        "backend": "\\b(?:backend|endpoint|api|controller|server|service|handler)\\b",
        "frontend": "\\b(?:frontend|ui|ux|page|component|modal|button|css|react|vue|svelte)\\b",
        "data": "\\b(?:database|schema|table|column|migrations?|query|sql)\\b",
        "auth": "\\b(?:permissions?|roles?|access control)\\b",
        "tests": "\\b(?:tests?|specs?|e2e|coverage)\\b",
        "infra": "\\b(?:deploy\\w*|ci|pipeline|docker|kubernetes|k8s|terraform|helm)\\b",
        "docs": "\\b(?:docs?|readme|documentation|changelog)\\b",
        "delivery": "\\b(?:pr|pull request|release notes?)\\b"
      }
    },
    "files": {
      "pattern": "(?:[\\w.-]+/[\\w./-]+|\\b[\\w-]+\\.(?:md|mdx|mjs|cjs|js|jsx|ts|tsx|json|ya?ml|toml|sql|py|rb|go|rs|java|kt|swift|c|cc|cpp|h|hpp|cs|php|sh|css|scss|html|vue|svelte)\\b)",
      "atLeast": 3,
      "add": 2
    },
    "length": [
      {
        "overChars": 500,
        "add": 1
      },
      {
        "overChars": 1500,
        "add": 2
      }
    ],
    "unmatchedScore": 3
  },
  "explicitModel": {
    "enabled": true,
    "pattern": "\\b(?:use|with|on|switch to|via)\\s+((?:claude[- ])?(?:haiku|sonnet|opus|fable|mythos)|gpt-[\\w.-]+|o\\d[\\w-]*|gemini[\\w.-]*|codex[\\w.-]*)\\b"
  },
  "skipPatterns": [
    "^\\s*<system-reminder",
    "^\\s*<task-notification",
    "^\\s*\\[SYSTEM NOTIFICATION",
    "^\\s*BB plan-progress automatic reminder"
  ]
};

// ---------------------------------------------------------------------------
// Merge

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const clone = <T>(v: T): T => (v === undefined ? v : (JSON.parse(JSON.stringify(v)) as T));
const deepEqual = (a: unknown, b: unknown): boolean => JSON.stringify(sortKeys(a)) === JSON.stringify(sortKeys(b));
function sortKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (isObj(v)) return Object.fromEntries(Object.keys(v).sort().map((k) => [k, sortKeys(v[k])]));
  return v;
}

const NULLABLE = new Set(["prices", "serviceTierMultipliers", "gears", "roles", "signalRoles"]);
const ROLE_GEARS = /^roles\.[^.]+\.gears$/;

function deepMerge(base: unknown, over: unknown, path: string): unknown {
  if (over === undefined) return clone(base);
  if (path === "scoring.classes") return mergeClasses(base, over);
  if (!isObj(base) || !isObj(over)) return clone(over);
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(base)) out[k] = clone(base[k]);
  for (const k of Object.keys(over)) {
    const sub = path ? `${path}.${k}` : k;
    const v = over[k];
    if (NULLABLE.has(path) || ROLE_GEARS.test(path) || /^gears\.[^.]+$/.test(path)) {
      if (v === null) { delete out[k]; continue; }
      if (path === "prices" || path === "serviceTierMultipliers" || path === "signalRoles" || ROLE_GEARS.test(path) || /^gears\.[^.]+$/.test(path)) { out[k] = clone(v); continue; }
      // gears.<provider> and roles.<name>: merge per key
      out[k] = deepMerge(isObj(out[k]) ? out[k] : {}, v, sub);
      continue;
    }
    out[k] = deepMerge(out[k], v, sub);
  }
  return out;
}

function mergeClasses(base: unknown, over: unknown): unknown {
  if (!Array.isArray(over)) return clone(over);
  const out: Array<Record<string, unknown>> = Array.isArray(base) ? clone(base as Array<Record<string, unknown>>) : [];
  for (const entry of over) {
    if (!isObj(entry)) { out.push(entry as never); continue; }
    const at = typeof entry.id === "string" ? out.findIndex((c) => c.id === entry.id) : -1;
    if (at < 0) { out.push(clone(entry)); continue; }
    const merged = { ...out[at]! };
    for (const [k, v] of Object.entries(entry)) { if (v === null) delete merged[k]; else merged[k] = clone(v); }
    out[at] = merged;
  }
  return out;
}

/** Defaults with the user's overrides on top. Does not validate: see validatePolicy. */
export function mergePolicy(defaults: Policy, overrides: PolicyOverrides): Policy {
  return deepMerge(defaults, overrides, "") as Policy;
}

// ---------------------------------------------------------------------------
// Validation

const flagsFor = (src: string) => (/[^\x00-\x7f]/.test(src) ? "iu" : "i");
export const MAX_PATTERN_CHARS = 500;
const QUANT = /^(?:[*+?]|\{\d+(?:,\d*)?\})\??/;
const GROUP_PREFIX = /^\?(?::|=|!|<=|<!|<[^>]+>)/;

/**
 * A small safe-regex heuristic: rejects an unbounded quantifier on a group that already holds a
 * quantifier or overlapping alternatives (`(\w+)+`, `(a|a)*`, `(.*)+`) and adjacent unbounded
 * quantifiers on the same atom (`\w+\w+`, `.*.*`). Not a proof of safety, but it catches the classic blow-ups.
 */
export function unsafeRegexReason(src: string): string | null {
  if (src.length > MAX_PATTERN_CHARS) return `Pattern is longer than ${MAX_PATTERN_CHARS} characters`;
  interface Frame { hasQuant: boolean; alts: string[]; cur: string; prev: { atom: string; unb: boolean } | null }
  const fresh = (): Frame => ({ hasQuant: false, alts: [], cur: "", prev: null });
  const stack: Frame[] = [fresh()];
  let i = 0;
  while (i < src.length) {
    const c = src[i]!;
    let atom: string;
    let group: Frame | null = null;
    if (c === "\\") { atom = src.slice(i, i + 2); i += 2; }
    else if (c === "[") {
      let j = i + 1;
      while (j < src.length && src[j] !== "]") j += src[j] === "\\" ? 2 : 1;
      atom = src.slice(i, j + 1); i = j + 1;
    } else if (c === "(") {
      stack.push(fresh()); i++;
      const m = GROUP_PREFIX.exec(src.slice(i, i + 40));
      if (m) i += m[0].length;
      continue;
    } else if (c === ")") {
      if (stack.length < 2) { i++; continue; }
      group = stack.pop()!; atom = `(${group.alts.concat(group.cur).join("|")})`; i++;
    } else if (c === "|") {
      const f = stack[stack.length - 1]!; f.alts.push(f.cur); f.cur = ""; f.prev = null; i++; continue;
    } else { atom = c; i++; }
    const q = QUANT.exec(src.slice(i, i + 20));
    if (q) i += q[0].length;
    const unb = !!q && (q[0][0] === "*" || q[0][0] === "+" || /^\{\d+,\}/.test(q[0]));
    const f = stack[stack.length - 1]!;
    if (group) {
      const alts = group.alts.concat(group.cur).filter((a) => a.length > 0);
      const overlap = alts.some((a, x) => alts.some((b, y) => x < y && (a === b || a.startsWith(b) || b.startsWith(a))));
      if (unb && (group.hasQuant || overlap)) return "Nested or ambiguous repetition can make matching extremely slow";
      if (group.hasQuant) f.hasQuant = true;
    }
    if (unb && f.prev?.unb && (f.prev.atom === atom || atom === "." || f.prev.atom === ".")) return "Adjacent repeats of the same thing can make matching extremely slow";
    if (q) f.hasQuant = true;
    f.prev = { atom, unb };
    f.cur += atom + (q ? q[0] : "");
  }
  return null;
}

function tryRegex(src: string): string | null {
  const unsafe = unsafeRegexReason(src);
  if (unsafe) return unsafe;
  try { new RegExp(src, flagsFor(src)); return null; } catch (e) { return e instanceof Error ? e.message : String(e); }
}

function formatPath(path: ReadonlyArray<PropertyKey>, raw: unknown): string {
  let out = "";
  let cur: unknown = raw;
  for (let i = 0; i < path.length; i++) {
    const seg = path[i]!;
    cur = isObj(cur) || Array.isArray(cur) ? (cur as Record<PropertyKey, unknown>)[seg] : undefined;
    if (typeof seg === "number") {
      const id = out === "scoring.classes" && isObj(cur) && typeof cur.id === "string" ? cur.id : null;
      out += `[${id ?? seg}]`;
    } else out += out ? `.${String(seg)}` : String(seg);
  }
  return out;
}

/** Contribution ids the classifier emits besides the policy's own classes. */
const BUILTIN_SIGNAL_IDS = ["question", "unmatched", "components", "files", "length", "continuation", "trivial", "empty"];

export function validatePolicy(policy: unknown): PolicyError[] {
  const errors: PolicyError[] = [];
  const parsed = policySchema.safeParse(policy);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) errors.push({ path: formatPath(issue.path, policy), message: issue.message });
    return errors;
  }
  const p = parsed.data;
  const checkList = (list: string[], path: string) => list.forEach((src, i) => { const m = tryRegex(src); if (m) errors.push({ path: `${path}[${i}]`, message: m }); });
  checkList(p.skipPatterns, "skipPatterns");
  checkList(p.scoring.trivial.patterns, "scoring.trivial.patterns");
  checkList(p.scoring.trivial.leading, "scoring.trivial.leading");
  checkList(p.scoring.continuation.patterns, "scoring.continuation.patterns");
  checkList(p.scoring.question.patterns, "scoring.question.patterns");
  for (const c of p.scoring.classes) checkList(c.patterns, `scoring.classes[${c.id}].patterns`);
  for (const [k, src] of Object.entries(p.scoring.components.groups)) { const m = tryRegex(src); if (m) errors.push({ path: `scoring.components.groups.${k}`, message: m }); }
  { const m = tryRegex(p.scoring.files.pattern); if (m) errors.push({ path: "scoring.files.pattern", message: m }); }
  { const m = tryRegex(p.explicitModel.pattern); if (m) errors.push({ path: "explicitModel.pattern", message: m }); }

  let prevMax = -1;
  TIERS.forEach((t, i) => {
    const { min, max } = p.tiers[t];
    if (i === 0 && min !== 0) errors.push({ path: `tiers.${t}.min`, message: "The first band must start at 0" });
    else if (i > 0 && min !== prevMax + 1) errors.push({ path: `tiers.${t}.min`, message: `Bands must be contiguous: expected ${prevMax + 1}` });
    if (max < min) errors.push({ path: `tiers.${t}.max`, message: "max must be at least min" });
    prevMax = max;
  });
  for (const t of TIERS) for (const r of p.teams[t].roles) {
    if (!p.roles[r]) errors.push({ path: `teams.${t}.roles`, message: `Unknown role "${r}"` });
  }
  const classIds = new Set([...BUILTIN_SIGNAL_IDS, ...p.scoring.classes.map((c) => c.id)]);
  for (const [cls, list] of Object.entries(p.signalRoles)) {
    if (!classIds.has(cls)) errors.push({ path: `signalRoles.${cls}`, message: `Unknown scoring class "${cls}"` });
    for (const r of list) if (!p.roles[r]) errors.push({ path: `signalRoles.${cls}`, message: `Unknown role "${r}"` });
  }
  for (const [name, r] of Object.entries(p.roles)) {
    if (!/^[a-z][a-z0-9_-]*$/.test(name)) errors.push({ path: `roles.${name}`, message: "Role names are lowercase letters, digits, - or _" });
    if (Object.keys(r.gears).length === 0) errors.push({ path: `roles.${name}.gears`, message: "A role needs at least a \"*\" gear" });
  }
  return errors;
}

// ---------------------------------------------------------------------------
// Compile

export interface CompiledClass { id: string; label: string; floor?: number; add?: number; patterns: RegExp[] }
export interface CompiledPolicy {
  policy: Policy;
  skip: RegExp[];
  trivial: { maxChars: number; patterns: RegExp[]; leading: RegExp[] };
  continuation: { maxChars: number; patterns: RegExp[] };
  question: { score: number; patterns: RegExp[] };
  classes: CompiledClass[]; // enabled only
  groups: Array<{ id: string; re: RegExp }>;
  files: { re: RegExp; atLeast: number; add: number };
  explicit: RegExp | null;
}

const rx = (src: string, extra = "") => new RegExp(src, flagsFor(src) + extra);

/** Build every regex once. Throws on an invalid pattern: validate first. */
export function compilePolicy(policy: Policy): CompiledPolicy {
  const s = policy.scoring;
  return {
    policy,
    skip: policy.skipPatterns.map((p) => rx(p)),
    trivial: { maxChars: s.trivial.maxChars, patterns: s.trivial.patterns.map((p) => rx(p)), leading: s.trivial.leading.map((p) => rx(p)) },
    continuation: { maxChars: s.continuation.maxChars, patterns: s.continuation.patterns.map((p) => rx(p)) },
    question: { score: s.question.score, patterns: s.question.patterns.map((p) => rx(p)) },
    classes: s.classes.filter((c) => c.enabled !== false).map((c) => ({ id: c.id, label: c.label, floor: c.floor, add: c.add, patterns: c.patterns.map((p) => rx(p)) })),
    groups: Object.entries(s.components.groups).map(([id, src]) => ({ id, re: rx(src) })),
    files: { re: rx(s.files.pattern, "g"), atLeast: s.files.atLeast, add: s.files.add },
    explicit: policy.explicitModel.enabled ? rx(policy.explicitModel.pattern) : null,
  };
}

/** Merge + validate. Invalid overrides fall back to the defaults, with the errors kept. */
export function resolvePolicy(overrides: PolicyOverrides, defaults: Policy = DEFAULT_POLICY): { effective: Policy; errors: PolicyError[] } {
  const merged = mergePolicy(defaults, overrides);
  const errors = validatePolicy(merged);
  return { effective: errors.length ? defaults : merged, errors };
}

// ---------------------------------------------------------------------------
// Ladders

/** The five gears for a provider: "*" with the provider's own tiers on top. */
export function ladderFor(policy: Policy, providerId: string): Record<Tier, GearSpec> {
  const star = policy.gears["*"] ?? {};
  const own = policy.gears[providerId] ?? {};
  const out = {} as Record<Tier, GearSpec>;
  for (const t of TIERS) out[t] = own[t] ?? star[t] ?? DEFAULT_POLICY.gears["*"]![t]!;
  return out;
}

// ---------------------------------------------------------------------------
// Diff

function diffObj(base: unknown, eff: unknown, path: string): unknown {
  if (deepEqual(base, eff)) return undefined;
  if (path === "scoring.classes") return diffClasses(base, eff);
  if (!isObj(base) || !isObj(eff)) return clone(eff);
  const nullable = NULLABLE.has(path) || ROLE_GEARS.test(path) || /^gears\.[^.]+$/.test(path);
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(eff)) {
    const sub = path ? `${path}.${k}` : k;
    if (!(k in base)) { out[k] = clone(eff[k]); continue; }
    if (path === "prices" || path === "serviceTierMultipliers" || path === "signalRoles" || ROLE_GEARS.test(path) || /^gears\.[^.]+$/.test(path)) {
      if (!deepEqual(base[k], eff[k])) out[k] = clone(eff[k]);
      continue;
    }
    const d = diffObj(base[k], eff[k], sub);
    if (d !== undefined) out[k] = d;
  }
  if (nullable) for (const k of Object.keys(base)) if (!(k in eff)) out[k] = null;
  return Object.keys(out).length ? out : undefined;
}

function diffClasses(base: unknown, eff: unknown): unknown {
  if (!Array.isArray(base) || !Array.isArray(eff)) return clone(eff);
  const out: Array<Record<string, unknown>> = [];
  for (const e of eff as Array<Record<string, unknown>>) {
    const b = (base as Array<Record<string, unknown>>).find((c) => c.id === e.id);
    if (!b) { out.push(clone(e)); continue; }
    if (deepEqual(b, e)) continue;
    const d: Record<string, unknown> = { id: e.id };
    for (const k of Object.keys(e)) if (!deepEqual(b[k], e[k])) d[k] = clone(e[k]);
    for (const k of Object.keys(b)) if (!(k in e)) d[k] = null;
    out.push(d);
  }
  for (const b of base as Array<Record<string, unknown>>) if (!(eff as Array<Record<string, unknown>>).some((e) => e.id === b.id)) out.push({ id: b.id, enabled: false });
  return out.length ? out : undefined;
}

/** The minimal overrides that merge on top of `defaults` to produce `effective`. */
export function diffOverrides(defaults: Policy, effective: Policy): PolicyOverrides {
  return (diffObj(defaults, effective, "") as PolicyOverrides | undefined) ?? {};
}

/** Drop the overrides under a dotted path ("gears.claude-code", "prices"), or all for null. Returns a new object. */
export function removeOverridePath(overrides: PolicyOverrides, path: string | null): PolicyOverrides {
  if (path === null || path.trim() === "") return {};
  const next = clone(overrides);
  const parts = path.split(".");
  const walk = (node: Record<string, unknown>, i: number): void => {
    const k = parts[i]!;
    if (i === parts.length - 1) { delete node[k]; return; }
    const child = node[k];
    if (!isObj(child)) return;
    walk(child, i + 1);
    if (Object.keys(child).length === 0) delete node[k];
  };
  walk(next, 0);
  return next;
}
