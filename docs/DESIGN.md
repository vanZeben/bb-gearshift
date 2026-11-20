# Gearshift design

Gearshift is a bb plugin that routes every message to the right model and reasoning
effort for its size, on whatever provider the thread runs on. Small asks go to a small,
fast model; big builds go to the top model with more thinking. It never needs a fork of
bb: it uses only public Plugin SDK surfaces.

This document is the contract between the backend (`server.ts`, `lib/`) and the frontend
(`app.tsx`, `components/`). Change it when the contract changes.

## How a message gets routed

bb asks every plugin hook about each message before it reaches a provider
(`bb.experimental_hooks.on("message.dispatch")`). A hook can only answer
`proceed`, `wait` or `reject`; it cannot edit the message. Gearshift therefore shifts
gears in three steps when the message is not already on the right gear:

1. **Decide.** Classify the message text (`lib/classify.ts`), map the tier to a gear for
   the thread's provider (`lib/gears.ts`), apply the rules below (`lib/router.ts`).
2. **Hold and amend.** Return `{ action: "wait", reason: "Shifting to Sonnet 5.5 · high" }`
   (bb shows the plugin name next to the reason). bb stores the message as a queued row and
   fires `message.queued`; Gearshift links that row id to its decision (`queued_links`) by
   the message's text fingerprint, sets the row's `model`, `reasoningLevel` and
   `serviceTier` (`queuedMessages.update`, with `expectedUpdatedAt`), then calls
   `bb.experimental_hooks.recheck("message.dispatch")`. For a re-attempt the row ids are
   already in `ctx.queuedMessages`, so every row of a grouped drain is amended. If the event
   does not arrive within ~1 s, a poll looks for the row by exact fingerprint. A row whose
   text does not match the decision is never amended, whichever plugin owns its wait.
3. **Release.** bb re-attempts the row. A queued row dispatches with its own `model` and
   `reasoningLevel` (bb server `sendQueuedMessagePayload`). The hook finds the row ids in
   `queued_links` and answers `proceed` without re-deciding.

**Re-attempts never re-decide.** An inline first attempt (`ctx.queuedMessages` empty)
always records a new decision. A re-attempt whose rows are all linked to decisions answers
`proceed` (a `manual`, `keep`, `off` or `skip` stays what it was, even after a thread-busy
or provisioning wait drained it). Only rows Gearshift never saw (a grouped drain of messages
queued before install) get a fresh decision on the combined text.

When the message is already on the right gear the hook answers `proceed` at once: no
queue, no delay. Holding takes tens of milliseconds; the queued card flashes the reason.

Facts verified against bb 0.50.1 (SDK 0.6.157):

- The hook pass runs before bb's own waits (thread busy, provisioning), for a thread's
  first message, follow-ups, steers, drained queue rows and retries.
- `ctx.requestedExecution` is the tuple bb resolved before the hook; `ctx.executionSources.model`
  is `"explicit"` when a person touched the model picker in that composer, `"client-preference"`
  for a remembered default, null otherwise (and null for every drained queue row).
- Requeue pacing: a *drained* row the hook re-queues is not re-attempted by `recheck` for
  1 s (`DISPATCH_REQUEUE_MIN_INTERVAL_MS`). An inline first wait has no pacing. So after an
  amend, call `recheck` at once and again at +1.2 s and +3 s while the row still waits on us.
- If the plugin stops, bb's orphan sweep releases rows waiting on it (fail-open by design).

### Fail-open rules

- Any exception or timeout in the hook → `proceed` (log it). Never `reject`.
- Every lookup in the hook (catalog, current gear, context size) shares one 1.5 s race
  (`lib/bounded.ts`); on timeout → `skip`. bb runs hooks under one server-wide lock and
  fails a handler that overruns its time box, so nothing in the hook may wait unbounded.
- Policy patterns run on capped text: skip patterns on the first 2,000 characters, scoring
  patterns on the first 8,000 (length bonuses still see the full length). `validatePolicy`
  rejects patterns over 500 characters and nested or adjacent repeats such as `(\w+)+`.
- A row linked to a Gearshift decision is always `proceed`ed, even if its amend failed
  (then marked `failed`). Never wait twice on one row.
- If the amend cannot find or update the row within 5 s → mark it `failed`, `recheck` anyway.

## Decision rules (`lib/router.ts`, pure)

`decide(input) → Decision`, first match wins:

