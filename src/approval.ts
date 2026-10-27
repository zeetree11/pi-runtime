import { DatabaseSync } from "node:sqlite";
import path from "node:path";

/**
 * Human-in-the-loop approvals.
 *
 * What this is, precisely: **task-level** approval, not per-syscall interception. The runtime
 * cannot stop the tool loop mid-flight — pi executes tools itself, and cutting the process after
 * `tool_execution_start` races the side effect we were trying to prevent. So the agent *asks
 * first* (a control token, same pattern as `<!--state:-->` and `<!--remind:-->`), the runtime
 * parks the task, and the next task runs with an explicit grant.
 *
 * What that buys and what it costs:
 *
 * - buys: a risky action cannot happen silently; the user sees it and can refuse; a refusal is
 *   recorded, and an unanswered request expires instead of hanging forever.
 * - costs: the model must cooperate by emitting the token. A model that ignores the convention
 *   simply never asks — so this is a *consent* mechanism, not a *sandbox*. The sandbox
 *   (`PI_RT_SANDBOX`) is still the thing that enforces capability.
 *
 * That distinction is the honest answer to "how do you do HITL": park, ask, grant, resume — and
 * say out loud that enforcement lives in the sandbox, not in the approval flow.
 */
export type ApprovalStatus = "pending" | "approved" | "denied" | "expired";

export type ApprovalRow = {
  id: number;
  thread: string;
  taskId: string | null;
  prompt: string;
  action: string;
  /** The original user request, so approval can resume it without copy-paste. */
  request: string;
  status: ApprovalStatus;
  createdAt: string;
  expiresAt: string;
  decidedAt: string | null;
};

export type ApprovalDirective = { action: string };

/** `<!--ask: 要执行 rm -rf build，批准吗？-->` */
const ASK = /<!--\s*ask:\s*([^>]{1,300}?)\s*-->/gi;

export function extractAskDirectives(text: string): { asks: ApprovalDirective[]; cleaned: string } {
  const asks: ApprovalDirective[] = [];
  const cleaned = (text ?? "").replace(ASK, (_match, body: string) => {
    const action = String(body).trim();
    if (!action) return _match;
    asks.push({ action });
    return "";
  });
  return { asks, cleaned: cleaned.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim() };
}

/** Affirmative / negative phrases accepted as a decision. Deliberately narrow. */
const YES = /^(同意|批准|可以|批准执行|approve|yes|y|ok)$/i;
const NO = /^(拒绝|不同意|不要|别|取消|deny|no|n)$/i;

export function parseDecision(text: string): "approved" | "denied" | null {
  const trimmed = String(text ?? "").trim().replace(/[。！!，,\s]+$/g, "");
  if (YES.test(trimmed)) return "approved";
  if (NO.test(trimmed)) return "denied";
  return null;
}

/** Grants: a thread may run with elevated capability until this moment. */
export type Grant = { thread: string; until: number };

export class ApprovalStore {
  private readonly db: DatabaseSync;
  private readonly defaultTtlMinutes: number;

