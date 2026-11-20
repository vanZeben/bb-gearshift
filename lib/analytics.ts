// Pure aggregation: decision rows -> OverviewDto.
import type { DecisionDto, OverviewDto } from "./contract";
import { modelLabel } from "./models";
import { spendTokens } from "./team";
import type { DecisionRow, RunRow } from "./store";

export function toDto(r: DecisionRow, labels?: ReadonlyMap<string, string>): DecisionDto {
  const hasUsage = r.input_tokens !== null;
  let signals: string[] = [];
  try { signals = JSON.parse(r.signals) as string[]; } catch { /* keep empty */ }
  return {
    id: r.id, at: r.at, threadId: r.thread_id, projectId: r.project_id, providerId: r.provider_id, initiator: r.initiator,
    action: r.action as DecisionDto["action"], reason: r.reason, tier: r.tier as DecisionDto["tier"], score: r.score,
    confidence: r.confidence as DecisionDto["confidence"], signals, requestedModel: r.requested_model, requestedEffort: r.requested_effort,
    requestedLabel: modelLabel(r.requested_model, labels),
    routedModel: r.routed_model, routedEffort: r.routed_effort, routedLabel: r.routed_label && r.routed_label !== r.routed_model ? r.routed_label : modelLabel(r.routed_model, labels), contextTokens: r.context_tokens, latencyMs: r.latency_ms,
    usage: hasUsage ? { inputTokens: r.input_tokens ?? 0, outputTokens: r.output_tokens ?? 0, cacheReadTokens: r.cache_read_tokens ?? 0, cacheWriteTokens: r.cache_write_tokens ?? 0 } : null,
    costUsd: r.cost_usd, baselineCostUsd: r.baseline_cost_usd,
  };
}

const localDay = (ms: number) => {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};
const tokensOf = (r: DecisionRow) => (r.input_tokens ?? 0) + (r.output_tokens ?? 0) + (r.cache_read_tokens ?? 0) + (r.cache_write_tokens ?? 0);
const ROUTED = new Set(["shift", "keep", "hold"]);

const HIST_BUCKETS = ["0-25%", "25-50%", "50-80%", "80-100%", "over 100%"] as const;
const bucketOf = (f: number) => (f < 0.25 ? 0 : f < 0.5 ? 1 : f < 0.8 ? 2 : f <= 1 ? 3 : 4);

/** Lead (decision turns) versus sub-agent (runs) spend, runs by role, over-budget runs and a budget-used histogram. */
export function buildFanout(rows: DecisionRow[], runs: RunRow[], labels: ReadonlyMap<string, string> = new Map()): OverviewDto["fanout"] {
  const lead = rows.reduce((n, r) => n + (r.input_tokens === null ? 0 : spendTokens({ inputTokens: r.input_tokens ?? 0, outputTokens: r.output_tokens ?? 0, cacheReadTokens: r.cache_read_tokens ?? 0, cacheWriteTokens: r.cache_write_tokens ?? 0 })), 0);
  const role = new Map<string, { count: number; spent: number; budget: number; over: number }>();
  const hist = HIST_BUCKETS.map((bucket) => ({ bucket, count: 0 }));
  let sub = 0, over = 0;
  for (const r of runs) {
    sub += r.spent;
    const isOver = r.over_budget === 1 || (r.budget > 0 && r.spent >= r.budget);
    if (isOver) over++;
    const e = role.get(r.role) ?? { count: 0, spent: 0, budget: 0, over: 0 };
    e.count++; e.spent += r.spent; e.budget += r.budget; if (isOver) e.over++;
    role.set(r.role, e);
    if (r.budget > 0) hist[bucketOf(r.spent / r.budget)]!.count++;
  }
  return {
    leadTokens: lead, subTokens: sub, runs: runs.length, overBudget: over,
    byRole: [...role.entries()].map(([name, e]) => ({ role: name, ...e })).sort((a, b) => b.count - a.count),
    budgetUsed: hist,
    recent: runs.slice(-20).reverse().map((r) => ({ id: r.id, childThreadId: r.child_thread_id, role: r.role, tier: r.tier, modelLabel: r.model_label ?? (r.model ? modelLabel(r.model, labels) : null), effort: r.effort, spent: r.spent, budget: r.budget, status: r.status, startedAt: r.started_at })),
  };
}