| # | Condition | Action | Reason shown |
|---|---|---|---|
| 0 | the message matches `policy.skipPatterns` | `skip` | System message |
| 1 | the `enabled` setting off, or the thread's toggle off | `off` | Gearshift is off for this thread |
| 2 | `attempt === "join-turn"` (a steer into a running turn) | `skip` | Joins the running turn; the model can't change mid-turn |
| 3 | `initiator === "system"` (a retry) | `skip` | A retry keeps its original model |
| 4 | `initiator === "agent"` and `policy.routing.routeAgentMessages` off | `skip` | Agent messages are not routed |
| 5 | no catalog for the provider | `skip` | Model list unavailable for {provider} |
| 6 | the text names a model family that resolves ("use opus") | `shift`/`keep` | You asked for {label} |
| 7 | `modelSource === "explicit"` and `policy.routing.respectManualPicks` | `manual` | Model picked by hand |
| 8 | continuation ("go ahead", "continue") and the thread has a current gear | `hold` (or `keep` if requested already equals it) | Continuing on {label} |
| 9 | the tier's gear does not resolve | `skip` | No model for {tier} on {provider} |
| 10 | thread context ≥ `policy.routing.holdAboveTokens` and the tier's gear is *lower* than the current gear | `hold` | Holding {label}: a {N}k-token context would be re-read uncached |
| 11 | tier gear equals the requested model and effort | `keep` | {Tier} task ({signals}) → {label} · {effort} |
| 12 | otherwise | `shift` | same as 11 |

`hold` and `keep` with a target equal to the request need no amend. `shift` and a `hold`
whose target differs from the request (the composer asked for something else) amend.

Why rule 10: prompt caches are scoped to one model, and changing the effort mid-conversation
also invalidates the message cache on Anthropic models. Dropping a 200k-token thread to a
cheaper model for a "thanks" re-reads the whole context uncached, which costs more than the
answer saves. Upshifts are always allowed: quality first.

"Current gear" = the thread's last executed model and effort
(`bb.sdk.threads.defaultExecutionOptions({ threadId })`), or null for a thread with no turns
(`ctx.thread.status === "pending"`). Context size = `usedTokens` of the latest
`thread/contextWindowUsage/updated` event.

Gear weight (`gearWeight` in `lib/gears.ts`) = the model's lowest tier position on the
ladder × 10 + the effort's rank. Lower weight = downshift.

## Policy (`lib/policy.ts`)

Everything Gearshift decides comes from one **policy** document: the score bands, the
scoring rules, the gears per provider, prices, and the routing switches. Gearshift ships a
complete default policy (below). A user's policy is only their **overrides**, merged on top,
so they keep receiving improved defaults with each release for everything they did not change.

Where users edit it, in bb → Settings → Plugins → Gearshift. **No JSON anywhere**: every
knob is a form control.

1. **Declarative settings** (`bb.settings.define`, host-rendered) for the switches.
2. The **Routing policy** editor (`app.slots.settingsSection`, see Frontend) for gears and
   scoring, with dropdowns, switches and a "Try a message" box.

### Declarative settings

| Key | Type | Default | Label |
|---|---|---|---|
| `enabled` | boolean | true | Enable Gearshift |
| `defaultOn` | boolean | true | Start new threads with Gearshift on |
| `respectManualPicks` | boolean | true | A model picked by hand wins |
| `routeAgentMessages` | boolean | true | Route messages from other agents |
| `holdAboveTokens` | number (int ≥ 0) | 60000 | Don't downshift threads above this many context tokens (0 = never hold) |
| `retentionDays` | number (int 1–3650) | 90 | Days of history kept |

The effective policy's `routing` section is built from these settings at runtime.

### Where overrides live

The editor's overrides are stored in plugin storage (`bb.storage.kv`, key
`policy-overrides`), merged on top of `DEFAULT_POLICY` at load and after each save.
`prices`, `serviceTierMultipliers`, `baselineModel` and `routing` are **not**
user-editable: `savePolicy` strips them and reports one error per stripped path. Prices
stay built in and only feed the analytics page's cost estimates; savings are measured
against each provider's xlarge gear ("the top gear").

### Types

