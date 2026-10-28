import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import path from "node:path";

/**
 * Badcase capture: when the user says "不对", keep the exchange that produced it.
 *
 * Why this exists: the eval set was hand-written, so it only covers mistakes I thought of. The
 * mistakes that actually happen are, by definition, the ones I did not think of. A one-word
 * complaint is the cheapest possible signal, and it arrives exactly when the failure does.
 *
 * What it deliberately does *not* do: turn the complaint into an assertion automatically. "不对"
 * does not say what the right answer is; deriving `expect` from it would produce a test that
 * asserts the correction's wording rather than its meaning. So a draft is stored with the raw
 * exchange and a *suggested* keyword set, and stays `draft` until a human edits and accepts it.
 */
export const COMPLAINT = /(不对|错了|搞错|不是这样|不是这个|答错|说得不对|瞎说|别瞎说|重新回答|你误会了)/;

export type FeedbackStatus = "draft" | "accepted" | "dropped";

export type FeedbackRow = {
  id: number;
  thread: string;
  userText: string;
  agentReply: string;
  correction: string;
  status: FeedbackStatus;
  createdAt: string;
};

export function isComplaint(text: string): boolean {
  return COMPLAINT.test(String(text ?? ""));
}

/**
 * Suggest keywords a human can turn into `expect.contains`.
 *
 * Numbers, versions and latin tokens only: they are checkable and never paraphrase-dependent.
 * Chinese phrases are left out on purpose — a phrase matcher on a paraphrase asserts the wording,
 * not the fact.
 */
export function suggestKeywords(correction: string): string[] {
  const tokens = new Set<string>();
  for (const match of String(correction ?? "").matchAll(/[A-Za-z][A-Za-z0-9_.-]{1,20}|\d[\d,.]*/g)) {
    const token = match[0].toLowerCase().replace(/[.,]$/, "");
    if (token.length >= 2) tokens.add(token);
  }
  return [...tokens].slice(0, 5);
}

export class FeedbackStore {
  private readonly db: DatabaseSync;

  constructor(dataDir: string) {
    this.db = new DatabaseSync(path.join(dataDir, "runtime.db"));
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec("PRAGMA busy_timeout = 5000;");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS feedback_cases (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        thread      TEXT NOT NULL,
        user_text   TEXT NOT NULL,
        agent_reply TEXT NOT NULL,
        correction  TEXT NOT NULL,
        status      TEXT NOT NULL DEFAULT 'draft',
        created_at  TEXT NOT NULL
      );
    `);
    this.db.exec("CREATE INDEX IF NOT EXISTS idx_feedback_status ON feedback_cases(status, id);");
  }

  /**
   * Take the last user/assistant pair for a thread and attach the complaint to it.
   *
   * The complaint itself is the newest user event, so the pair is looked up *before* it. If the
   * shape is not a clean user→assistant exchange (e.g. the agent never answered), nothing is
   * captured: a case with no wrong answer cannot teach anything.
   */
  captureFromThread(thread: string, correction: string): FeedbackRow | null {
    const rows = this.db
      .prepare(
        `SELECT role, text FROM conversation_events
          WHERE thread = ? ORDER BY id DESC LIMIT 6`,
      )
      .all(thread) as Array<{ role: string; text: string }>;

    // Newest first: skip the complaint (user), then require an assistant reply, then a user turn.
    let agentReply = "";
    let userText = "";
    for (const row of rows) {
      if (!agentReply && row.role === "assistant") {
        agentReply = row.text;
        continue;
      }
      if (agentReply && row.role === "user") {
        userText = row.text;
        break;
      }
    }
    if (!agentReply || !userText) return null;
    if (isComplaint(userText)) return null; // two complaints in a row: keep the earlier pair

    const recent = this.db
      .prepare("SELECT correction FROM feedback_cases WHERE thread = ? ORDER BY id DESC LIMIT 1")
      .get(thread) as { correction: string } | undefined;
    if (recent && recent.correction === correction) return null;

    const result = this.db
      .prepare(
        `INSERT INTO feedback_cases (thread, user_text, agent_reply, correction, status, created_at)
         VALUES (?, ?, ?, ?, 'draft', ?)`,
      )
      .run(thread, userText, agentReply, String(correction).slice(0, 500), new Date().toISOString());
    return this.byId(Number(result.lastInsertRowid));
  }

  byId(id: number): FeedbackRow | null {
    const row = this.db.prepare("SELECT * FROM feedback_cases WHERE id = ?").get(id) as Record<string, unknown> | undefined;
    return row ? toRow(row) : null;
  }

  drafts(): FeedbackRow[] {
    const rows = this.db.prepare("SELECT * FROM feedback_cases WHERE status = 'draft' ORDER BY id DESC").all() as Array<
      Record<string, unknown>
    >;
    return rows.map(toRow);
  }

  accept(id: number): FeedbackRow | null {
    return this.setStatus(id, "accepted");
  }

  drop(id: number): FeedbackRow | null {
    return this.setStatus(id, "dropped");
  }

  private setStatus(id: number, status: FeedbackStatus): FeedbackRow | null {
    this.db.prepare("UPDATE feedback_cases SET status = ? WHERE id = ? AND status = 'draft'").run(status, id);
    return this.byId(id);
  }

  /** Convert to the eval-case shape. `expect` is left empty on purpose: a human fills it in. */
  toEvalCase(row: FeedbackRow): Record<string, unknown> {
    return {
      id: `fb${String(row.id).padStart(3, "0")}`,
      goal: `真实使用回归：${row.correction.slice(0, 40)}`,
      kind: "negative",
      turns: [
        { user: row.userText, assistant: row.agentReply },
        { user: row.correction },
      ],
      expect: [],
      suggest: { contains: suggestKeywords(row.correction) },
      needs_review: true,
      source: "real-usage",
    };
  }
}

/** Append accepted cases to a JSON file, keeping it valid and de-duplicated by id. */
export function appendCases(file: string, cases: Array<Record<string, unknown>>): number {
  mkdirSync(path.dirname(file), { recursive: true });
  let document: { version?: number; note?: string; cases: Array<Record<string, unknown>> } = { version: 1, cases: [] };
  if (existsSync(file)) {
    try {
      document = JSON.parse(readFileSync(file, "utf8")) as typeof document;
      document.cases ??= [];
    } catch {
      document = { version: 1, cases: [] };
    }
  }
  const known = new Set(document.cases.map((item) => String(item.id)));
  let added = 0;
  for (const item of cases) {
    if (known.has(String(item.id))) continue;
    document.cases.push(item);
    known.add(String(item.id));
    added += 1;
  }
  document.note = "从真实使用中沉淀的回归用例（feedback accept 生成，expect 需人工补）";
  writeFileSync(file, `${JSON.stringify(document, null, 2)}\n`, "utf8");
  return added;
}

function toRow(row: Record<string, unknown>): FeedbackRow {
  return {
    id: Number(row.id),
    thread: String(row.thread),
    userText: String(row.user_text),
    agentReply: String(row.agent_reply),
    correction: String(row.correction),
    status: String(row.status) as FeedbackStatus,
    createdAt: String(row.created_at),
  };
}
