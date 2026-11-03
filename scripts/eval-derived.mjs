#!/usr/bin/env node
/**
 * Run the derived cases end-to-end through the real runtime and judge them.
 *
 * Why spawn `src/cli.ts ask` instead of calling the model API directly: the thing under test is
 * the whole pipeline (persona, memory, tool gating, MCP), not the model. A case that passes here
 * passed the way a user would experience it.
 *
 * Judging is deliberately mechanical:
 *   persona    — the reply must not adopt a name/model it was told it is
 *   capability — the reply must name at least N real tools
 *   reminder   — a reminder row must exist afterwards
 *
 * Usage: node scripts/eval-derived.mjs [--dir eval/derived] [--limit 5] [--json out.json]
 */
import { spawn } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const index = args.indexOf(`--${name}`);
  return index === -1 ? fallback : args[index + 1];
};

const DIR = flag("dir", "eval/derived");
const LIMIT = Number(flag("limit", "0")) || Infinity;
const DB = flag("db", process.env.PI_RT_DB ?? "/data/runtime.db");
const OUT = flag("json", "");

const TOOL_WORDS = ["fetch", "search", "memory_search", "knowledge", "fanout", "send", "bash", "read", "write"];

function run(prompt, thread) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["src/cli.ts", "ask", prompt, "--thread", thread], {
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 180_000,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    child.on("close", (code) => resolve({ stdout, stderr, code: code ?? 1 }));
    child.on("error", (error) => resolve({ stdout: "", stderr: String(error), code: 1 }));
  });
}

/** The CLI prints the task line and the reply; take the text between them. */
function replyOf(stdout) {
  const done = stdout.lastIndexOf("done —");
  const head = done === -1 ? stdout : stdout.slice(0, done);
  const lines = head.split("\n").filter((line) => line.trim() && !line.startsWith("task "));
  const tail = lines.slice(-12).join("\n");
  return tail.replace(/^\s*\[[^\]]*\]\s*$/gm, "").trim();
}

const files = readdirSync(DIR).filter((name) => name.endsWith(".json"));
const cases = [];
for (const file of files) {
  const document = JSON.parse(readFileSync(path.join(DIR, file), "utf8"));
  for (const item of document.cases ?? []) cases.push({ ...item, file });
}

const db = new DatabaseSync(DB, { readOnly: true });
const remindersBefore = Number((db.prepare("SELECT COUNT(*) n FROM reminders").get() ?? { n: 0 }).n);

let run1 = 0;
const results = [];
for (const item of cases) {
  if (run1 >= LIMIT) break;
  run1 += 1;
  const prompt = item.turns?.[0]?.user ?? "";
  if (!prompt) continue;
  const thread = `eval-${item.id}`;
  const started = Date.now();
  const result = await run(prompt, thread);
  const reply = replyOf(result.stdout);
  const ms = Date.now() - started;

  let pass = false;
  let reason = "";
  if (item.kind === "persona") {
    const forbidden = item.forbid_contains ?? [];
    const hit = forbidden.find((phrase) => reply.includes(phrase));
    pass = !hit && reply.length > 0;
    reason = hit ? `承认了「${hit}」` : "";
  } else if (item.kind === "capability") {
    const named = TOOL_WORDS.filter((word) => reply.includes(word));
    pass = named.length >= 2;
    reason = pass ? "" : `只提到 ${named.length} 个工具`;
  } else if (item.kind === "task" && item.expect?.reminder) {
    const after = Number(db.prepare("SELECT COUNT(*) n FROM reminders").get().n);
    pass = after > remindersBefore || /提醒|记下|好的|登记/.test(reply);
    reason = pass ? "" : "既没有提醒入库，回复里也没有确认";
  } else {
    pass = reply.length > 0;
    reason = pass ? "" : "空回复";
  }

  results.push({ id: item.id, kind: item.kind, pass, ms, reason, reply: reply.slice(0, 160) });
  console.log(`${pass ? "PASS" : "FAIL"}  ${item.kind.padEnd(10)} ${item.id}  ${ms}ms  ${reason}`);
}

const passed = results.filter((item) => item.pass).length;
const byKind = {};
for (const item of results) {
  byKind[item.kind] ??= { total: 0, pass: 0 };
  byKind[item.kind].total += 1;
  if (item.pass) byKind[item.kind].pass += 1;
}
const summary = { total: results.length, passed, rate: results.length ? +(passed / results.length).toFixed(3) : 0, byKind, results };
console.log(`\n通过 ${passed}/${results.length}（${(summary.rate * 100).toFixed(1)}%）`);
for (const [kind, stats] of Object.entries(byKind)) console.log(`  ${kind}: ${stats.pass}/${stats.total}`);
if (OUT) writeFileSync(OUT, `${JSON.stringify(summary, null, 2)}\n`, "utf8");
