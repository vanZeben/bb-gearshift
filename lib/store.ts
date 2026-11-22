// SQLite persistence. No message text is written to disk: only a salted-free hash fingerprint, length and classifier signals.
import { createHash } from "node:crypto";
import type Database from "better-sqlite3";
import type { Usage } from "./pricing";

export const MIGRATIONS: string[] = [
  `CREATE TABLE decisions (
  id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, thread_id TEXT NOT NULL, project_id TEXT,
  provider_id TEXT NOT NULL, initiator TEXT NOT NULL, attempt TEXT NOT NULL, action TEXT NOT NULL, reason TEXT NOT NULL,
  tier TEXT, score INTEGER, confidence TEXT, signals TEXT NOT NULL DEFAULT '[]', chars INTEGER, fingerprint TEXT,
  requested_model TEXT, requested_effort TEXT, routed_model TEXT, routed_effort TEXT, routed_label TEXT, baseline_model TEXT,
  context_tokens INTEGER, latency_ms INTEGER, queued_message_id TEXT, amend_status TEXT, turn_id TEXT,
  input_tokens INTEGER, output_tokens INTEGER, cache_read_tokens INTEGER, cache_write_tokens INTEGER,
  cost_usd REAL, baseline_cost_usd REAL)`,
  `CREATE INDEX decisions_at ON decisions(at)`,
  `CREATE INDEX decisions_thread ON decisions(thread_id, at)`,
  `CREATE TABLE thread_prefs (thread_id TEXT PRIMARY KEY, enabled INTEGER NOT NULL, updated_at INTEGER NOT NULL)`,
  // Migrations are append-only: never edit a statement above once shipped.
  `ALTER TABLE decisions ADD COLUMN routed_service_tier TEXT`,
  // Links bb queue rows to the decision made for them (one decision can cover a grouped drain of several rows).
  `CREATE TABLE queued_links (queued_message_id TEXT PRIMARY KEY, thread_id TEXT NOT NULL, decision_id INTEGER NOT NULL)`,
  `CREATE INDEX queued_links_decision ON queued_links(decision_id)`,
  // Sub-agent runs started by gearshift_spawn (one row per child thread).
  `CREATE TABLE runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT, parent_thread_id TEXT NOT NULL, child_thread_id TEXT NOT NULL, role TEXT NOT NULL,
  tier TEXT NOT NULL, provider TEXT NOT NULL, model TEXT, effort TEXT, budget INTEGER NOT NULL, spent INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'running', started_at INTEGER NOT NULL, ended_at INTEGER)`,
  `CREATE UNIQUE INDEX runs_child ON runs(child_thread_id)`,
  `CREATE INDEX runs_started ON runs(started_at)`,
  // A child whose last turn crossed its budget is finished, not stopped: it keeps counting as over budget.
  `ALTER TABLE runs ADD COLUMN over_budget INTEGER NOT NULL DEFAULT 0`,
  `ALTER TABLE runs ADD COLUMN model_label TEXT`,
  // Roles a decision's signals added to its team (role names only, never message text).
  `ALTER TABLE decisions ADD COLUMN signal_roles TEXT NOT NULL DEFAULT '[]'`,
  // How a hold treated the message (gear | effort | continuation | downshift), the decision whose gear it inherited,
  // the gear the thread was on before the message, and a short hash of the policy the decision was made under.
  `ALTER TABLE decisions ADD COLUMN hold_kind TEXT`,
  `ALTER TABLE decisions ADD COLUMN hold_origin_id INTEGER`,
  `ALTER TABLE decisions ADD COLUMN current_model TEXT`,
  `ALTER TABLE decisions ADD COLUMN current_effort TEXT`,
  `ALTER TABLE decisions ADD COLUMN policy_rev TEXT`,
];

export type RunStatus = "running" | "done" | "nudged" | "stopped" | "failed";
export interface RunRow {
  id: number; parent_thread_id: string; child_thread_id: string; role: string; tier: string; provider: string;
  model: string | null; effort: string | null; budget: number; spent: number; status: RunStatus; started_at: number; ended_at: number | null;
  over_budget: number; model_label: string | null;
}
export type NewRun = Omit<RunRow, "id" | "spent" | "status" | "ended_at" | "over_budget" | "model_label"> & { model_label?: string | null };

