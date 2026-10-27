import { mkdirSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import { detectSecret } from "./secrets.ts";
import { blobToVector as toVector, cosine } from "../mcp/lib/embed.mjs";

export type MemoryCategory = "preference" | "fact" | "event";
export type MemoryAction = "create" | "correct" | "invalidate" | "contest";
export type MemoryStatus = "active" | "superseded" | "invalidated" | "contested";

/** Who the memory is about. Pronouns are forbidden in the extractor output. */
export type TargetType = "current_speaker" | "named_member" | "current_group" | "self";

export type MemoryRow = {
  id: number;
  target_type: TargetType;
  target_name: string | null;
  subject: string;
  category: MemoryCategory;
  key: string;
  content: string;
  importance: number;
  evidence_event_id: number | null;
  evidence_quote: string | null;
  reason: string | null;
  action: MemoryAction | null;
  status: MemoryStatus;
  superseded_by: number | null;
  note: string | null;
  source_task_id: string | null;
  thread: string | null;
  created_at: string;
  updated_at: string;
  last_used_at: string | null;
  use_count: number;
};

export type MemoryWrite = {
  action: MemoryAction;
  targetType?: TargetType;
  targetName?: string | null;
  category: MemoryCategory;
  key: string;
  content: string;
  importance: number;
  evidenceEventId?: number | null;
  evidenceQuote?: string | null;
  reason?: string | null;
  sourceTaskId?: string | null;
  thread?: string | null;
  /** For correct / invalidate / contest: the row the model wants to act on. */
  targetFactId?: number | null;
};

export type ApplyResult = {
  id: number | null;
  action: MemoryAction | "rejected";
  key: string;
  reason: string;
  content?: string | null;
};

export type InjectBlock = { text: string; ids: number[] };

const CATEGORIES: MemoryCategory[] = ["preference", "fact", "event"];
const TARGETS: TargetType[] = ["current_speaker", "named_member", "current_group", "self"];
const ACTIONS: MemoryAction[] = ["create", "correct", "invalidate", "contest"];

const CATEGORY_LABEL: Record<MemoryCategory, string> = {
  preference: "偏好",
  fact: "事实",
  event: "事件",
};

const now = (): string => new Date().toISOString();
const estimateTokens = (text: string): number => Math.ceil(text.length / 3.5);

export const normalize = (text: string): string =>
  text
    .replace(/\s+/g, "")
    .replace(/[，。！？、；：""''（）《》【】\[\]…—\-·,.!?;:"'()<>]/g, "")
    .toLowerCase();

function bigrams(text: string): Set<string> {
  const clean = text.toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
  const out = new Set<string>();
  for (let i = 0; i < clean.length - 1; i++) out.add(clean.slice(i, i + 2));
  if (clean.length === 1) out.add(clean);
  return out;
}

export function similarity(a: string, b: string): number {
  const left = bigrams(a);
  const right = bigrams(b);
  if (left.size === 0 || right.size === 0) return 0;
  let shared = 0;
  for (const gram of left) if (right.has(gram)) shared++;
  return shared / (left.size + right.size - shared);
}

/** Derive the human-readable subject from the structured target. */
export function subjectOf(targetType: TargetType, targetName: string | null, ownerName = "user"): string {
  switch (targetType) {
    case "named_member":
      return targetName ? `member:${targetName}` : "member:unknown";
    case "current_group":
      return "group";
    case "self":
      return "agent";
    case "current_speaker":
    default:
      return ownerName;
  }
}

/**
 * Structured memory with evidence binding, structured targets and four-state resolution.
 *
 * Invariants:
 * 1. Every row can be traced to ONE conversation event (`evidence_event_id`) and to a
 *    verbatim quote inside that event. The caller checks the quote; this store only stores it.
 * 2. `key` is the version slot. At most one `active` row per key; history keeps its status
 *    (`superseded` / `invalidated` / `contested`) and is never deleted.
 * 3. The model proposes an action; this class decides the real one against DB state.
 */
export class MemoryStore {
  private readonly db: DatabaseSync;
  private readonly dir: string;
  /** Canonical name of the person this agent belongs to. */
  readonly ownerName: string;

  constructor(dataDir: string, ownerName = "user") {
    this.dir = path.join(dataDir, "memory");
    this.ownerName = ownerName || "user";
    mkdirSync(this.dir, { recursive: true });
    this.db = new DatabaseSync(path.join(dataDir, "runtime.db"));
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec("PRAGMA busy_timeout = 5000;");
    this.migrateLegacyKinds();
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS memories (
        id                INTEGER PRIMARY KEY AUTOINCREMENT,
        target_type       TEXT NOT NULL DEFAULT 'current_speaker',
        target_name       TEXT,
        subject           TEXT NOT NULL DEFAULT 'user',
        category          TEXT NOT NULL,
        key               TEXT NOT NULL,
        content           TEXT NOT NULL,
        importance        INTEGER NOT NULL DEFAULT 3,
        evidence_event_id INTEGER,
        evidence_quote    TEXT,
        reason            TEXT,
        action            TEXT,
        status            TEXT NOT NULL DEFAULT 'active',
        superseded_by     INTEGER,
        note              TEXT,
        source_task_id    TEXT,
        thread            TEXT,
        created_at        TEXT NOT NULL,
        updated_at        TEXT NOT NULL,
        last_used_at      TEXT,
        use_count         INTEGER NOT NULL DEFAULT 0
      );
    `);
    this.ensureColumn("memories", "target_type", "TEXT NOT NULL DEFAULT 'current_speaker'");
    this.ensureColumn("memories", "target_name", "TEXT");
    this.ensureColumn("memories", "evidence_event_id", "INTEGER");
    // Retrieval columns (mem0-style). Kept nullable so old rows stay valid; a row without a
    // vector is still injected by the keyword path and simply not returned by similarity search.
    this.ensureColumn("memories", "embedding", "BLOB");
    this.ensureColumn("memories", "embedding_model", "TEXT");
    this.db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_mem_key_active ON memories(key) WHERE status = 'active';");
    this.db.exec("CREATE INDEX IF NOT EXISTS idx_mem_cat ON memories(category, status);");

    // "user" was the placeholder for the owner before the agent had a name.
    if (this.ownerName !== "user") {
      this.db.prepare("UPDATE memories SET subject = ? WHERE subject = 'user'").run(this.ownerName);
    }
  }

  private ensureColumn(table: string, column: string, definition: string): void {
    const columns = (this.db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((row) => row.name);
    if (!columns.includes(column)) this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }

  /** v1 (four free-form kinds) → v2+ structured rows. */
  private migrateLegacyKinds(): void {
    const exists = this.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='memories'").get();
    if (!exists) return;
    const columns = (this.db.prepare("PRAGMA table_info(memories)").all() as Array<{ name: string }>).map((row) => row.name);
    if (!columns.includes("kind") || columns.includes("category")) return;

    this.db.exec("ALTER TABLE memories RENAME TO memories_v1");
    this.db.exec(`
      CREATE TABLE memories (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        target_type TEXT NOT NULL DEFAULT 'current_speaker',
        target_name TEXT,
        subject TEXT NOT NULL DEFAULT 'user',
        category TEXT NOT NULL,
        key TEXT NOT NULL,
        content TEXT NOT NULL,
        importance INTEGER NOT NULL DEFAULT 3,
        evidence_event_id INTEGER,
        evidence_quote TEXT,
        reason TEXT,
        action TEXT,
        status TEXT NOT NULL DEFAULT 'active',
        superseded_by INTEGER,
        note TEXT,
        source_task_id TEXT,
        thread TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        last_used_at TEXT,
        use_count INTEGER NOT NULL DEFAULT 0
      );
    `);
    const legacy = this.db.prepare("SELECT * FROM memories_v1 ORDER BY id ASC").all() as Array<Record<string, any>>;
    const insert = this.db.prepare(
      `INSERT INTO memories (id, target_type, target_name, subject, category, key, content, importance,
        evidence_event_id, evidence_quote, reason, action, status, superseded_by, note,
        source_task_id, thread, created_at, updated_at, last_used_at, use_count)
       VALUES (?, 'current_speaker', NULL, 'user', ?, ?, ?, ?, NULL, NULL, ?, 'create', ?, ?, ?, ?, NULL, ?, ?, NULL, 0)`,
    );
    const mapKind = (kind: string): MemoryCategory =>
      kind === "preference" ? "preference" : kind === "experience" ? "event" : "fact";
    const mapImportance = (kind: string): number => (kind === "decision" ? 4 : kind === "experience" ? 2 : 3);

    for (const row of legacy) {
      const kind = String(row.kind ?? "fact");
      insert.run(
        row.id,
        mapKind(kind),
        String(row.key ?? `legacy-${row.id}`),
        String(row.content ?? ""),
        mapImportance(kind),
        "v1 迁移：无原文证据",
        row.superseded_by == null ? "active" : "superseded",
        row.superseded_by ?? null,
        "v1 迁移（原 kind=" + kind + "）",
        row.source_task_id ?? null,
        String(row.created_at ?? now()),
        String(row.updated_at ?? now()),
      );
    }
    this.db.exec("DROP TABLE memories_v1");
  }

  /**
   * Apply an engine decision against real state.
   *
   * Model proposal → DB verdict:
   * - create with an active key            → correct on that row
   * - create near-duplicate of an active row → correct on that row (key adopted)
   * - correct without a usable target       → create
   * - invalidate / contest without a target → rejected
   */
  apply(write: MemoryWrite, similarThreshold = 0.82): ApplyResult {
    const category: MemoryCategory = CATEGORIES.includes(write.category) ? write.category : "fact";
    let key = write.key.trim().toLowerCase();
    if (!key) return { id: null, action: "rejected", key: write.key, reason: "empty key" };
    if (!write.content.trim()) return { id: null, action: "rejected", key, reason: "empty content" };

    // Credentials are refused at the write boundary, not in the prompt: a memory row is
    // injected into every later prompt, rendered into MEMORY.md and persisted, so a single
    // slip turns a pasted password into a plaintext that travels. Checked before any DB write.
    const secretContent = detectSecret(write.content);
    const secretEvidence = write.evidenceQuote ? detectSecret(write.evidenceQuote) : { sensitive: false, reasons: [] };
    if (secretContent.sensitive || secretEvidence.sensitive) {
      const reasons = [...new Set([...secretContent.reasons, ...secretEvidence.reasons])].join(",");
      return {
        id: null,
        action: "rejected",
        key,
        reason: `sensitive: ${reasons} — 凭据类信息不入记忆`,
        content: null,
      };
    }

    const targetType: TargetType = TARGETS.includes(write.targetType as TargetType)
      ? (write.targetType as TargetType)
      : "current_speaker";
    const targetName = targetType === "named_member" ? (write.targetName ?? null) : null;
    const subject = subjectOf(targetType, targetName, this.ownerName);
    const importance = Math.min(5, Math.max(1, Math.round(write.importance || 3)));
    const ts = now();

    const byKey = this.db.prepare("SELECT * FROM memories WHERE key = ? AND status = 'active'").get(key) as MemoryRow | undefined;
    let target: MemoryRow | undefined = byKey;
    if (write.targetFactId) {
      const byId = this.db.prepare("SELECT * FROM memories WHERE id = ?").get(write.targetFactId) as MemoryRow | undefined;
      if (byId && byId.status === "active") target = byId;
    }

    let action: MemoryAction = ACTIONS.includes(write.action) ? write.action : "create";
    let note = write.reason ?? "";

    if (action === "create") {
      if (target) {
        action = "correct";
        note = `create 降级为 correct：key ${key} 已有活跃记忆 #${target.id}`;
      } else {
        // Similarity is only meaningful within one subject: two people having the same
        // preference are two memories, not a correction of each other.
        const candidates = this.active().filter((row) => row.category === category && row.subject === subject);
        let best: { row: MemoryRow; score: number } | null = null;
        for (const row of candidates) {
          const score = similarity(row.content, write.content);
          if (score >= similarThreshold && (!best || score > best.score)) best = { row, score };
        }
        if (best) {
          action = "correct";
          target = best.row;
          key = best.row.key;
          note = `语义相似 ${best.score.toFixed(2)} 命中 #${best.row.id}（${best.row.key}），create 改为 correct`;
        }
      }
    } else if (action === "correct") {
      if (!target) {
        action = "create";
        note = `correct 无有效目标，升级为 create：${key}`;
      }
    } else if (action === "invalidate" || action === "contest") {
      if (!target) {
        return {
          id: null,
          action: "rejected",
          key,
          reason: `${action} 失败：${key} 没有可作用的活跃记忆（target_fact_id 不存在或已失效）`,
        };
      }
      // The slot being invalidated is the existing row's, not whatever key the model invented.
      key = target.key;
    }

    this.db.exec("BEGIN IMMEDIATE");
    try {
      if (action === "invalidate") {
        this.db.prepare("UPDATE memories SET status = 'invalidated', note = ?, updated_at = ? WHERE id = ?").run(note || "已失效", ts, target!.id);
        this.db.exec("COMMIT");
        this.dump();
        return { id: target!.id, action: "invalidate", key, reason: note || "已失效", content: target!.content };
      }

      const insert = this.db.prepare(
        `INSERT INTO memories (target_type, target_name, subject, category, key, content, importance,
          evidence_event_id, evidence_quote, reason, action, status, superseded_by, note,
          source_task_id, thread, created_at, updated_at, use_count)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, 0)`,
      );
      const status: MemoryStatus = action === "contest" ? "contested" : "active";

      if ((action === "correct" || action === "contest") && target) {
        // Free the active slot before inserting: one active row per key.
        const nextStatus = action === "contest" ? "contested" : "superseded";
        this.db.prepare("UPDATE memories SET status = ?, updated_at = ? WHERE id = ?").run(nextStatus, ts, target.id);
      }

      const result = insert.run(
        targetType,
        targetName,
        subject,
        category,
        key,
        write.content.trim(),
        importance,
        write.evidenceEventId ?? null,
        write.evidenceQuote ?? null,
        write.reason ?? null,
        action,
        status,
        note || null,
        write.sourceTaskId ?? null,
        write.thread ?? null,
        ts,
        ts,
      );
      const id = Number(result.lastInsertRowid);

      if (action === "correct" && target) {
        this.db.prepare("UPDATE memories SET superseded_by = ? WHERE id = ?").run(id, target.id);
      }
      if (action === "contest" && target) {
        this.db.prepare("UPDATE memories SET superseded_by = ? WHERE id = ?").run(id, target.id);
      }
      this.db.exec("COMMIT");
      this.dump();
      return { id, action, key, reason: note || action, content: write.content.trim() };
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  /** Human resolution of a contested slot: keep one row, supersede the rest. */
  resolve(key: string, keepId: number): boolean {
    const rows = this.history(key).filter((row) => row.status === "contested");
    if (rows.length === 0) return false;
    const keep = rows.find((row) => row.id === keepId);
    if (!keep) return false;
    const ts = now();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      for (const row of rows) {
        if (row.id === keepId) {
          this.db.prepare("UPDATE memories SET status = 'active', note = '人工裁决为正确', updated_at = ? WHERE id = ?").run(ts, row.id);
        } else {
          this.db.prepare("UPDATE memories SET status = 'superseded', superseded_by = ?, updated_at = ? WHERE id = ?").run(keepId, ts, row.id);
        }
      }
      this.db.exec("COMMIT");
      this.dump();
      return true;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  active(): MemoryRow[] {
    return this.db
      .prepare("SELECT * FROM memories WHERE status = 'active' ORDER BY importance DESC, updated_at DESC")
      .all() as MemoryRow[];
  }

  contested(): MemoryRow[] {
    return this.db.prepare("SELECT * FROM memories WHERE status = 'contested' ORDER BY key, id").all() as MemoryRow[];
  }

  /**
   * What to inject, scoped to the conversation.
   *
   * Project facts must not leak into a personal chat (and vice versa): the same store holds
   * both, and injecting a codebase note into a "where do I live" question derails the answer.
   * Rule: rows from this thread, plus hand-written global preferences (thread IS NULL).
   */
  contextBlock(budgetChars = 1_800, thread?: string | null): InjectBlock {
    const rows = this.active().filter(
      (row) => !thread || row.thread === null || row.thread === thread,
    );
    const chosen: MemoryRow[] = [];
    let used = 0;
    for (const row of rows) {
      const lineLength = row.content.length + CATEGORY_LABEL[row.category].length + 6;
      if (used + lineLength > budgetChars) continue;
      chosen.push(row);
      used += lineLength;
    }
    if (chosen.length === 0) return { text: "", ids: [] };

    const body = chosen
      .map((row) => {
        // Only tag a foreign subject; the owner is the default and would just add noise.
        const who = row.subject && row.subject !== this.ownerName ? `[${row.subject}] ` : "";
        return `- ${who}[${CATEGORY_LABEL[row.category]}·${row.importance}] ${row.content}`;
      })
      .join("\n");
    const text = [
      "## 长期记忆（来自以往对话，供参考；与当前指令冲突时以当前指令为准）",
      body,
      `<!-- ${chosen.length}/${rows.length} 条，约 ${estimateTokens(body)} tokens -->`,
    ].join("\n");
    return { text, ids: chosen.map((row) => row.id) };
  }

  /** Ids of the rows that were actually shown to the extractor for this conversation. */
  scopeIds(thread?: string | null): Set<number> {
    const rows = this.active().filter(
      (row) => !thread || row.thread === null || row.thread === thread,
    );
    return new Set(rows.map((row) => row.id));
  }

  // ── 检索（mem0 风格）─────────────────────────────────────────────────────────────────
  //
  // Injection stays the default path: it is free and covers the common case. These methods add
  // a *pull* channel on top, so a question the injected block happens to miss ("上次那个并发
  // 的问题") can still find its row. The invariants are unchanged: only `active` rows are
  // returned, scope filtering still applies, and nothing here writes to the tables except the
  // embedding column.

  /** Rows without a vector yet, so a backfill can catch up after an upgrade. */
  needingEmbedding(limit = 50): Array<{ id: number; text: string }> {
    const rows = this.db
      .prepare(
        `SELECT id, key, content, target_name FROM memories
          WHERE embedding IS NULL AND status = 'active'
          ORDER BY id DESC LIMIT ?`,
      )
      .all(limit) as Array<{ id: number; key: string; content: string; target_name: string | null }>;
    return rows.map((row) => ({
      id: Number(row.id),
      // Embed the same text the model would read: key carries the slot semantics that content
      // alone often drops ("database" vs "用 SQLite").
      text: [row.key, row.target_name ?? "", row.content].filter(Boolean).join(" · "),
    }));
  }

  setEmbedding(id: number, vector: Float32Array | ArrayBuffer, model: string): void {
    const buffer = vector instanceof Float32Array ? Buffer.from(vector.buffer) : Buffer.from(vector);
    this.db.prepare("UPDATE memories SET embedding = ?, embedding_model = ? WHERE id = ?").run(buffer, model, id);
  }

  /** How many active rows carry a vector for the given model (for `doctor` / diagnostics). */
  embeddingStats(): { total: number; embedded: number; models: string[] } {
    const total = Number((this.db.prepare("SELECT COUNT(*) n FROM memories WHERE status = 'active'").get() as { n: number }).n);
    const embedded = Number(
      (this.db.prepare("SELECT COUNT(*) n FROM memories WHERE status = 'active' AND embedding IS NOT NULL").get() as { n: number }).n,
    );
    const models = (
      this.db
        .prepare("SELECT DISTINCT embedding_model m FROM memories WHERE embedding_model IS NOT NULL")
        .all() as Array<{ m: string }>
    ).map((row) => row.m);
    return { total, embedded, models };
  }

  /**
   * Cosine search over active rows, optionally limited to one embedding model.
   *
   * `model` matters: vectors from different models are not comparable, so a query embedded by
   * the hash provider must not be scored against 1024-dim API vectors. Rows whose model differs
   * are skipped rather than silently mis-scored.
   */
  similaritySearch(
    queryVector: Float32Array,
    options: { limit?: number; model?: string; thread?: string | null; minScore?: number } = {},
  ): Array<{ row: MemoryRow; score: number }> {
    const limit = Math.min(Math.max(options.limit ?? 5, 1), 20);
    // Low floor on purpose: the hash fallback only measures surface overlap, so a strict
    // threshold would hide every hit until a real embedding provider is configured.
    const minScore = options.minScore ?? 0.08;
    const rows = this.db
      .prepare(
        `SELECT * FROM memories
          WHERE status = 'active'
            AND embedding IS NOT NULL
            ${options.model ? "AND embedding_model = ?" : ""}`,
      )
      .all(...(options.model ? [options.model] : [])) as Array<Record<string, unknown>>;

    const scored = rows
      .map((row) => {
        const vector = toVector(row.embedding);
        if (!vector || vector.length !== queryVector.length) return null;
        const score = cosine(queryVector, vector);
        return { row: row as unknown as MemoryRow, score };
      })
      .filter((entry): entry is { row: MemoryRow; score: number } => entry !== null)
      .filter((entry) => entry.score >= minScore)
      // 项目事实不能漏到个人聊天：与注入同一条作用域规则。
      .filter((entry) => !options.thread || entry.row.thread === null || entry.row.thread === options.thread)
      .sort((a, b) => b.score - a.score);

    return scored.slice(0, limit);
  }

  /** Compact state handed to the extractor, including row IDs for correct/invalidate/contest. */
  stateBrief(maxChars = 3_000, thread?: string | null): string {
    const rows = this.active().filter(
      (row) => !thread || row.thread === null || row.thread === thread,
    );
    if (rows.length === 0) return "（当前没有任何活跃记忆）";
    let out = "";
    for (const row of rows) {
      const line = `[ID: ${row.id} | key: ${row.key} | ${row.category} | target: ${row.subject} | importance: ${row.importance} | state: ${row.status}] ${row.content}`;
      if (out.length + line.length > maxChars) break;
      out += line + "\n";
    }
    return out.trim();
  }

  markUsed(ids: number[]): void {
    if (ids.length === 0) return;
    const ts = now();
    const statement = this.db.prepare("UPDATE memories SET use_count = use_count + 1, last_used_at = ? WHERE id = ?");
    for (const id of ids) statement.run(ts, id);
  }

  list(category?: MemoryCategory, includeInactive = false): MemoryRow[] {
    if (category) {
      const where = includeInactive ? "category = ?" : "category = ? AND status = 'active'";
      return this.db.prepare(`SELECT * FROM memories WHERE ${where} ORDER BY importance DESC, updated_at DESC`).all(category) as MemoryRow[];
    }
    return includeInactive
      ? (this.db.prepare("SELECT * FROM memories ORDER BY updated_at DESC").all() as MemoryRow[])
      : this.active();
  }

  history(key: string): MemoryRow[] {
    return this.db.prepare("SELECT * FROM memories WHERE key = ? ORDER BY id ASC").all(key) as MemoryRow[];
  }

  byId(id: number): MemoryRow | undefined {
    return this.db.prepare("SELECT * FROM memories WHERE id = ?").get(id) as MemoryRow | undefined;
  }

  forget(id: number): boolean {
    const result = this.db.prepare("DELETE FROM memories WHERE id = ?").run(id);
    this.dump();
    return Number(result.changes) > 0;
  }

  stats(): { active: number; superseded: number; invalidated: number; contested: number; byCategory: Record<string, number> } {
    const rows = this.db.prepare("SELECT status, category, COUNT(*) c FROM memories GROUP BY status, category").all() as any[];
    const out = { active: 0, superseded: 0, invalidated: 0, contested: 0, byCategory: {} as Record<string, number> };
    for (const row of rows) {
      const count = Number(row.c);
      if (row.status === "active") {
        out.active += count;
        out.byCategory[row.category] = (out.byCategory[row.category] ?? 0) + count;
      } else if (row.status === "superseded") out.superseded += count;
      else if (row.status === "invalidated") out.invalidated += count;
      else if (row.status === "contested") out.contested += count;
    }
    return out;
  }

  dump(): void {
    const all = this.list(undefined, true);
    const active = all.filter((row) => row.status === "active");
    const contested = all.filter((row) => row.status === "contested");
    const inactive = all.filter((row) => row.status === "superseded" || row.status === "invalidated");
    const sections: string[] = [
      "# MEMORY",
      "",
      "> 由 `pi-runtime` 自动生成，请勿手改。写入用 `pi-rt remember`，提炼用 `pi-rt distill`。",
      "",
    ];

    for (const category of ["preference", "fact", "event"] as MemoryCategory[]) {
      const group = active.filter((row) => row.category === category);
      if (group.length === 0) continue;
      sections.push(`## ${CATEGORY_LABEL[category]}（${category}）`, "");
      for (const row of group) {
        const who = row.subject !== this.ownerName ? ` __${row.subject}__` : "";
        sections.push(`- **[${row.importance}]** ${row.content}${who}`);
        const evidence = row.evidence_quote
          ? ` · 证据 #${row.evidence_event_id}「${row.evidence_quote.slice(0, 60)}」`
          : "";
        sections.push(`  \`${row.key}\` · used=${row.use_count}${evidence}`);
      }
      sections.push("");
    }

    if (contested.length > 0) {
      sections.push("## 争议（未注入，等待裁决）", "");
      for (const row of contested) {
        sections.push(`- **[${row.importance}]** ${row.content} · \`${row.key}\` · #${row.id} · 证据 #${row.evidence_event_id}`);
      }
      sections.push("");
    }

    if (inactive.length > 0) {
      sections.push("## 历史（已覆盖 / 已失效）", "");
      for (const row of inactive) {
        sections.push(`- ~~${row.content}~~ \`${row.key}\` · ${row.status}${row.note ? ` · ${row.note}` : ""}`);
      }
      sections.push("");
    }

    sections.push(
      "---",
      "",
      `- 生成时间：${now()}`,
      `- 活跃 ${active.length} / 争议 ${contested.length} / 历史 ${inactive.length}`,
      "",
    );
    writeFileSync(path.join(this.dir, "MEMORY.md"), sections.join("\n"), "utf8");
  }

  close(): void {
    this.db.close();
  }
}
