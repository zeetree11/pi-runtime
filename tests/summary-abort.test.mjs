import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const dir = mkdtempSync(path.join(tmpdir(), "pi-rt-abort-"));
const log = path.join(dir, "prompts.log");
process.env.PI_RT_DATA_DIR = dir;
process.env.PI_RT_PI_BIN = path.resolve("tests/fixtures/fake-pi.mjs");
writeFileSync("/tmp/pi-rt-fake.json", JSON.stringify({ mode: "delay-settle", delay: 1500, log }));

const { Store } = await import("../src/db.ts");
const { loadConfig } = await import("../src/config.ts");
const { runTask } = await import("../src/worker.ts");

let pass = 0;
let fail = 0;
const check = (name, ok, extra = "") => {
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${ok ? "" : ` ${extra}`}`);
  ok ? pass++ : fail++;
};

const store = new Store(path.join(dir, "runtime.db"));
const thread = "web:c_abort";
store.addConversationEvent(thread, "Rick", "user", "较早的事实，内容足够长，应该被压进摘要里。", null);
store.addConversationEvent(thread, "agent", "assistant", "更早的回复，同样足够长，留在窗口之外。", null);
store.addConversationEvent(thread, "Rick", "user", "最近一句。", null);
const taskId = store.createTask("现在这句话", dir, thread);
const base = loadConfig();
const cfg = {
  ...base,
  dataDir: dir,
  workspace: dir,
  summaryEnabled: true,
  summaryTriggerChars: 10,
  summaryMaxChars: 200,
  contextTurns: 1,
  contextBudgetChars: 10_000,
  memoryEnabled: false,
  maxMinutes: 1,
  limits: { ...base.limits, maxAttempts: 1, dailyTokens: 0, taskTokens: 0 },
};

const controller = new AbortController();
const started = Date.now();
setTimeout(() => controller.abort(), 200);
let message = "";
try {
  await runTask(store, cfg, store.getTask(taskId), { signal: controller.signal, recordUserEvent: false }, null);
  message = "resolved";
} catch (error) {
  message = error instanceof Error ? error.message : String(error);
}
const elapsed = Date.now() - started;
const prompts = existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").filter(Boolean) : [];

check("stop during summary rejects the turn", message === "aborted" && elapsed < 1_200, `${message} ${elapsed}ms`);
check("stop during summary does not run the main prompt", prompts.length <= 1, prompts.join(" | "));

store.close();
rmSync(dir, { recursive: true, force: true });

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