```ts
export const TIERS = ["trivial", "small", "medium", "large", "xlarge"] as const;
export type Tier = (typeof TIERS)[number];

export interface GearSpec {
  /** Exact model id, a family word in the model's name ("sonnet", "mini"), "@default", or "@small" | "@medium" | "@large". */
  model: string;
  /** Wanted reasoning level, clamped to the model's. Omit to keep the composer's. */
  effort?: string;
  /** Provider service tier ("default", "fast", …). Omit to keep the composer's. Only applied when the model lists it. */
  serviceTier?: string;
}

export interface Price {
  input: number;       // USD per million tokens
  output: number;
  cacheRead?: number;  // default input × 0.1
  cacheWrite?: number; // default input × 1.25
}

export interface ScoreClass {
  id: string;            // stable key; overrides merge by id
  label: string;         // shown as the signal ("large build")
  patterns: string[];    // JS regex sources, matched case-insensitively against the message
  floor?: number;        // the score starts at least here when matched
  add?: number;          // added to the score when matched
  enabled?: boolean;     // default true; false disables a default class
}

export interface Policy {
  version: 1;
  /** Inclusive score bands. Must start at 0, be contiguous and ascending in TIERS order. */
  tiers: Record<Tier, { min: number; max: number }>;
  /** Gears per provider id. "*" applies to every provider; a provider's own entry wins per tier. */
  gears: Record<string, Partial<Record<Tier, GearSpec>>>;
  /** Prices keyed by model id or id prefix; the longest matching key wins. */
  prices: Record<string, Price>;
  /** Cost multiplier per service tier (e.g. fast mode costs 2×). Missing tier = 1. */
  serviceTierMultipliers: Record<string, number>;
  /** Model savings are measured against. Null: each provider's xlarge gear. */
  baselineModel: string | null;
  routing: {
    defaultOn: boolean;           // new threads start with Gearshift on
    respectManualPicks: boolean;  // a model picked by hand in the composer wins for that message
    routeAgentMessages: boolean;  // route messages other agents send into a thread
    holdAboveTokens: number;      // never downshift at or above this context size; 0 = never hold
  };
  scoring: {
    trivial: { maxChars: number; patterns: string[] };      // score 0, high confidence
    continuation: { maxChars: number; patterns: string[] }; // keep the thread's current gear
    question: { score: number; patterns: string[] };        // base score of a question when no floor class matched
    classes: ScoreClass[];
    components: { addPerExtraGroup: number; cap: number; groups: Record<string, string> }; // areas of a codebase a message touches
    files: { pattern: string; atLeast: number; add: number }; // file-path mentions
    length: Array<{ overChars: number; add: number }>;       // the largest matching rule applies
    unmatchedScore: number;                                   // base when nothing matched: confidence low
  };
  explicitModel: { enabled: boolean; pattern: string };      // capture group 1 = the model family ("use opus")
  /** Messages matching any of these (raw text) are never routed: system and harness messages. */
  skipPatterns: string[];
}
```

`lib/policy.ts` exports `DEFAULT_POLICY`, a zod `policySchema` (effective policy) and
`policyOverridesSchema` (any JSON object), `mergePolicy(defaults, overrides)`,
`validatePolicy(policy) → { path, message }[]`, `compilePolicy(policy) → CompiledPolicy`
(RegExp objects, `i` flag, `u` flag for patterns containing non-ASCII), `ladderFor(policy,
providerId) → Record<Tier, GearSpec>`, and `diffOverrides(defaults, effective)` (the minimal
overrides that produce `effective`, used by the editor so it never stores defaults).

### Merge rules

- Plain objects deep-merge; arrays and scalars in overrides replace the default.
- `scoring.classes` merges **by `id`**: an override entry updates the default class with the
  same id field by field; a new id is appended; `{ "id": "large", "enabled": false }` disables one.
- `gears.<provider>.<tier>` and `prices.<key>` are replaced whole.
- In `gears`, `prices` and `serviceTierMultipliers`, an override value of `null` deletes that key.

### Validation

`validatePolicy` returns every problem with a dotted path: schema errors; a regex that does
not compile (`scoring.classes[large].patterns[2]: Invalid regular expression…`); tier bands
not starting at 0 / not contiguous / not ascending; negative numbers; a `floor`/`add` outside
0–100. At runtime an invalid saved policy never breaks routing: Gearshift logs the errors,
routes with `DEFAULT_POLICY`, and `getPolicy` reports the errors so the editor shows them.

### Scoring (`lib/classify.ts`)

`classify(raw, compiled) → Classification`, pure, sub-millisecond:

1. If any `skipPatterns` matches the raw text → `{ skip: true }` (router action `skip`, "System message").
2. `text = humanText(raw)` (bb envelopes, `<system-reminder>` blocks and attachment notes
   removed; pasted blocks replaced by a size stub). `body` = whitespace-collapsed text.