export interface DecisionRow {
  id: number; at: number; thread_id: string; project_id: string | null; provider_id: string; initiator: string; attempt: string;
  action: string; reason: string; tier: string | null; score: number | null; confidence: string | null; signals: string;
  chars: number | null; fingerprint: string | null; requested_model: string | null; requested_effort: string | null;
  routed_model: string | null; routed_effort: string | null; routed_label: string | null; routed_service_tier: string | null; baseline_model: string | null;
  context_tokens: number | null; latency_ms: number | null; queued_message_id: string | null; amend_status: string | null;
  turn_id: string | null; input_tokens: number | null; output_tokens: number | null; cache_read_tokens: number | null;
  cache_write_tokens: number | null; cost_usd: number | null; baseline_cost_usd: number | null; signal_roles?: string;
  /** Rows written before these columns existed read them as null (or undefined in hand-built rows). */
  hold_kind?: string | null; hold_origin_id?: number | null; current_model?: string | null; current_effort?: string | null; policy_rev?: string | null;
}
export type NewDecision = Omit<DecisionRow, "id" | "routed_service_tier" | "latency_ms" | "turn_id" | "input_tokens" | "output_tokens" | "cache_read_tokens" | "cache_write_tokens" | "cost_usd" | "baseline_cost_usd" | "queued_message_id"> &
  Partial<Pick<DecisionRow, "queued_message_id">> & { routed_service_tier?: string | null };

export function fingerprint(threadId: string, text: string): string {
  return createHash("sha1").update(threadId + text.replace(/\s+/g, " ").trim()).digest("hex");
}

export class Store {
  constructor(readonly db: Database.Database) {}

  static migrate(db: Database.Database, migrate: (db: Database.Database, s: string[]) => void): Store {
    migrate(db, MIGRATIONS);
    return new Store(db);
  }

  /** Always inserts: every inline first attempt is its own decision. */
  insertDecision(d: NewDecision): number {
    const cols = Object.keys(d).filter((k) => (d as Record<string, unknown>)[k] !== undefined);
    const r = this.db.prepare(`INSERT INTO decisions (${cols.join(",")}) VALUES (${cols.map((c) => "@" + c).join(",")})`).run(d);
    return Number(r.lastInsertRowid);
  }

  /** The decision linked to a bb queue row, if any. */
  forQueued(threadId: string, queuedMessageId: string): DecisionRow | undefined {
    return this.db.prepare(`SELECT d.* FROM queued_links l JOIN decisions d ON d.id=l.decision_id WHERE l.queued_message_id=? AND l.thread_id=?`).get(queuedMessageId, threadId) as DecisionRow | undefined;
  }

  /** Link queue rows to a decision (first row also goes in the decision's queued_message_id). */
  linkQueued(decisionId: number, threadId: string, queuedMessageIds: string[]): void {
    const ins = this.db.prepare(`INSERT OR REPLACE INTO queued_links (queued_message_id, thread_id, decision_id) VALUES (?,?,?)`);
    for (const id of queuedMessageIds) ins.run(id, threadId, decisionId);
    const d = this.get(decisionId);
    if (d && !d.queued_message_id && queuedMessageIds[0]) this.patch(decisionId, { queued_message_id: queuedMessageIds[0] });
  }

  /** Newest decision of the thread with this fingerprint that has no queue row yet, made at or after `since`. */
  unlinkedByFingerprint(threadId: string, fp: string, since: number): DecisionRow | undefined {
    return this.db.prepare(`SELECT * FROM decisions WHERE thread_id=? AND fingerprint=? AND queued_message_id IS NULL AND at>=? ORDER BY id DESC LIMIT 1`).get(threadId, fp, since) as DecisionRow | undefined;
  }