export function buildOverview(rows: DecisionRow[], days: number, threadsOff: number, now = Date.now(), runs: RunRow[] = [], knownLabels?: ReadonlyMap<string, string>): OverviewDto {
  // One label per model id: the catalog label the router saw, else a prettified id. Never a raw id next to a display name.
  const labels = new Map<string, string>(knownLabels ?? []);
  for (const r of rows) if (r.routed_model && r.routed_label && r.routed_label !== r.routed_model) labels.set(r.routed_model, r.routed_label);
  const t = { decisions: rows.length, routed: 0, shifted: 0, held: 0, manual: 0, off: 0, skipped: 0, turnsWithUsage: 0, tokens: 0, costUsd: 0, baselineCostUsd: 0, savedUsd: 0, avgLatencyMs: null as number | null };
  const tier = new Map<string, { count: number; tokens: number; cost: number | null }>();
  const model = new Map<string, { label: string; count: number; tokens: number; cost: number | null }>();
  const provider = new Map<string, number>();
  const action = new Map<string, number>();
  const daily = new Map<string, { routed: number; shifted: number; costUsd: number; baselineCostUsd: number }>();
  const trans = new Map<string, { from: string; to: string; fromLabel: string; toLabel: string; count: number }>();
  const lat: number[] = [];
  const add = (cur: number | null, v: number | null) => (v === null ? cur : (cur ?? 0) + v);

  for (let i = 0; i <= days - 1; i++) {
    const k = localDay(now - i * 86_400_000);
    daily.set(k, { routed: 0, shifted: 0, costUsd: 0, baselineCostUsd: 0 });
  }
  for (const r of rows) {
    const routed = ROUTED.has(r.action);
    if (routed) t.routed++;
    if (r.action === "shift") t.shifted++;
    if (r.action === "hold") t.held++;
    if (r.action === "manual") t.manual++;
    if (r.action === "off") t.off++;
    if (r.action === "skip") t.skipped++;
    if (r.action === "hold" && r.latency_ms !== null) lat.push(r.latency_ms);
    else if (r.action === "shift" && r.latency_ms !== null) lat.push(r.latency_ms);
    action.set(r.action, (action.get(r.action) ?? 0) + 1);
    provider.set(r.provider_id, (provider.get(r.provider_id) ?? 0) + 1);
    const tok = tokensOf(r);
    const priced = r.cost_usd !== null;
    if (r.input_tokens !== null) { t.turnsWithUsage++; t.tokens += tok; }
    const day = daily.get(localDay(r.at)) ?? { routed: 0, shifted: 0, costUsd: 0, baselineCostUsd: 0 };
    daily.set(localDay(r.at), day);
    if (routed) day.routed++;
    if (r.action === "shift") day.shifted++;
    if (routed && priced) {
      t.costUsd += r.cost_usd!;
      const b = r.baseline_cost_usd ?? r.cost_usd!;
      t.baselineCostUsd += b;
      day.costUsd += r.cost_usd!;
      day.baselineCostUsd += b;
    }
    if (r.tier) {
      const e = tier.get(r.tier) ?? { count: 0, tokens: 0, cost: null };
      e.count++; e.tokens += tok; e.cost = add(e.cost, r.cost_usd); tier.set(r.tier, e);
    }
    const mid = r.routed_model ?? r.requested_model;
    if (mid) {
      const e = model.get(mid) ?? { label: modelLabel(mid, labels)!, count: 0, tokens: 0, cost: null };
      e.count++; e.tokens += tok; e.cost = add(e.cost, r.cost_usd); model.set(mid, e);
    }
    if (r.action === "shift" && r.requested_model && r.routed_model && r.requested_model !== r.routed_model) {
      const k = `${r.requested_model}\u0000${r.routed_model}`;
      const e = trans.get(k) ?? { from: r.requested_model, to: r.routed_model, fromLabel: modelLabel(r.requested_model, labels)!, toLabel: modelLabel(r.routed_model, labels)!, count: 0 };
      e.count++; trans.set(k, e);
    }
  }
  t.savedUsd = t.baselineCostUsd - t.costUsd;
  t.avgLatencyMs = lat.length ? Math.round(lat.reduce((a, b) => a + b, 0) / lat.length) : null;
  const TIER_ORDER = ["trivial", "small", "medium", "large", "xlarge"] as const;
  return {
    days,
    totals: t,
    byTier: TIER_ORDER.filter((x) => tier.has(x)).map((x) => ({ tier: x, count: tier.get(x)!.count, tokens: tier.get(x)!.tokens, costUsd: tier.get(x)!.cost })),
    byModel: [...model.entries()].map(([m, e]) => ({ model: m, label: e.label, count: e.count, tokens: e.tokens, costUsd: e.cost })).sort((a, b) => b.count - a.count),
    byProvider: [...provider.entries()].map(([providerId, count]) => ({ providerId, count })).sort((a, b) => b.count - a.count),
    byAction: [...action.entries()].map(([a, count]) => ({ action: a as DecisionDto["action"], count })),
    daily: [...daily.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([day, v]) => ({ day, ...v })),
    transitions: [...trans.values()].sort((a, b) => b.count - a.count),
    recent: rows.slice(-50).reverse().map((r) => toDto(r, labels)),
    fanout: buildFanout(rows, runs, labels),
    threadsOff,
  };
}