3. Empty body → score 0.
4. `body.length ≤ continuation.maxChars` and a continuation pattern matches → `continuation: true`.
5. `body.length ≤ trivial.maxChars` and a trivial pattern matches → score 0, confidence high.
6. Otherwise:
   - `floor` = the highest `floor` among matched enabled classes;
   - `base` = `floor` if any floor class matched, else `question.score` if a question pattern
     matches, else `unmatchedScore`;
   - `adds` = the sum of `add` over matched classes (a class may have both floor and add);
   - components: count matched groups; bonus = `min(cap, max(0, groups − 1) × addPerExtraGroup)`;
   - files: distinct matches of `files.pattern` ≥ `atLeast` → `+add`;
   - length: the largest `add` among rules with `body.length > overChars`;
   - `score = clamp(base + adds + bonuses, 0, tiers.xlarge.max)`; tier = the band containing it.
7. Confidence: `low` when no class or question matched (unmatched base); `high` when at least
   one class matched and the score is not on a band edge; else `medium`.

The result carries `contributions: { id, label, kind: "floor" | "add" | "base" | "bonus", value, match }[]`
in the order applied (for "why" displays) and `signals` = the first four contribution labels,
plus `requestedFamily` from `explicitModel.pattern` when enabled.

### Default policy

```json
{
  "version": 1,
  "tiers": {
    "trivial": { "min": 0, "max": 2 },
    "small": { "min": 3, "max": 5 },
    "medium": { "min": 6, "max": 8 },
    "large": { "min": 9, "max": 11 },
    "xlarge": { "min": 12, "max": 14 }
  },
  "gears": {
    "*": {
      "trivial": { "model": "@small", "effort": "low" },
      "small": { "model": "@small", "effort": "medium" },
      "medium": { "model": "@medium", "effort": "medium" },
      "large": { "model": "@large", "effort": "high" },
      "xlarge": { "model": "@large", "effort": "xhigh" }
    },
    "claude-code": {
      "trivial": { "model": "haiku", "effort": "low" },
      "small": { "model": "sonnet", "effort": "medium" },
      "medium": { "model": "sonnet", "effort": "high" },
      "large": { "model": "opus", "effort": "high" },
      "xlarge": { "model": "opus", "effort": "xhigh" }
    },
    "codex": {
      "trivial": { "model": "@small", "effort": "low" },
      "small": { "model": "@small", "effort": "medium" },
      "medium": { "model": "@default", "effort": "medium" },
      "large": { "model": "@default", "effort": "high" },
      "xlarge": { "model": "@default", "effort": "xhigh" }
    }
  },
  "prices": {
    "claude-fable-5-2": { "input": 8, "output": 40, "cacheRead": 0.2 },
    "claude-mythos-5-2": { "input": 8, "output": 40, "cacheRead": 0.2 },
    "claude-fable-5-1": { "input": 10, "output": 50 },
    "claude-fable-5": { "input": 10, "output": 50 },
    "claude-opus-5-5": { "input": 4, "output": 20, "cacheRead": 0.2 },
    "claude-opus-5": { "input": 5, "output": 25 },
    "claude-opus-4": { "input": 5, "output": 25 },
    "claude-sonnet-5-5": { "input": 2, "output": 10, "cacheRead": 0.1 },
    "claude-sonnet-5": { "input": 2, "output": 10 },
    "claude-sonnet-4-6": { "input": 3, "output": 15 },
    "claude-haiku-5-5": { "input": 0.1, "output": 0.5 },
    "claude-haiku-4-5": { "input": 1, "output": 5 }
  },
  "serviceTierMultipliers": { "fast": 2 },
  "baselineModel": null,
  "routing": { "defaultOn": true, "respectManualPicks": true, "routeAgentMessages": true, "holdAboveTokens": 60000 },
  "scoring": {
    "trivial": {
      "maxChars": 60,
      "patterns": [
        "^(?:thanks|thank you|thx|ty|ok|okay|k|cool|nice|great|perfect|awesome|lgtm|sounds good|got it|yes|yep|yeah|no|nope|sure)\\b[.!\\s]*$",
        "^(?:👍|🙏|✅|👌|🎉)+\\s*$"
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
      { "id": "action", "label": "change", "floor": 3, "patterns": ["\\b(?:fix|rename|bump|typo|update|add|implement|create|write|change|remove|make|move|delete|wire|configure|install)\\b"] },
      { "id": "investigation", "label": "investigation", "add": 3, "patterns": ["\\b(?:slow|figure out|investigat\\w*|debug\\w*|root cause|intermittent\\w*|sometimes|flaky|leak\\w*|crash\\w*)\\b", "\\bwhy (?:is|does|do|are)\\b"] },
      { "id": "breadth", "label": "breadth", "add": 3, "patterns": ["\\b(?:every|across|entire|whole|everywhere)\\b", "\\ball (?:the )?\\w+s\\b"] },
      { "id": "research", "label": "research", "floor": 6, "patterns": ["\\b(?:research|compare|benchmark\\w*|evaluate|trade-?offs?|market)\\b"] },
      { "id": "large", "label": "large build", "floor": 9, "patterns": [
        "(?<!\\b(?:the|fix|ci|nightly|a broken) )\\bbuild(?:ing)?\\b(?!\\s+(?:is|was|fails?|failed|failing|broke|broken|errors?|logs?|step|output|time)\\b)",
        "\\bport(?:ing)? (?:\\w+ ){0,3}(?:to|into|from)\\b",
        "\\b(?:redesign|refactor\\w*|migrat\\w*|architect\\w*|overhaul|rewrite|re-?implement)\\b",
        "\\bend[- ]to[- ]end\\b",
        "\\bfrom scratch\\b",
        "\\b(?:new|design (?:a|the)) (?:system|service|app|plugin|platform)\\b"
      ] },
      { "id": "risk", "label": "risk", "add": 2, "patterns": [
        "\\b(?:production|prod deploy|deploy to prod|drop table|delete|secrets?|credentials?|customer data|pii|payments?|refunds?|force[- ]push|rm -rf|publish|release)\\b",
        "\\bauth(?:n|z|entication|orization)?\\b",
        "\\b(?:sso|saml|oauth|log ?in|sessions?)\\b"
      ] }
    ],
    "components": {
      "addPerExtraGroup": 2,
      "cap": 6,
      "groups": {
        "backend": "\\b(?:backend|endpoint|api|controller|server|service|handler)\\b",
        "frontend": "\\b(?:frontend|ui|ux|page|component|modal|button|css|react|vue|svelte)\\b",
        "data": "\\b(?:database|schema|table|column|migration|query|sql)\\b",
        "auth": "\\b(?:permissions?|roles?|access control)\\b",
        "tests": "\\b(?:tests?|specs?|e2e|coverage)\\b",
        "infra": "\\b(?:deploy\\w*|ci|pipeline|docker|kubernetes|k8s|terraform|helm)\\b",
        "docs": "\\b(?:docs?|readme|documentation|changelog)\\b",
        "delivery": "\\b(?:pr|pull request|release notes?)\\b"
      }
    },
    "files": { "pattern": "(?:[\\w.-]+/[\\w./-]+|\\b[\\w-]+\\.(?:md|mdx|mjs|cjs|js|jsx|ts|tsx|json|ya?ml|toml|sql|py|rb|go|rs|java|kt|swift|c|cc|cpp|h|hpp|cs|php|sh|css|scss|html|vue|svelte)\\b)", "atLeast": 3, "add": 2 },
    "length": [ { "overChars": 500, "add": 1 }, { "overChars": 1500, "add": 2 } ],
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
}
```