  patch(id: number, fields: Partial<Omit<DecisionRow, "id">>): void {
    const cols = Object.keys(fields);
    if (cols.length === 0) return;
    this.db.prepare(`UPDATE decisions SET ${cols.map((c) => `${c}=@${c}`).join(",")} WHERE id=@id`).run({ ...fields, id });
  }

  get(id: number): DecisionRow | undefined {
    return this.db.prepare(`SELECT * FROM decisions WHERE id=?`).get(id) as DecisionRow | undefined;
  }

  /**
   * The decision whose gear a hold on this thread inherits: the newest routed or hand-picked start-turn decision;
   * when that was itself a hold, the decision it inherited from.
   */
  holdOrigin(threadId: string): number | null {
    const r = this.db.prepare(`SELECT id, action, hold_origin_id FROM decisions WHERE thread_id=? AND attempt='start-turn' AND action IN ('shift','keep','hold','manual') ORDER BY id DESC LIMIT 1`).get(threadId) as { id: number; action: string; hold_origin_id: number | null } | undefined;
    if (!r) return null;
    return r.action === "hold" ? r.hold_origin_id ?? r.id : r.id;
  }

  lastForThread(threadId: string): DecisionRow | undefined {
    return this.db.prepare(`SELECT * FROM decisions WHERE thread_id=? ORDER BY id DESC LIMIT 1`).get(threadId) as DecisionRow | undefined;
  }

  /** Newest start-turn decision with no usage yet and older than the usage event. */
  openForUsage(threadId: string, eventAt: number): DecisionRow | undefined {
    return this.db.prepare(`SELECT * FROM decisions WHERE thread_id=? AND attempt='start-turn' AND input_tokens IS NULL AND at<=? AND action IN ('shift','keep','hold','manual','skip','off') ORDER BY id DESC LIMIT 1`).get(threadId, eventAt) as DecisionRow | undefined;
  }

  hasTurn(threadId: string, turnId: string): boolean {
    return !!this.db.prepare(`SELECT 1 FROM decisions WHERE thread_id=? AND turn_id=? LIMIT 1`).get(threadId, turnId);
  }

  attachUsage(id: number, turnId: string | null, u: Usage, cost: number | null, baseline: number | null): void {
    this.patch(id, { turn_id: turnId, input_tokens: u.inputTokens, output_tokens: u.outputTokens, cache_read_tokens: u.cacheReadTokens, cache_write_tokens: u.cacheWriteTokens, cost_usd: cost, baseline_cost_usd: baseline });
  }

  since(ms: number): DecisionRow[] {
    return this.db.prepare(`SELECT * FROM decisions WHERE at>=? ORDER BY at ASC, id ASC`).all(ms) as DecisionRow[];
  }

  prune(olderThan: number): number {
    const n = this.db.prepare(`DELETE FROM decisions WHERE at<?`).run(olderThan).changes;
    this.db.prepare(`DELETE FROM queued_links WHERE decision_id NOT IN (SELECT id FROM decisions)`).run();
    this.db.prepare(`DELETE FROM runs WHERE started_at<? AND status NOT IN ('running','nudged')`).run(olderThan);
    return n;
  }

  /** Display labels the router has seen for model ids (from routed decisions). */
  modelLabels(): Map<string, string> {
    const rows = this.db.prepare(`SELECT routed_model m, routed_label l FROM decisions WHERE routed_model IS NOT NULL AND routed_label IS NOT NULL AND routed_label != routed_model GROUP BY routed_model`).all() as Array<{ m: string; l: string }>;
    return new Map(rows.map((r) => [r.m, r.l]));
  }