  constructor(dataDir: string, defaultTtlMinutes = 5) {
    // Node's type stripping has no parameter properties; assign explicitly.
    this.defaultTtlMinutes = defaultTtlMinutes;
    this.db = new DatabaseSync(path.join(dataDir, "runtime.db"));
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec("PRAGMA busy_timeout = 5000;");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS approvals (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        thread     TEXT NOT NULL,
        task_id    TEXT,
        prompt     TEXT NOT NULL,
        action     TEXT NOT NULL,
        request    TEXT NOT NULL,
        status     TEXT NOT NULL DEFAULT 'pending',
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        decided_at TEXT
      );
    `);
    this.db.exec("CREATE INDEX IF NOT EXISTS idx_approvals_thread ON approvals(thread, status, expires_at);");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS approval_grants (
        thread   TEXT PRIMARY KEY,
        until    INTEGER NOT NULL,
        approved_by TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
    `);
  }

  request(input: { thread: string; taskId?: string | null; action: string; request: string; ttlMinutes?: number }): ApprovalRow {
    const ttl = Math.max(1, input.ttlMinutes ?? this.defaultTtlMinutes);
    const now = new Date();
    const expires = new Date(now.getTime() + ttl * 60_000);
    const result = this.db
      .prepare(
        `INSERT INTO approvals (thread, task_id, prompt, action, request, status, created_at, expires_at)
         VALUES (?, ?, ?, ?, ?, 'pending', ?, ?)`,
      )
      .run(
        input.thread,
        input.taskId ?? null,
        `要执行：${input.action}\n回复「同意」执行，回复「拒绝」取消（${ttl} 分钟内有效）。`,
        input.action,
        input.request,
        now.toISOString(),
        expires.toISOString(),
      );
    return this.byId(Number(result.lastInsertRowid))!;
  }

  byId(id: number): ApprovalRow | null {
    const row = this.db.prepare("SELECT * FROM approvals WHERE id = ?").get(id) as Record<string, unknown> | undefined;
    return row ? toRow(row) : null;
  }

  /** Newest pending approval for a thread that has not expired yet. */
  pendingFor(thread: string, now = new Date()): ApprovalRow | null {
    const row = this.db
      .prepare(
        `SELECT * FROM approvals
          WHERE thread = ? AND status = 'pending' AND expires_at > ?
          ORDER BY id DESC LIMIT 1`,
      )
      .get(thread, now.toISOString()) as Record<string, unknown> | undefined;
    return row ? toRow(row) : null;
  }

  /** Mark timed-out approvals expired. Returns how many were closed. */
  expire(now = new Date()): number {
    const result = this.db
      .prepare("UPDATE approvals SET status = 'expired', decided_at = ? WHERE status = 'pending' AND expires_at <= ?")
      .run(now.toISOString(), now.toISOString());
    return Number(result.changes);
  }

  decide(id: number, decision: "approved" | "denied", options: { grantTtlMinutes?: number; approvedBy?: string } = {}): ApprovalRow | null {
    const row = this.byId(id);
    if (!row || row.status !== "pending") return null;
    this.db
      .prepare("UPDATE approvals SET status = ?, decided_at = ? WHERE id = ?")
      .run(decision, new Date().toISOString(), id);
    if (decision === "approved") {
      const ttl = Math.max(1, options.grantTtlMinutes ?? this.defaultTtlMinutes);
      this.grant(row.thread, ttl, options.approvedBy ?? "user");
    }
    return this.byId(id);
  }

  grant(thread: string, ttlMinutes: number, approvedBy: string): void {
    const until = Date.now() + Math.max(1, ttlMinutes) * 60_000;
    this.db
      .prepare(
        `INSERT INTO approval_grants (thread, until, approved_by, created_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(thread) DO UPDATE SET until = excluded.until, approved_by = excluded.approved_by, created_at = excluded.created_at`,
      )
      .run(thread, until, approvedBy, new Date().toISOString());
  }

  /** Is this thread currently allowed to run elevated? */
  hasGrant(thread: string, now = Date.now()): boolean {
    const row = this.db.prepare("SELECT until FROM approval_grants WHERE thread = ?").get(thread) as
      | { until: number }
      | undefined;
    if (!row) return false;
    if (Number(row.until) <= now) {
      this.db.prepare("DELETE FROM approval_grants WHERE thread = ?").run(thread);
      return false;
    }
    return true;
  }

  listPending(now = new Date()): ApprovalRow[] {
    const rows = this.db
      .prepare("SELECT * FROM approvals WHERE status = 'pending' AND expires_at > ? ORDER BY id DESC")
      .all(now.toISOString()) as Record<string, unknown>[];
    return rows.map(toRow);
  }
}

function toRow(row: Record<string, unknown>): ApprovalRow {
  return {
    id: Number(row.id),
    thread: String(row.thread),
    taskId: row.task_id ? String(row.task_id) : null,
    prompt: String(row.prompt),
    action: String(row.action),
    request: String(row.request),
    status: String(row.status) as ApprovalStatus,
    createdAt: String(row.created_at),
    expiresAt: String(row.expires_at),
    decidedAt: row.decided_at ? String(row.decided_at) : null,
  };
}