Worked examples with the defaults (keep these as tests):

| Message | Score | Tier |
|---|---|---|
| "thanks" | 0 | trivial |
| "how does the queue work?" | 1 | trivial |
| "fix the typo in the README" | 3 | small |
| "fix the build" | 3 | small (not a large build) |
| "why is the dashboard slow?" | 4 (question 1 + investigation 3; one component) | small |
| "research which models are good for which tasks" | 6 | medium |
| "the login is flaky" | 8 (unmatched 3 + investigation 3 + risk 2) | medium |
| "port the billing service into a plugin" | 9+ | large |
| "build a plugin with a composer toggle, an analytics page and a settings editor, with tests and a PR" | 12+ | xlarge |

### Gears (`lib/gears.ts`)

A gear spec resolves against the provider's live catalog (`bb.sdk.providers.models`), newest
first, so policies survive new model releases. Size classes are read from model names
(small: haiku, mini, nano, flash, lite, small, tiny, spark, instant; large: opus, fable,
mythos, ultra, large, pro, max, xl; everything else medium; the provider default is the
preferred medium). Efforts clamp to what the model supports, never picking a
provider-specific level such as `ultracode` implicitly. `serviceTier` applies only when the
resolved model lists that tier in `supportedServiceTiers`.

## Storage (`bb.storage.database()`, `lib/store.ts`)

Append-only migrations (`bb.storage.migrate`). No message text is stored, only its
length and the classifier's signals.

