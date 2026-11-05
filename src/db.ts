import { DatabaseSync } from "node:sqlite";

export type TaskStatus = "queued" | "running" | "done" | "failed";

export type ConversationEventRow = {
  id: number;
  thread: string;
  speaker: string;
  role: "user" | "assistant";
  text: string;
  task_id: string | null;
  distilled_at: string | null;
  created_at: string;
};

export type TaskRow = {
  id: string;
  prompt: string;
  cwd: string;
  status: TaskStatus;
  created_at: string;
  updated_at: string;
  result: string | null;
  error: string | null;
  thread: string;
  distilled_at: string | null;
};

const now = (): string => new Date().toISOString();
const shortId = (): string => `t_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;

/** LIKE pattern for a literal thread prefix. `_` and `%` are wildcards unless escaped. */
function likePrefix(prefix: string): string {
  return `${prefix.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;
}

/**
 * The single source of truth.
 *
 * Design rule borrowed from the systems we are studying: the orchestrator owns all
 * state; the executor (pi) is stateless and disposable. That is what makes crash
 * recovery possible — replay the task row, not the process memory.
 */
export class Store {
  private readonly db: DatabaseSync;

  constructor(file: string) {
    this.db = new DatabaseSync(file);
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec("PRAGMA busy_timeout = 5000;");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS tasks (
        id         TEXT PRIMARY KEY,
        prompt     TEXT NOT NULL,
        cwd        TEXT NOT NULL,
        status     TEXT NOT NULL DEFAULT 'queued',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        result     TEXT,
        error      TEXT
      );
    `);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS events (
        seq        INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id    TEXT NOT NULL,
        type       TEXT NOT NULL,
        payload    TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
    `);
    this.db.exec("CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status, created_at);");
    this.db.exec("CREATE INDEX IF NOT EXISTS idx_events_task ON events(task_id, seq);");