  insertRun(r: NewRun): number {
    return Number(this.db.prepare(`INSERT INTO runs (parent_thread_id, child_thread_id, role, tier, provider, model, model_label, effort, budget, started_at) VALUES (@parent_thread_id,@child_thread_id,@role,@tier,@provider,@model,@model_label,@effort,@budget,@started_at)`).run({ model_label: null, ...r }).lastInsertRowid);
  }
  runForChild(childThreadId: string): RunRow | undefined {
    return this.db.prepare(`SELECT * FROM runs WHERE child_thread_id=?`).get(childThreadId) as RunRow | undefined;
  }
  /** Runs whose child may still be working. */
  openRuns(): RunRow[] {
    return this.db.prepare(`SELECT * FROM runs WHERE status IN ('running','nudged') ORDER BY id`).all() as RunRow[];
  }
  /** Atomically move a run from one of `from` to `to`. True only for the caller that made the transition. */
  claimRun(id: number, from: readonly RunStatus[], to: RunStatus, f: Partial<Pick<RunRow, "ended_at" | "over_budget">> = {}): boolean {
    const sets = ["status=@to", ...Object.keys(f).map((c) => `${c}=@${c}`)];
    const marks = from.map((_, i) => `@f${i}`).join(",");
    const params: Record<string, unknown> = { id, to, ...f };
    from.forEach((v, i) => { params[`f${i}`] = v; });
    return this.db.prepare(`UPDATE runs SET ${sets.join(",")} WHERE id=@id AND status IN (${marks})`).run(params).changes === 1;
  }
  openRunCount(parentThreadId?: string): number {
    const q = parentThreadId ? this.db.prepare(`SELECT COUNT(*) n FROM runs WHERE status IN ('running','nudged') AND parent_thread_id=?`).get(parentThreadId) : this.db.prepare(`SELECT COUNT(*) n FROM runs WHERE status IN ('running','nudged')`).get();
    return (q as { n: number }).n;
  }
  /** Open runs started before `before` are abandoned (their thread never reported back): mark them failed. */
  failStale(before: number, now = Date.now()): number {
    return this.db.prepare(`UPDATE runs SET status='failed', ended_at=? WHERE status IN ('running','nudged') AND started_at<?`).run(now, before).changes;
  }
  /** Tier of the newest medium-or-larger decision of the thread. */
  lastNoteworthyTier(threadId: string): string | null {
    const r = this.db.prepare(`SELECT tier FROM decisions WHERE thread_id=? AND tier IN ('medium','large','xlarge') ORDER BY id DESC LIMIT 1`).get(threadId) as { tier: string } | undefined;
    return r?.tier ?? null;
  }
  /** Roles the signals of the thread's last noteworthy decision added to its team. */
  lastSignalRoles(threadId: string): string[] {
    const r = this.db.prepare(`SELECT signal_roles FROM decisions WHERE thread_id=? AND tier IN ('medium','large','xlarge') ORDER BY id DESC LIMIT 1`).get(threadId) as { signal_roles: string } | undefined;
    try { return r ? (JSON.parse(r.signal_roles) as string[]) : []; } catch { return []; }
  }
  patchRun(id: number, f: Partial<Pick<RunRow, "spent" | "status" | "ended_at">>): void {
    const cols = Object.keys(f);
    if (cols.length) this.db.prepare(`UPDATE runs SET ${cols.map((c) => `${c}=@${c}`).join(",")} WHERE id=@id`).run({ ...f, id });
  }
  runsSince(ms: number): RunRow[] {
    return this.db.prepare(`SELECT * FROM runs WHERE started_at>=? ORDER BY id`).all(ms) as RunRow[];
  }

  getPref(threadId: string): boolean | null {
    const r = this.db.prepare(`SELECT enabled FROM thread_prefs WHERE thread_id=?`).get(threadId) as { enabled: number } | undefined;
    return r ? r.enabled === 1 : null;
  }
  setPref(threadId: string, enabled: boolean, now = Date.now()): void {
    this.db.prepare(`INSERT INTO thread_prefs (thread_id, enabled, updated_at) VALUES (?,?,?) ON CONFLICT(thread_id) DO UPDATE SET enabled=excluded.enabled, updated_at=excluded.updated_at`).run(threadId, enabled ? 1 : 0, now);
  }
  deletePref(threadId: string): void {
    this.db.prepare(`DELETE FROM thread_prefs WHERE thread_id=?`).run(threadId);
  }
  countOff(): number {
    return (this.db.prepare(`SELECT COUNT(*) n FROM thread_prefs WHERE enabled=0`).get() as { n: number }).n;
  }
}