```sql
CREATE TABLE decisions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at INTEGER NOT NULL,                 -- epoch ms
  thread_id TEXT NOT NULL,
  project_id TEXT,
  provider_id TEXT NOT NULL,
  initiator TEXT NOT NULL,             -- user | agent | system | mixed
  attempt TEXT NOT NULL,               -- start-turn | join-turn
  action TEXT NOT NULL,                -- shift | keep | hold | manual | skip | off
  reason TEXT NOT NULL,
  tier TEXT, score INTEGER, confidence TEXT,
  signals TEXT NOT NULL DEFAULT '[]',  -- JSON array of strings
  chars INTEGER,
  fingerprint TEXT,                    -- sha1(thread_id + text), dedupes re-attempts of one message
  requested_model TEXT, requested_effort TEXT,
  routed_model TEXT, routed_effort TEXT, routed_label TEXT,
  baseline_model TEXT,
  context_tokens INTEGER,
  latency_ms INTEGER,                  -- hook entry to release, for held messages
  queued_message_id TEXT,
  amend_status TEXT,                   -- null | pending | done | failed
  turn_id TEXT,
  input_tokens INTEGER, output_tokens INTEGER, cache_read_tokens INTEGER, cache_write_tokens INTEGER,
  cost_usd REAL, baseline_cost_usd REAL
);
CREATE INDEX decisions_at ON decisions(at);
CREATE INDEX decisions_thread ON decisions(thread_id, at);
CREATE TABLE thread_prefs (thread_id TEXT PRIMARY KEY, enabled INTEGER NOT NULL, updated_at INTEGER NOT NULL);
-- later migrations (append-only)
ALTER TABLE decisions ADD COLUMN routed_service_tier TEXT;
CREATE TABLE queued_links (queued_message_id TEXT PRIMARY KEY, thread_id TEXT NOT NULL, decision_id INTEGER NOT NULL);
CREATE INDEX queued_links_decision ON queued_links(decision_id);
```

One message = one row: every inline first attempt inserts, and re-attempts find their row
through `queued_links` (filled from `message.queued`). The fingerprint is only used to
match a queued row to the decision that created it.

**Usage.** On `thread.idle`, read the thread's latest `thread/tokenUsage/updated` event
(`order: "desc"`, `limit: "1"`). Its `data.tokenUsage.last` is the finished turn's usage
(`inputTokens`, `outputTokens`, `cacheReadInputTokens`, `cacheWriteInputTokens`; fall back to
`cachedInputTokens` as reads when the split is missing) and `scope.turnId` its turn. Attach it to
the thread's newest `start-turn` decision that has no usage yet and is older than the event;
skip if that `turn_id` is already stored. Cost = usage priced at the model the turn ran on
(`routed_model`, else `requested_model`); baseline cost = the same usage priced at the
baseline model.

## RPC contract (`lib/contract.ts`)

The frontend imports **only types** from here (`import type`): this module imports
`@get-bb/plugin-sdk`, which marketplace installs (no dev dependencies) cannot resolve in the
app bundle. Runtime values the app needs live in SDK-free modules: `lib/channels.ts`
(`DECISIONS_CHANGED`) and `lib/policy.ts` (`diffOverrides`, defaults). The contract:

