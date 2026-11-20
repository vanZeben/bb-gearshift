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
];

export interface DecisionRow {
  id: number; at: number; thread_id: string; project_id: string | null; provider_id: string; initiator: string; attempt: string;
  action: string; reason: string; tier: string | null; score: number | null; confidence: string | null; signals: string;
  chars: number | null; fingerprint: string | null; requested_model: string | null; requested_effort: string | null;
  routed_model: string | null; routed_effort: string | null; routed_label: string | null; routed_service_tier: string | null; baseline_model: string | null;
  context_tokens: number | null; latency_ms: number | null; queued_message_id: string | null; amend_status: string | null;
  turn_id: string | null; input_tokens: number | null; output_tokens: number | null; cache_read_tokens: number | null;
  cache_write_tokens: number | null; cost_usd: number | null; baseline_cost_usd: number | null;
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
    return n;
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
