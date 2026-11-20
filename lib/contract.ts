import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { DECISIONS_CHANGED } from "./channels";
import { policySchema } from "./policy";

export const tierSchema = z.enum(["trivial", "small", "medium", "large", "xlarge"]);
export const actionSchema = z.enum(["shift", "keep", "hold", "manual", "skip", "off"]);
export const confidenceSchema = z.enum(["low", "medium", "high"]);

export const gearSchema = z.object({
  model: z.string(),
  label: z.string(),
  effort: z.string().nullable(),
  serviceTier: z.string().nullable(),
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
  /** How the score was built, in order (see Policy -> Scoring). */
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
  /** Validates, then stores the overrides in the `policy` setting. Invalid input is not stored: ok=false + errors. */
  savePolicy: { input: z.object({ overrides: z.record(z.string(), z.unknown()) }), output: policyStateSchema },
  /** Drops overrides under a dotted path ("gears.claude-code", "scoring.classes", "prices"), or all of them for null. */
  resetPolicy: { input: z.object({ path: z.string().nullable() }), output: policyStateSchema },
  /** Enabled providers and their models, for the policy editor's selects. Bounded to 5 s; a provider that fails reports `error`. */
  providers: { input: z.null(), output: providersSchema },
});

/** Re-exported for server-side callers. The app must import it from "./channels" (this module pulls in the server SDK). */
export { DECISIONS_CHANGED };
