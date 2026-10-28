import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { FeedbackStore, appendCases, isComplaint, suggestKeywords } from "../src/feedback.ts";

let pass = 0;
let fail = 0;
function check(name, ok, detail = "") {
  if (ok) {
    pass += 1;
    console.log(`PASS ${name}`);
  } else {
    fail += 1;
    console.log(`FAIL ${name} ${detail}`);
  }
}

// 1) complaint detection
{
  check("不对 detected", isComplaint("不对") === true);
  check("你搞错了 detected", isComplaint("你搞错了") === true);
  check("answered wrong detected", isComplaint("答错了，应该用 SQLite") === true);
  check("normal message is not a complaint", isComplaint("帮我查一下天气") === false);
  check("thanks is not a complaint", isComplaint("谢谢") === false);
}

// 2) keyword suggestion keeps only checkable tokens
{
  const keywords = suggestKeywords("不对，版本是 v3.2.1，预算 45");
  check("version kept", keywords.includes("v3.2.1"), JSON.stringify(keywords));
  check("number kept", keywords.includes("45"), JSON.stringify(keywords));
  check("chinese prose dropped", !keywords.some((word) => /[\u4e00-\u9fa5]/.test(word)), JSON.stringify(keywords));
  check("empty input yields empty", suggestKeywords("").length === 0);
}

// 3) capture needs a real user→assistant pair
{
  const dir = mkdtempSync(path.join(tmpdir(), "pi-feedback-"));
  const db = new DatabaseSync(path.join(dir, "runtime.db"));
  db.exec(`
    CREATE TABLE IF NOT EXISTS conversation_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT, thread TEXT, speaker TEXT, role TEXT, text TEXT, created_at TEXT
    );
  `);
  const insert = db.prepare("INSERT INTO conversation_events (thread, speaker, role, text, created_at) VALUES (?,?,?,?,?)");
  insert.run("t1", "Rick", "user", "预算多少？", new Date().toISOString());
  insert.run("t1", "agent", "assistant", "预算是 30 万。", new Date().toISOString());
  insert.run("t1", "Rick", "user", "不对，是 45 万", new Date().toISOString());
  db.close();

  const store = new FeedbackStore(dir);
  const captured = store.captureFromThread("t1", "不对，是 45 万");
  check("capture found the pair", captured !== null, "null");
  check("user text is the question", captured?.userText === "预算多少？", captured?.userText);
  check("agent text is the wrong answer", captured?.agentReply.includes("30 万"), captured?.agentReply);
  check("correction recorded", captured?.correction.includes("45"), captured?.correction);
  check("status is draft", captured?.status === "draft", captured?.status);

  const again = store.captureFromThread("t1", "不对，是 45 万");
  check("same correction not captured twice", again === null);

  check("drafts list it", store.drafts().length === 1, String(store.drafts().length));

  // 4) eval case shape
  const evalCase = store.toEvalCase(captured);
  check("case id prefixed", String(evalCase.id).startsWith("fb"), String(evalCase.id));
  check("expect is empty for human review", Array.isArray(evalCase.expect) && evalCase.expect.length === 0);
  check("flagged for review", evalCase.needs_review === true);
  check("turns keep the wrong exchange", Array.isArray(evalCase.turns) && evalCase.turns.length === 2);
  check("suggest has the number", JSON.stringify(evalCase.suggest).includes("45"), JSON.stringify(evalCase.suggest));

  // 5) accept appends to a case file, dedup by id
  const file = path.join(dir, "eval", "holdout-real.json");
  check("append adds one", appendCases(file, [evalCase]) === 1);
  check("append is idempotent", appendCases(file, [evalCase]) === 0);
  const document = JSON.parse(readFileSync(file, "utf8"));
  check("file has the case", document.cases.length === 1, String(document.cases.length));
  check("file notes provenance", String(document.note).includes("真实使用"));

  check("accept marks status", store.accept(captured.id)?.status === "accepted", store.accept(captured.id)?.status);
  check("accepted leaves drafts", store.drafts().length === 0);

  // 6) drop
  insert;
  const second = new FeedbackStore(dir);
  const db2 = new DatabaseSync(path.join(dir, "runtime.db"));
  db2.prepare("INSERT INTO conversation_events (thread, speaker, role, text, created_at) VALUES (?,?,?,?,?)")
    .run("t2", "Rick", "user", "端口多少", new Date().toISOString());
  db2.prepare("INSERT INTO conversation_events (thread, speaker, role, text, created_at) VALUES (?,?,?,?,?)")
    .run("t2", "agent", "assistant", "3001", new Date().toISOString());
  db2.close();
  const third = second.captureFromThread("t2", "不对，是 3002");
  check("second capture works", third !== null);
  check("drop marks it", third ? second.drop(third.id)?.status === "dropped" : false);

  try { rmSync(dir, { recursive: true, force: true }); } catch { /* Windows handle */ }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