    // v2 columns: tasks now belong to a conversation thread and track distillation.
    // Span tree: one task produces a few nested spans (compose → model → tools). Kept in its
    // own table rather than derived from events, because a span has a duration and a parent.
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS spans (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id    TEXT NOT NULL,
        parent_id  INTEGER,
        kind       TEXT NOT NULL,
        name       TEXT NOT NULL,
        started_at TEXT NOT NULL,
        ended_at   TEXT,
        status     TEXT NOT NULL DEFAULT 'running',
        attrs      TEXT
      );
    `);
    this.db.exec("CREATE INDEX IF NOT EXISTS idx_spans_task ON spans(task_id, id);");

    this.ensureColumn("tasks", "thread", "TEXT NOT NULL DEFAULT 'default'");
    this.ensureColumn("tasks", "distilled_at", "TEXT");
    // Sub-agent lineage: which parent spawned this task, and its position in the batch.
    this.ensureColumn("tasks", "parent_task_id", "TEXT");
    this.ensureColumn("tasks", "spawn_index", "INTEGER");

    // Append-only conversation log. Every memory must point at one of these rows by id,
    // which is what makes "evidence" checkable instead of rhetorical.
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS conversation_events (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        thread       TEXT NOT NULL,
        speaker      TEXT NOT NULL,
        role         TEXT NOT NULL,
        text         TEXT NOT NULL,
        task_id      TEXT,
        distilled_at TEXT,
        created_at   TEXT NOT NULL
      );
    `);
    this.db.exec("CREATE INDEX IF NOT EXISTS idx_ce_thread ON conversation_events(thread, id);");

    // Provider-reported usage per run: the basis for the daily/per-task budget.
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS usage (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id     TEXT,
        day         TEXT NOT NULL,
        model       TEXT,
        input       INTEGER NOT NULL DEFAULT 0,
        output      INTEGER NOT NULL DEFAULT 0,
        cache_read  INTEGER NOT NULL DEFAULT 0,
        cache_write INTEGER NOT NULL DEFAULT 0,
        total       INTEGER NOT NULL DEFAULT 0,
        cost        REAL NOT NULL DEFAULT 0,
        created_at  TEXT NOT NULL
      );
    `);
    this.db.exec("CREATE INDEX IF NOT EXISTS idx_usage_day ON usage(day);");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS thread_state (
        thread                     TEXT PRIMARY KEY,
        summary                    TEXT NOT NULL DEFAULT '',
        summarized_until_event_id  INTEGER NOT NULL DEFAULT 0,
        updated_at                 TEXT NOT NULL
      );
    `);

    // Transport-level idempotency: IM platforms redeliver when an ack is slow, and a
    // redelivered message must not become a second event (and therefore a second memory).
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS seen_messages (
        channel     TEXT NOT NULL,
        external_id TEXT NOT NULL,
        created_at  TEXT NOT NULL,
        PRIMARY KEY (channel, external_id)
      );
    `);
    this.backfillEvents();
  }

  /** Existing task history becomes conversation events, so old threads stay extractable. */
  private backfillEvents(): void {
    const existing = this.db.prepare("SELECT COUNT(*) c FROM conversation_events").get() as { c: number };
    if (Number(existing.c) > 0) return;
    const tasks = this.db.prepare("SELECT * FROM tasks ORDER BY created_at ASC").all() as TaskRow[];
    if (tasks.length === 0) return;
    for (const task of tasks) {
      this.addConversationEvent(task.thread, "user_1", "user", task.prompt, task.id, task.distilled_at);
      if (task.result) {
        this.addConversationEvent(task.thread, "agent", "assistant", task.result, task.id, task.distilled_at);
      }
    }
  }

  private ensureColumn(table: string, column: string, definition: string): void {
    const columns = (this.db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((row) => row.name);
    if (!columns.includes(column)) {
      this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
    }
  }

  createTask(prompt: string, cwd: string, thread = "default"): string {
    const id = shortId();
    const ts = now();
    this.db
      .prepare("INSERT INTO tasks (id, prompt, cwd, status, created_at, updated_at, thread) VALUES (?, ?, ?, 'queued', ?, ?, ?)")
      .run(id, prompt, cwd, ts, ts, thread);
    return id;
  }

  /** A child task carries its parent and its position, so the tree is reconstructible. */
  createChildTask(prompt: string, cwd: string, thread: string, parentTaskId: string, spawnIndex: number): string {
    const id = shortId();
    const ts = now();
    this.db
      .prepare(
        "INSERT INTO tasks (id, prompt, cwd, status, created_at, updated_at, thread, parent_task_id, spawn_index) VALUES (?, ?, ?, 'queued', ?, ?, ?, ?, ?)",
      )
      .run(id, prompt, cwd, ts, ts, thread, parentTaskId, spawnIndex);
    return id;
  }

  childrenOf(parentTaskId: string): TaskRow[] {
    return this.db
      .prepare("SELECT * FROM tasks WHERE parent_task_id = ? ORDER BY spawn_index ASC")
      .all(parentTaskId) as TaskRow[];
  }

  getTask(id: string): TaskRow | null {
    const row = this.db.prepare("SELECT * FROM tasks WHERE id = ?").get(id);
    return (row as TaskRow | undefined) ?? null;
  }

  listTasks(limit = 20): TaskRow[] {
    return this.db.prepare("SELECT * FROM tasks ORDER BY created_at DESC LIMIT ?").all(limit) as TaskRow[];
  }

  /** Insert an already-finished turn (used by the evaluator to replay transcripts). */
  insertDoneTurn(prompt: string, cwd: string, thread: string, result: string): string {
    const id = shortId();
    const ts = now();
    this.db
      .prepare(
        "INSERT INTO tasks (id, prompt, cwd, status, created_at, updated_at, result, thread) VALUES (?, ?, ?, 'done', ?, ?, ?, ?)",
      )
      .run(id, prompt, cwd, ts, ts, result, thread);
    return id;
  }

  claimNext(exclude: Set<string> = new Set()): TaskRow | null {
    const rows = this.db
      .prepare("SELECT * FROM tasks WHERE status = 'queued' ORDER BY created_at ASC LIMIT 20")
      .all() as TaskRow[];
    const row = rows.find((r) => !exclude.has(r.id));
    if (!row) return null;
    const res = this.db
      .prepare("UPDATE tasks SET status = 'running', updated_at = ? WHERE id = ? AND status = 'queued'")
      .run(now(), row.id);
    if (Number(res.changes) !== 1) return null;
    return { ...row, status: "running" };
  }

  finishTask(id: string, result: string): void {
    this.db
      .prepare("UPDATE tasks SET status = 'done', result = ?, error = NULL, updated_at = ? WHERE id = ?")
      .run(result, now(), id);
  }

  failTask(id: string, error: string): void {
    this.db.prepare("UPDATE tasks SET status = 'failed', error = ?, updated_at = ? WHERE id = ?").run(error, now(), id);
  }

  /** Requeue tasks whose worker died mid-flight. */
  reapStale(maxAgeMinutes = 90): number {
    const cutoff = new Date(Date.now() - maxAgeMinutes * 60_000).toISOString();
    const res = this.db
      .prepare("UPDATE tasks SET status = 'queued', updated_at = ? WHERE status = 'running' AND updated_at < ?")
      .run(now(), cutoff);
    return Number(res.changes);
  }

  appendEvent(taskId: string, type: string, payload: unknown): void {
    this.db
      .prepare("INSERT INTO events (task_id, type, payload, created_at) VALUES (?, ?, ?, ?)")
      .run(taskId, type, JSON.stringify(payload), now());
  }

  eventsOf(taskId: string): Array<{ seq: number; type: string; payload: string; created_at: string }> {
    return this.db.prepare("SELECT seq, type, payload, created_at FROM events WHERE task_id = ? ORDER BY seq ASC").all(taskId) as any[];
  }

  /**
   * Distinct conversation threads, newest activity first.
   *
   * `prefix` is matched literally (`web:` does not treat `_` as a LIKE wildcard). Callers that
   * only want one channel pass that channel's thread prefix.
   */
  listThreads(prefix = ""): Array<{ thread: string; events: number; lastAt: string }> {
    const sql = prefix
      ? `SELECT thread, COUNT(*) AS events, MAX(created_at) AS last_at
           FROM conversation_events
          WHERE thread LIKE ? ESCAPE '\\'
          GROUP BY thread
          ORDER BY last_at DESC
          LIMIT 100`
      : `SELECT thread, COUNT(*) AS events, MAX(created_at) AS last_at
           FROM conversation_events
          GROUP BY thread
          ORDER BY last_at DESC
          LIMIT 100`;
    const rows = (prefix
      ? this.db.prepare(sql).all(likePrefix(prefix))
      : this.db.prepare(sql).all()) as Array<{ thread: string; events: number; last_at: string }>;
    return rows.map((row) => ({ thread: row.thread, events: Number(row.events), lastAt: String(row.last_at) }));
  }

  /** First user turn in a thread — the natural title for a chat list. */
  firstUserText(thread: string): string | null {
    const row = this.db
      .prepare("SELECT text FROM conversation_events WHERE thread = ? AND role = 'user' ORDER BY id ASC LIMIT 1")
      .get(thread) as { text: string } | undefined;
    return row?.text ?? null;
  }

  /** Tool execution events since a timestamp, oldest first (start/end pairs are matched by id). */
  toolCallRows(sinceIso: string): Array<{ type: string; payload: string; created_at: string }> {
    return this.db
      .prepare(
        "SELECT type, payload, created_at FROM events WHERE type IN ('tool_execution_start', 'tool_execution_end') AND created_at >= ? ORDER BY seq ASC",
      )
      .all(sinceIso) as Array<{ type: string; payload: string; created_at: string }>;
  }

  /** Row count and total payload bytes, for before/after reporting. */
  eventStats(): { rows: number; bytes: number } {
    const row = this.db.prepare("SELECT COUNT(*) AS rows, COALESCE(SUM(LENGTH(payload)), 0) AS bytes FROM events").get() as {
      rows: number;
      bytes: number;
    };
    return { rows: Number(row.rows), bytes: Number(row.bytes) };
  }

  /**
   * Remove records that carry no information after the fact (streaming deltas, turn wrappers).
   * Destructive by design, so it counts first and never touches other types.
   */
  deleteEventsOfTypes(types: string[], dryRun = false): number {
    if (types.length === 0) return 0;
    const placeholders = types.map(() => "?").join(", ");
    const count = this.db.prepare(`SELECT COUNT(*) AS n FROM events WHERE type IN (${placeholders})`).get(...types) as { n: number };
    if (!dryRun) {
      this.db.prepare(`DELETE FROM events WHERE type IN (${placeholders})`).run(...types);
    }
    return Number(count.n);
  }

  /** Reclaim the space freed by deletes. Returns the file size in bytes afterwards. */
  vacuum(): number {
    this.db.exec("VACUUM;");
    const pages = this.db.prepare("PRAGMA page_count").get() as { page_count: number };
    const size = this.db.prepare("PRAGMA page_size").get() as { page_size: number };
    return Number(pages.page_count) * Number(size.page_size);
  }

  /** Consistent snapshot to a plain file. Safe while the WAL database is being written. */
  vacuumInto(target: string): void {
    this.db.prepare("VACUUM INTO ?").run(target);
  }

  /**
   * Events old enough to archive, minus the two kinds that must stay:
   * those still awaiting distillation, and those cited as evidence by a live memory.
   */
  selectArchivableEvents(
    cutoff: string,
    includeUndistilled = false,
  ): {
    rows: Array<Record<string, unknown>>;
    skippedEvidence: number;
    skippedUndistilled: number;
  } {
    const pending = this.db
      .prepare(
        `SELECT COUNT(*) AS n FROM conversation_events
          WHERE created_at < ? AND distilled_at IS NULL`,
      )
      .get(cutoff) as { n: number };
    const evidence = this.db
      .prepare(
        `SELECT COUNT(*) AS n FROM conversation_events e
          WHERE e.created_at < ?
            AND EXISTS (SELECT 1 FROM memories m WHERE m.evidence_event_id = e.id)`,
      )
      .get(cutoff) as { n: number };

    const undistilledClause = includeUndistilled ? "" : "AND distilled_at IS NOT NULL";
    const rows = this.db
      .prepare(
        `SELECT * FROM conversation_events e
          WHERE e.created_at < ? ${undistilledClause}
            AND NOT EXISTS (SELECT 1 FROM memories m WHERE m.evidence_event_id = e.id)
          ORDER BY e.id ASC`,
      )
      .all(cutoff) as Array<Record<string, unknown>>;

    return { rows, skippedEvidence: Number(evidence.n), skippedUndistilled: Number(pending.n) };
  }

  deleteConversationEvents(ids: number[]): number {
    if (ids.length === 0) return 0;
    const statement = this.db.prepare("DELETE FROM conversation_events WHERE id = ?");
    let deleted = 0;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      for (const id of ids) deleted += Number(statement.run(id).changes);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    return deleted;
  }

  /**
   * Shrink existing oversized payloads to a preview.
   *
   * New writes are bounded by `persistRecord`, but rows written before that guard still hold
   * full agent payloads. The preview keeps the row honest: it says it was truncated and by how
   * much, instead of silently pretending the record was always small.
   */
  truncateEventPayloads(maxChars: number): { rows: number; freedBytes: number } {
    const rows = this.db.prepare("SELECT seq, payload FROM events WHERE LENGTH(payload) > ?").all(maxChars) as Array<{
      seq: number;
      payload: string;
    }>;
    const update = this.db.prepare("UPDATE events SET payload = ? WHERE seq = ?");
    let freed = 0;
    for (const row of rows) {
      let replacement: string;
      try {
        const parsed = JSON.parse(row.payload);
        replacement = JSON.stringify({
          truncated: true,
          originalChars: row.payload.length,
          preview: JSON.stringify(parsed).slice(0, maxChars),
        });
      } catch {
        replacement = JSON.stringify({
          truncated: true,
          originalChars: row.payload.length,
          preview: row.payload.slice(0, maxChars),
        });
      }
      freed += row.payload.length - replacement.length;
      update.run(replacement, row.seq);
    }
    return { rows: rows.length, freedBytes: freed };
  }

  startSpan(taskId: string, kind: string, name: string, parentId: number | null = null, attrs?: unknown): number {
    const result = this.db
      .prepare("INSERT INTO spans (task_id, parent_id, kind, name, started_at, attrs) VALUES (?, ?, ?, ?, ?, ?)")
      .run(taskId, parentId, kind, name, now(), attrs === undefined ? null : JSON.stringify(attrs));
    return Number(result.lastInsertRowid);
  }

  endSpan(id: number, status: "ok" | "error", attrs?: unknown): void {
    this.db
      .prepare("UPDATE spans SET ended_at = ?, status = ?, attrs = COALESCE(?, attrs) WHERE id = ?")
      .run(now(), status, attrs === undefined ? null : JSON.stringify(attrs), id);
  }

  spansOf(taskId: string): Array<{
    id: number;
    task_id: string;
    parent_id: number | null;
    kind: string;
    name: string;
    started_at: string;
    ended_at: string | null;
    status: string;
    attrs: string | null;
  }> {
    return this.db.prepare("SELECT * FROM spans WHERE task_id = ? ORDER BY id ASC").all(taskId) as any[];
  }

  /** Finished tasks that have not been fed to the memory extractor yet. */
  pendingTurns(thread?: string, limit = 12): TaskRow[] {
    const sql = thread
      ? "SELECT * FROM tasks WHERE status = 'done' AND distilled_at IS NULL AND thread = ? ORDER BY created_at ASC LIMIT ?"
      : "SELECT * FROM tasks WHERE status = 'done' AND distilled_at IS NULL ORDER BY created_at ASC LIMIT ?";
    return (thread ? this.db.prepare(sql).all(thread, limit) : this.db.prepare(sql).all(limit)) as TaskRow[];
  }

  pendingCount(thread?: string): number {
    const row = thread
      ? (this.db.prepare("SELECT COUNT(*) c FROM tasks WHERE status = 'done' AND distilled_at IS NULL AND thread = ?").get(thread) as { c: number })
      : (this.db.prepare("SELECT COUNT(*) c FROM tasks WHERE status = 'done' AND distilled_at IS NULL").get() as { c: number });
    return Number(row.c);
  }

  /** Threads with pending turns whose newest turn is older than `idleMinutes`. */
  idleThreads(idleMinutes: number): Array<{ thread: string; pending: number }> {
    const cutoff = new Date(Date.now() - idleMinutes * 60_000).toISOString();
    const rows = this.db
      .prepare(
        `SELECT thread, COUNT(*) pending, MAX(created_at) newest
           FROM tasks WHERE status = 'done' AND distilled_at IS NULL
          GROUP BY thread HAVING newest < ?`,
      )
      .all(cutoff) as Array<{ thread: string; pending: number }>;
    return rows;
  }

  markDistilled(ids: string[]): void {
    if (ids.length === 0) return;
    const statement = this.db.prepare("UPDATE tasks SET distilled_at = ? WHERE id = ?");
    const ts = now();
    for (const id of ids) statement.run(ts, id);
  }

  // ---- conversation events (the evidence layer) ----

  addConversationEvent(
    thread: string,
    speaker: string,
    role: "user" | "assistant",
    text: string,
    taskId: string | null = null,
    distilledAt: string | null = null,
  ): number {
    const result = this.db
      .prepare("INSERT INTO conversation_events (thread, speaker, role, text, task_id, distilled_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(thread, speaker, role, text, taskId, distilledAt, now());
    return Number(result.lastInsertRowid);
  }

  /** True when this transport message is new; false when it was already processed. */
  claimMessage(channel: string, externalId: string): boolean {
    const result = this.db
      .prepare("INSERT OR IGNORE INTO seen_messages (channel, external_id, created_at) VALUES (?, ?, ?)")
      .run(channel, externalId, now());
    return Number(result.changes) === 1;
  }

  conversationEvents(thread: string, limit = 200): ConversationEventRow[] {
    return this.db
      .prepare("SELECT * FROM conversation_events WHERE thread = ? ORDER BY id ASC LIMIT ?")
      .all(thread, limit) as ConversationEventRow[];
  }

  /** Highest event id in a thread — the current message when building its prompt. */
  lastEventId(thread: string): number {
    const row = this.db.prepare("SELECT MAX(id) id FROM conversation_events WHERE thread = ?").get(thread) as { id: number | null };
    return Number(row.id ?? 0);
  }

  /** Events strictly before `beforeId`, oldest first: the conversation window. */
  threadEventsBefore(thread: string, beforeId: number, limit = 60): ConversationEventRow[] {
    return this.db
      .prepare("SELECT * FROM conversation_events WHERE thread = ? AND id < ? ORDER BY id DESC LIMIT ?")
      .all(thread, beforeId, limit)
      .reverse() as ConversationEventRow[];
  }

  /** Events in an id range, oldest first (used to compress the cold part of a thread). */
  threadEventsBetween(thread: string, afterId: number, beforeId: number, limit = 80): ConversationEventRow[] {
    return this.db
      .prepare("SELECT * FROM conversation_events WHERE thread = ? AND id > ? AND id < ? ORDER BY id ASC LIMIT ?")
      .all(thread, afterId, beforeId, limit) as ConversationEventRow[];
  }

  // ---- usage / budget ----

  recordUsage(taskId: string, model: string, usage: {
    input?: number; output?: number; cacheRead?: number; cacheWrite?: number; total?: number; cost?: number;
  }): void {
    const day = new Date().toISOString().slice(0, 10);
    // Provider numbers arrive as numbers, but a missing/NaN field must never break the write
    // (SQLite binds NaN as NULL, which trips NOT NULL).
    const safe = (value: unknown): number => {
      const numeric = Number(value ?? 0);
      return Number.isFinite(numeric) ? numeric : 0;
    };
    this.db
      .prepare(
        `INSERT INTO usage (task_id, day, model, input, output, cache_read, cache_write, total, cost, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        taskId,
        day,
        model,
        safe(usage.input),
        safe(usage.output),
        safe(usage.cacheRead),
        safe(usage.cacheWrite),
        safe(usage.total),
        safe(usage.cost),
        now(),
      );
  }

  usageToday(): { total: number; cost: number; runs: number } {
    const day = new Date().toISOString().slice(0, 10);
    const row = this.db
      .prepare("SELECT COALESCE(SUM(total),0) total, COALESCE(SUM(cost),0) cost, COUNT(*) runs FROM usage WHERE day = ?")
      .get(day) as { total: number; cost: number; runs: number };
    return { total: Number(row.total), cost: Number(row.cost), runs: Number(row.runs) };
  }

  usageForTask(taskId: string): { total: number; cost: number } {
    const row = this.db
      .prepare("SELECT COALESCE(SUM(total),0) total, COALESCE(SUM(cost),0) cost FROM usage WHERE task_id = ?")
      .get(taskId) as { total: number; cost: number };
    return { total: Number(row.total), cost: Number(row.cost) };
  }

  threadState(thread: string): { summary: string; summarizedUntil: number } {
    const row = this.db.prepare("SELECT * FROM thread_state WHERE thread = ?").get(thread) as
      | { summary: string; summarized_until_event_id: number }
      | undefined;
    return { summary: row?.summary ?? "", summarizedUntil: Number(row?.summarized_until_event_id ?? 0) };
  }

  saveThreadState(thread: string, summary: string, summarizedUntil: number): void {
    this.db
      .prepare(
        `INSERT INTO thread_state (thread, summary, summarized_until_event_id, updated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(thread) DO UPDATE SET
           summary = excluded.summary,
           summarized_until_event_id = excluded.summarized_until_event_id,
           updated_at = excluded.updated_at`,
      )
      .run(thread, summary, summarizedUntil, now());
  }

  pendingEvents(thread?: string, limit = 40): ConversationEventRow[] {
    const sql = thread
      ? "SELECT * FROM conversation_events WHERE distilled_at IS NULL AND thread = ? ORDER BY id ASC LIMIT ?"
      : "SELECT * FROM conversation_events WHERE distilled_at IS NULL ORDER BY id ASC LIMIT ?";
    return (thread ? this.db.prepare(sql).all(thread, limit) : this.db.prepare(sql).all(limit)) as ConversationEventRow[];
  }

  /** Counts user turns, not events: one turn is a user message plus an assistant reply. */
  pendingTurnCount(thread?: string): number {
    const row = thread
      ? (this.db
          .prepare("SELECT COUNT(*) c FROM conversation_events WHERE distilled_at IS NULL AND role = 'user' AND thread = ?")
          .get(thread) as { c: number })
      : (this.db
          .prepare("SELECT COUNT(*) c FROM conversation_events WHERE distilled_at IS NULL AND role = 'user'")
          .get() as { c: number });
    return Number(row.c);
  }

  markEventsDistilled(ids: number[]): void {
    if (ids.length === 0) return;
    const statement = this.db.prepare("UPDATE conversation_events SET distilled_at = ? WHERE id = ?");
    const ts = now();
    for (const id of ids) statement.run(ts, id);
  }

  idleEventThreads(idleMinutes: number): Array<{ thread: string; pending: number }> {
    const cutoff = new Date(Date.now() - idleMinutes * 60_000).toISOString();
    return this.db
      .prepare(
        `SELECT thread, COUNT(*) pending, MAX(created_at) newest
           FROM conversation_events WHERE distilled_at IS NULL
          GROUP BY thread HAVING newest < ?`,
      )
      .all(cutoff) as Array<{ thread: string; pending: number }>;
  }

  close(): void {
    this.db.close();
  }
}