```ts
import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { policySchema } from "./policy";

export const tierSchema = z.enum(["trivial", "small", "medium", "large", "xlarge"]);
export const actionSchema = z.enum(["shift", "keep", "hold", "manual", "skip", "off"]);
export const confidenceSchema = z.enum(["low", "medium", "high"]);

export const gearSchema = z.object({
  model: z.string(),
  label: z.string(),
  effort: z.string().nullable(),
});

export const usageSchema = z.object({
  inputTokens: z.number(),
  outputTokens: z.number(),
  cacheReadTokens: z.number(),
  cacheWriteTokens: z.number(),
});

export const decisionSchema = z.object({
  id: z.number(),
  at: z.number(),
  threadId: z.string(),
  projectId: z.string().nullable(),
  providerId: z.string(),
  initiator: z.string(),
  action: actionSchema,
  reason: z.string(),
  tier: tierSchema.nullable(),
  score: z.number().nullable(),
  confidence: confidenceSchema.nullable(),
  signals: z.array(z.string()),
  requestedModel: z.string().nullable(),
  requestedEffort: z.string().nullable(),
  routedModel: z.string().nullable(),
  routedEffort: z.string().nullable(),
  routedLabel: z.string().nullable(),
  contextTokens: z.number().nullable(),
  latencyMs: z.number().nullable(),
  usage: usageSchema.nullable(),
  costUsd: z.number().nullable(),
  baselineCostUsd: z.number().nullable(),
});
export type DecisionDto = z.infer<typeof decisionSchema>;

export const contributionSchema = z.object({
  id: z.string(),
  label: z.string(),
  kind: z.enum(["floor", "add", "base", "bonus"]),
  value: z.number(),
  match: z.string().nullable(),
});
export type ContributionDto = z.infer<typeof contributionSchema>;

export const previewSchema = z.object({
  enabled: z.boolean(),
  providerId: z.string().nullable(),
  tier: tierSchema.nullable(),
  score: z.number().nullable(),
  confidence: confidenceSchema.nullable(),
  signals: z.array(z.string()),
  /** Where the draft would run if sent now. Null when Gearshift would not route it. */
  gear: gearSchema.nullable(),
  action: actionSchema,
  reason: z.string(),
  /** How the score was built, in order (see Policy → Scoring). */
  contributions: z.array(contributionSchema),
});
export type PreviewDto = z.infer<typeof previewSchema>;

export const threadStateSchema = z.object({
  threadId: z.string(),
  enabled: z.boolean(),
  last: decisionSchema.nullable(),
});
export type ThreadStateDto = z.infer<typeof threadStateSchema>;

const countRow = z.object({ count: z.number(), tokens: z.number(), costUsd: z.number().nullable() });

export const overviewSchema = z.object({
  days: z.number(),
  totals: z.object({
    decisions: z.number(),
    routed: z.number(),          // shift + keep + hold
    shifted: z.number(),         // shift
    held: z.number(),            // hold
    manual: z.number(),
    off: z.number(),
    skipped: z.number(),
    turnsWithUsage: z.number(),
    tokens: z.number(),
    costUsd: z.number(),         // priced turns only
    baselineCostUsd: z.number(), // same turns at the baseline model
    savedUsd: z.number(),        // baselineCostUsd - costUsd over routed turns
    avgLatencyMs: z.number().nullable(), // held messages only
  }),
  byTier: z.array(countRow.extend({ tier: tierSchema })),
  byModel: z.array(countRow.extend({ model: z.string(), label: z.string() })),
  byProvider: z.array(z.object({ providerId: z.string(), count: z.number() })),
  byAction: z.array(z.object({ action: actionSchema, count: z.number() })),
  daily: z.array(z.object({
    day: z.string(),             // yyyy-mm-dd in the server's local time zone
    routed: z.number(),
    shifted: z.number(),
    costUsd: z.number(),
    baselineCostUsd: z.number(),
  })),
  transitions: z.array(z.object({ from: z.string(), to: z.string(), count: z.number() })), // requested → routed model, shifts only
  recent: z.array(decisionSchema), // newest 50
  threadsOff: z.number(),
});
export type OverviewDto = z.infer<typeof overviewSchema>;

export const rpcContract = defineRpcContract({
  preview: {
    input: z.object({
      text: z.string().max(50_000),
      providerId: z.string().nullable(),
      model: z.string().nullable(),
      effort: z.string().nullable(),
      threadId: z.string().nullable(),
      projectId: z.string().nullable(),
      /** Preview against draft policy overrides instead of the saved ones (the policy editor's "Try a message"). */
      overrides: z.record(z.string(), z.unknown()).optional(),
    }),
    output: previewSchema,
  },
  threadState: { input: z.object({ threadId: z.string() }), output: threadStateSchema },
  setThreadEnabled: { input: z.object({ threadId: z.string(), enabled: z.boolean() }), output: threadStateSchema },
  armNewThread: {
    input: z.object({ key: z.string().max(200), projectId: z.string().nullable(), text: z.string().max(50_000), enabled: z.boolean() }),
    output: z.object({ ok: z.boolean() }),
  },
  overview: { input: z.object({ days: z.number().int().min(1).max(365) }), output: overviewSchema },
  getPolicy: { input: z.null(), output: policyStateSchema },
  /** Validates, then stores the overrides in plugin storage. Invalid input is not stored: ok=false + errors. */
  savePolicy: { input: z.object({ overrides: z.record(z.string(), z.unknown()) }), output: policyStateSchema },
  /** Drops overrides under a dotted path ("gears.claude-code", "scoring.classes", "prices"), or all of them for null. */
  resetPolicy: { input: z.object({ path: z.string().nullable() }), output: policyStateSchema },
  /** Enabled providers and their models, for the policy editor's selects. Bounded to 5 s; a provider that fails reports `error`. */
  providers: { input: z.null(), output: providersSchema },
});

export const policyErrorSchema = z.object({ path: z.string(), message: z.string() });

export const policyStateSchema = z.object({
  ok: z.boolean(),                                  // false when the last save was rejected
  defaults: policySchema,
  overrides: z.record(z.string(), z.unknown()),     // what is stored
  effective: policySchema,                          // what routing uses right now
  errors: z.array(policyErrorSchema),               // problems with the stored or rejected overrides
});
export type PolicyStateDto = z.infer<typeof policyStateSchema>;

export const providersSchema = z.object({
  providers: z.array(z.object({
    id: z.string(),
    displayName: z.string(),
    models: z.array(z.object({
      id: z.string(),
      label: z.string(),
      isDefault: z.boolean(),
      efforts: z.array(z.string()),
      serviceTiers: z.array(z.string()),
      sizeClass: z.enum(["small", "medium", "large"]),
    })),
    error: z.string().nullable(),
  })),
});
export type ProvidersDto = z.infer<typeof providersSchema>;

/** Realtime channel: published after any decision insert/update or toggle. Payload `{ threadId: string }`. */
export const DECISIONS_CHANGED = "gearshift-decisions";
```

