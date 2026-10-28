import { DatabaseSync } from "node:sqlite";
import path from "node:path";

/**
 * Fan-out: several sub-agents working on one parent task, with three things that plain
 * parallelism does not give you.
 *
 * 1. shared state — children publish findings as notes; the parent (or the next child) reads
 *    them without passing messages through the model's context;
 * 2. arbitration — two children may disagree about the same key; a deterministic rule decides
 *    what the digest reports, and the disagreement is surfaced instead of silently averaged;
 * 3. partial retry — one failed child does not fail the batch; it is retried once with the
 *    failure reason appended, and only then reported as failed.
 *
 * What this deliberately is not: a multi-agent protocol. There is no negotiation, no turns, no
 * peer messaging. Children never talk to each other; they read and write a shared table. That
 * keeps the failure modes countable — which is the whole point at this size.
 */
export type Note = { scope: string; key: string; value: string; by: string; createdAt: string };

export type Conflict = { key: string; values: Array<{ value: string; by: string }>; winner: string; by: string };

export type Arbitration = { resolved: Note[]; conflicts: Conflict[] };

/**
 * Last write wins, and every disagreement is reported.
 *
 * Why last-write-wins: children run in parallel, so there is no causal order to respect. Any
 * "smart" merge (majority vote, longest text) would invent confidence we do not have. Recording
 * the conflict is the honest part — the digest can then say "两份结论不一致".
 */
export function arbitrate(notes: Note[]): Arbitration {
  const byKey = new Map<string, Note[]>();
  for (const note of notes) {
    const list = byKey.get(note.key) ?? [];
    list.push(note);
    byKey.set(note.key, list);
  }

  const resolved: Note[] = [];
  const conflicts: Conflict[] = [];
  for (const [key, group] of byKey) {
    const latest = group.reduce((a, b) => (a.createdAt >= b.createdAt ? a : b));
    resolved.push(latest);
    const distinct = new Map<string, Note>();
    for (const note of group) {
      const normalized = note.value.trim();
      if (!distinct.has(normalized)) distinct.set(normalized, note);
    }
    if (distinct.size > 1) {
      conflicts.push({
        key,
        values: [...distinct.values()].map((note) => ({ value: note.value, by: note.by })),
        winner: latest.value,
        by: latest.by,
      });
    }
  }
  return { resolved, conflicts };
}

/** Render the digest a parent task receives: findings first, disagreements called out. */
export function buildFanoutDigest(input: {
  prompt: string;
  results: Array<{ title: string; ok: boolean; output: string; attempts: number; error?: string }>;
  notes: Note[];
  maxCharsPerChild?: number;
}): string {
  const limit = input.maxCharsPerChild ?? 1_200;
  const { resolved, conflicts } = arbitrate(input.notes);

  const childBlocks = input.results.map((result, index) => {
    const head = `${index + 1}. ${result.title}${result.ok ? "" : "（失败）"}${result.attempts > 1 ? ` [重试 ${result.attempts - 1} 次]` : ""}`;
    const body = result.ok ? result.output.slice(0, limit) : `错误：${result.error ?? "未知"}`;
    return `${head}\n${body}`;
  });

  const noteBlock =
    resolved.length === 0
      ? []
      : ["", "### 子任务共享的结论", ...resolved.map((note) => `- ${note.key}: ${note.value}（来自子任务 ${note.by}）`)];

  const conflictBlock =
    conflicts.length === 0
      ? []
      : [
          "",
          "### ⚠️ 子任务之间的冲突（按最后写入取用，但你需要确认）",
          ...conflicts.map(
            (conflict) =>
              `- ${conflict.key}: ${conflict.values.map((v) => `「${v.value}」（${v.by}）`).join(" vs ")} → 暂取「${conflict.winner}」`,
          ),
        ];

  return [
    `原始任务：${input.prompt}`,
    "",
    "### 子任务结果",
    ...childBlocks,
    ...noteBlock,
    ...conflictBlock,
  ].join("\n");
}

/** One retry for a failed child, then give up. More than one hides systematic failures. */
export function shouldRetry(status: "ok" | "failed", attempts: number, maxAttempts = 2): boolean {
  return status === "failed" && attempts < maxAttempts;
}

/** Failure reason appended when retrying, so the child does not repeat the same mistake. */
export function retryPrompt(prompt: string, error: string): string {
  return `${prompt}\n\n上次执行失败，原因：${error}\n先分析失败原因再重试，不要重复同样的操作。`;
}

export class NoteStore {
  private readonly db: DatabaseSync;

  constructor(dataDir: string) {
    this.db = new DatabaseSync(path.join(dataDir, "runtime.db"));
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec("PRAGMA busy_timeout = 5000;");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS fanout_notes (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        scope      TEXT NOT NULL,
        key        TEXT NOT NULL,
        value      TEXT NOT NULL,
        by         TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
    `);
    this.db.exec("CREATE INDEX IF NOT EXISTS idx_fanout_notes_scope ON fanout_notes(scope, created_at);");
  }

  write(scope: string, key: string, value: string, by: string): Note {
    const createdAt = new Date().toISOString();
    this.db
      .prepare("INSERT INTO fanout_notes (scope, key, value, by, created_at) VALUES (?, ?, ?, ?, ?)")
      .run(scope, key.slice(0, 120), value.slice(0, 4_000), by, createdAt);
    return { scope, key, value, by, createdAt };
  }

  read(scope: string): Note[] {
    const rows = this.db
      .prepare("SELECT * FROM fanout_notes WHERE scope = ? ORDER BY created_at ASC, id ASC")
      .all(scope) as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      scope: String(row.scope),
      key: String(row.key),
      value: String(row.value),
      by: String(row.by),
      createdAt: String(row.created_at),
    }));
  }

  clear(scope: string): void {
    this.db.prepare("DELETE FROM fanout_notes WHERE scope = ?").run(scope);
  }
}
