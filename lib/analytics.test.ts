import { describe, expect, it } from "vitest";
import { buildOverview, toDto } from "./analytics";
import type { DecisionRow } from "./store";

const NOW = new Date(2026, 10, 20, 12).getTime();
let n = 0;
const r = (o: Partial<DecisionRow> = {}): DecisionRow => ({
  id: ++n, at: NOW - 1000, thread_id: "t", project_id: null, provider_id: "claude-code", initiator: "user", attempt: "start-turn", action: "shift", reason: "",
  tier: "small", score: 3, confidence: "high", signals: "[]", chars: 1, fingerprint: null, requested_model: "opus", requested_effort: null, routed_model: "sonnet",
  routed_effort: null, routed_label: "Sonnet", routed_service_tier: null, baseline_model: "opus", context_tokens: null, latency_ms: null, queued_message_id: null,
  amend_status: null, turn_id: null, input_tokens: null, output_tokens: null, cache_read_tokens: null, cache_write_tokens: null, cost_usd: null, baseline_cost_usd: null, ...o,
});

describe("buildOverview", () => {
  const rows = [
    r({ input_tokens: 10, output_tokens: 5, cache_read_tokens: 0, cache_write_tokens: 0, cost_usd: 1, baseline_cost_usd: 4, latency_ms: 100 }),
    r({ action: "keep", routed_model: "opus", routed_label: "Opus", tier: "large", requested_model: "opus", input_tokens: 1, output_tokens: 1, cache_read_tokens: 0, cache_write_tokens: 0, cost_usd: 2, baseline_cost_usd: 2 }),
    r({ action: "hold", latency_ms: 300 }),
    r({ action: "manual", tier: null }),
    r({ action: "off", tier: null }),
    r({ action: "skip", tier: null, provider_id: "codex" }),
    r({ at: NOW - 3 * 86_400_000 }),
  ];
  const o = buildOverview(rows, 7, 2, NOW);
  it("counts actions", () => {
    expect(o.totals).toMatchObject({ decisions: 7, routed: 4, shifted: 2, held: 1, manual: 1, off: 1, skipped: 1, turnsWithUsage: 2, tokens: 17 });
    expect(o.threadsOff).toBe(2);
  });
  it("sums cost, baseline and saving over priced routed turns", () => {
    expect(o.totals.costUsd).toBe(3);
    expect(o.totals.baselineCostUsd).toBe(6);
    expect(o.totals.savedUsd).toBe(3);
    expect(o.totals.avgLatencyMs).toBe(200);
  });
  it("breaks down by tier, model, provider and day", () => {
    expect(o.byTier.map((t) => t.tier)).toEqual(["small", "large"]);
    expect(o.byModel.find((m) => m.model === "sonnet")!.label).toBe("Sonnet");
    expect(o.byProvider.find((p) => p.providerId === "codex")!.count).toBe(1);
    expect(o.daily).toHaveLength(7);
    expect(o.daily.at(-1)!.routed).toBe(3);
    expect(o.transitions).toEqual([{ from: "opus", fromLabel: "Opus", to: "sonnet", toLabel: "Sonnet", count: 2 }]);
  });
  it("lists the newest rows first", () => {
    expect(o.recent[0]!.id).toBe(rows.at(-1)!.id);
  });
  it("handles no data", () => {
    const e = buildOverview([], 30, 0, NOW);
    expect(e.totals.decisions).toBe(0);
    expect(e.totals.avgLatencyMs).toBeNull();
    expect(e.daily).toHaveLength(30);
  });
});

describe("buildFanout", () => {
  it("lists recent runs newest first with model labels", () => {
    const run = (id: number, spent: number) => ({ id, parent_thread_id: "p", child_thread_id: `c${id}`, role: "qa", tier: "medium", provider: "claude-code", model: "claude-haiku-5-5", effort: "low", budget: 100, spent, status: "done", started_at: id } as never);
    const f = buildOverview([], 7, 0, NOW, [run(1, 50), run(2, 120)], new Map([["claude-haiku-5-5", "Haiku 5.5"]])).fanout;
    expect(f.recent.map((r) => r.id)).toEqual([2, 1]);
    expect(f.recent[0]).toMatchObject({ modelLabel: "Haiku 5.5", spent: 120, budget: 100, status: "done" });
    expect(f.overBudget).toBe(1);
  });
});

describe("toDto", () => {
  it("maps usage only when present and tolerates bad signals", () => {
    expect(toDto(r()).usage).toBeNull();
    expect(toDto(r({ signals: "not json" })).signals).toEqual([]);
    expect(toDto(r({ input_tokens: 1 })).usage).toEqual({ inputTokens: 1, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 });
  });
});