## New threads

A new thread has no id until it is sent, so its toggle cannot be stored up front. While
the new-thread composer's pill is off, the frontend calls `armNewThread({ key: composer.key,
projectId, text, enabled: false })` (debounced on text changes); turning it back on calls it
with `enabled: true`, which deletes the entry. The server keeps armed entries in memory for
15 min. On a thread's first dispatch (`ctx.thread.status === "pending"`, initiator `user`),
the hook looks for an entry with the same project and the same normalised text
(whitespace-collapsed, trimmed), else the project's only entry younger than 2 min; it
writes `thread_prefs` from it and deletes it.

## Frontend

- **Icon.** `assets/icon.svg` (a five-speed shift gate with the knob in top gear) is
  `bb.branding.icon` and the declared glyph `gearshift/gearshift`
  (`bb.branding.experimental_icons`), used by the pill, popup, plus-menu row, new-thread
  banner and the analytics nav entry.
- **Composer pill** (`app.composer.customize`, scopes `thread` and `new-thread`, an
  `actions` component; expanded layout only). Shows `Auto · Sonnet 5.5 · High` while on:
  the preview of the current draft (debounced 250 ms, one shared state per `composer.key`
  for pill and popup), or the last routed gear when the draft is empty; neutral until the
  thread's state has loaded. Off: `Gearshift off`, muted. Clicking it opens the composer
  popup (`experimental_popups`): the on/off switch, "Score" (the contribution list), "Why"
  (the reason), the last decision, and a link to the analytics page.
- **Plus-menu row** "Gearshift for this thread" opens the same popup
  (`composer.experimental_openPopup`); on compact layouts the host shows it as a drawer.
- **New-thread banner** (`banners`, scope `new-thread`, `chrome: "bare"`): always mounted,
  renders nothing while Gearshift is on; while off it shows a slim "Gearshift is off for
  this new thread · Turn on" line. It owns arming: syncs on mount, re-arms on text changes
  and immediately on toggle, and keeps the off state per `composer.key` in `localStorage`
  so a reload keeps the UI and the server in agreement.
- **Routing policy editor** (`app.slots.settingsSection`), tabs **Gears**, **Scoring**,
  **Try a message** — form controls only. Gears: one table per provider plus "All other
  providers"; model select (the provider's models, "smallest / mid / largest model",
  "provider default", or a family word), effort and service-tier selects from the chosen
  model, and what it resolves to. Scoring: tier bands, signal classes (label, floor, add,
  enabled, patterns list), component groups, question/trivial/continuation patterns,
  bonuses. Try a message: `preview` with the draft overrides, per provider. Local draft
  until Save (sends `diffOverrides`), inline errors by path, changed markers, per-field
  revert, per-section reset and Reset all.
- **Analytics page** (`app.slots.navPanel`, path `analytics`, title "Gearshift"): range
  7/30/90 days; KPI tiles (messages routed, shift rate, estimated saving vs always using
  the top gear, manual-pick rate, average hold delay); tier distribution; model mix; daily
  cost vs the top gear; model transitions; recent decisions with thread links. Costs are
  estimates at public API list prices. Host token classes only.

## CLI and skill

`bb gearshift policy` prints the effective policy (read-only).


`bb gearshift status [--thread <id>]`, `bb gearshift on|off --thread <id>`,
`bb gearshift explain <text…> [--provider <id>]` (classification and gear, no side effects).
`skills/gearshift/SKILL.md` tells agents that Gearshift picks the model per message, that
"use opus" in a message overrides it, and how to use the commands.
