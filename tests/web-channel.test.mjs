import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync, rmSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { Store } from "../src/db.ts";
import { MemoryStore } from "../src/memory.ts";
import { Members } from "../src/members.ts";
import { ApprovalStore } from "../src/approval.ts";
import { ProposalStore } from "../src/proposal.ts";
import { ReminderStore } from "../src/reminders.ts";
import { FeedbackStore } from "../src/feedback.ts";
import { loadConfig } from "../src/config.ts";
import {
  CHAT_ID,
  listWebSessions,
  presentAssistantText,
  readWebSession,
  resolveWorkspaceFile,
  runWebTurn,
  startWebServer,
  webThread,
} from "../src/channels/web.ts";

let pass = 0;
let fail = 0;
const check = (name, ok, extra = "") => {
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${ok ? "" : ` ${extra}`}`);
  ok ? pass++ : fail++;
};

const dir = mkdtempSync(path.join(tmpdir(), "pi-rt-web-"));
const store = new Store(path.join(dir, "runtime.db"));

check("chat id accepts generated ids", CHAT_ID.test("c_abc-123_x"));
check("chat id rejects path tricks", !CHAT_ID.test("../etc") && !CHAT_ID.test("a/b") && !CHAT_ID.test(""));

store.addConversationEvent("web:c_one", "Rick", "user", "总结一下这个仓库", "t1");
store.addConversationEvent("web:c_one", "agent", "assistant", "这是一个运行时。\n<!--remind: 2099-01-01 09:00 | 不用管-->", "t1");
store.addConversationEvent("web:c_two", "Rick", "user", "另一段", "t2");
store.addConversationEvent("axb:secret", "Rick", "user", "不应被 a_b 前缀命中", null);
store.addConversationEvent("a_b:kept", "Rick", "user", "下划线前缀", null);
store.appendEvent("t1", "tool_execution_start", { toolName: "read", toolCallId: "call-1" });
store.appendEvent("t1", "tool_execution_end", { toolName: "read", toolCallId: "call-1", isError: false, output: "README" });
store.appendEvent("t1", "memory_injected", { ids: [7], chars: 12 });

const listed = store.listThreads("a_b:");
check("thread prefix treats underscore literally", listed.length === 1 && listed[0].thread === "a_b:kept", JSON.stringify(listed));

const sessions = listWebSessions(store);
check("web sessions hide other channels", sessions.length === 2, JSON.stringify(sessions));
check("session title comes from the first user line", sessions.find((item) => item.id === "c_one")?.title === "总结一下这个仓库");

const detail = readWebSession(store, "c_one", {}, dir);
const assistant = detail.messages.find((message) => message.role === "assistant");
check("history strips reminder tokens", assistant?.text === "这是一个运行时。", JSON.stringify(assistant));
check("history keeps tool calls", assistant?.tools.length === 1 && assistant.tools[0].name === "read" && assistant.tools[0].preview === "README");
check("history keeps injected-memory step", assistant?.steps.some((step) => step.includes("记忆注入")));
check("presentAssistantText drops ask tokens", presentAssistantText("可以。\n<!--ask: rm -rf /-->") === "可以。");

writeFileSync(path.join(dir, "note.txt"), "hello");
const allowed = resolveWorkspaceFile(dir, "note.txt");
check("workspace file resolves inside the root", allowed.ok === true && allowed.bytes === 5);
const escaped = resolveWorkspaceFile(dir, "../package.json");
check("workspace file rejects traversal", escaped.ok === false && escaped.status === 403, JSON.stringify(escaped));
const weird = resolveWorkspaceFile(dir, "nope.exe");
check("workspace file rejects unknown types", weird.ok === false && weird.status === 400);

const info = {
  ok: true,
  name: "Tree-Agent",
  channel: "web",
  ownerName: "Rick",
  provider: null,
  model: "test-model",
  workspace: dir,
  sandbox: "safe",
  memoryEnabled: true,
  usageToday: { total: 0, cost: 0, runs: 0 },
};

writeFileSync(path.join(dir, "config.json"), '{"feishu":{"appSecret":"super-secret"}}');
mkdirSync(path.join(dir, "secrets"));
writeFileSync(path.join(dir, "secrets", "mcp.json"), '{"API_TOKEN":"tok"}');
symlinkSync("/etc/hostname", path.join(dir, "outside.txt"));
let startedTurns = 0;

const server = await startWebServer({
  port: 0,
  host: "127.0.0.1",
  token: "test-token",
  workspace: dir,
  blockedRoots: [path.join(dir, "secrets")],
  staticDir: dir,
  info: () => info,
  sessions: () => listWebSessions(store),
  session: (chatId) => readWebSession(store, chatId, {}, dir),
  inspect: (section) => ({ section, items: section === "memory" ? [] : undefined }),
  turn: async ({ chatId, text, emit, signal }) => {
    startedTurns += 1;
    emit({ type: "status", message: "started" });
    emit({ type: "thinking", delta: "想一下" });
    emit({ type: "text", delta: `收到：${text}` });
    await new Promise((resolve) => {
      if (signal.aborted) return resolve();
      signal.addEventListener("abort", () => resolve(), { once: true });
      if (chatId !== "c_block") resolve();
    });
    emit({ type: "done", text: `收到：${text}`, taskId: "t_test", stopped: signal.aborted });
  },
});

writeFileSync(path.join(dir, "index.html"), "<!doctype html><title>ui</title>");

function authHeaders(extra = {}) {
  return { authorization: "Bearer test-token", ...extra };
}

async function api(pathname, options = {}) {
  return fetch(`http://127.0.0.1:${server.port}${pathname}`, options);
}

const denied = await api("/api/health");
check("missing token is rejected", denied.status === 401);

const health = await api("/api/health", { headers: authHeaders() });
const healthBody = await health.json();
check("health reports the runtime", health.status === 200 && healthBody.model === "test-model" && healthBody.name === "Tree-Agent");

const preflight = await api("/api/health", { method: "OPTIONS", headers: { origin: "http://127.0.0.1:5173" } });
check("preflight allows the dev server", preflight.status === 204 && preflight.headers.get("access-control-allow-origin") === "http://127.0.0.1:5173");

const evilPreflight = await api("/api/health", {
  method: "OPTIONS",
  headers: {
    origin: "https://evil.example",
    "access-control-request-method": "POST",
    "access-control-request-headers": "content-type, authorization",
  },
});
check(
  "evil origin preflight is not granted",
  evilPreflight.status === 403 && evilPreflight.headers.get("access-control-allow-origin") === null,
);

const evilTurn = await api("/api/sessions/c_evil/messages", {
  method: "POST",
  headers: authHeaders({ origin: "https://evil.example", "content-type": "application/json" }),
  body: JSON.stringify({ text: "pwn" }),
});
check("evil origin cannot start a turn", evilTurn.status === 403 && startedTurns === 0, `status ${evilTurn.status} turns ${startedTurns}`);

const rebound = await new Promise((resolve) => {
  const req = httpRequest(
    {
      hostname: "127.0.0.1",
      port: server.port,
      path: "/api/health",
      headers: { host: "evil.example", authorization: "Bearer test-token" },
    },
    (response) => {
      response.resume();
      response.on("end", () => resolve(response.statusCode));
    },
  );
  req.end();
});
check("non-loopback Host is refused", rebound === 403, String(rebound));

const listedHttp = await api("/api/sessions", { headers: authHeaders() });
const listedBody = await listedHttp.json();
check("session list is served", listedBody.sessions.length === 2);

const created = await api("/api/sessions", { method: "POST", headers: authHeaders() });
const createdBody = await created.json();
check("creating a session returns an id", created.status === 201 && CHAT_ID.test(createdBody.id), JSON.stringify(createdBody));

const bad = await api("/api/sessions/bad!id", { headers: authHeaders() });
check("illegal session id is rejected", bad.status === 400);

const emptyPost = await api("/api/sessions/c_one/messages", {
  method: "POST",
  headers: authHeaders({ "content-type": "application/json" }),
  body: JSON.stringify({ text: "   " }),
});
check("blank message is rejected", emptyPost.status === 400);

const page = await api("/");
check("static index is served", page.status === 200 && (await page.text()).includes("ui"));

const memory = await api("/api/memory", { headers: authHeaders() });
check("inspect section is served", (await memory.json()).section === "memory");

const file = await api("/api/files?path=note.txt", { headers: authHeaders() });
check("allow-listed workspace file is readable", file.status === 200 && (await file.text()) === "hello");
const sneak = await api("/api/files?path=../package.json", { headers: authHeaders() });
check("file route rejects traversal", sneak.status === 403);
const configFile = await api("/api/files?path=config.json", { headers: authHeaders() });
check("config.json is not served", configFile.status === 403);
const secretFile = await api("/api/files?path=secrets/mcp.json", { headers: authHeaders() });
check("runtime data directory is not served", secretFile.status === 403);
const link = await api("/api/files?path=outside.txt", { headers: authHeaders() });
check("symlink outside the workspace is not served", link.status === 403);

async function readSse(response) {
  const raw = await response.text();
  return raw
    .split("\n\n")
    .map((block) => block.split("\n").find((line) => line.startsWith("data:"))?.slice(5).trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

const streamed = await api("/api/sessions/c_one/messages", {
  method: "POST",
  headers: authHeaders({ "content-type": "application/json" }),
  body: JSON.stringify({ text: "你好", messageId: "m_hello" }),
});
const events = await readSse(streamed);
check("sse streams text then done", events.some((event) => event.type === "text" && event.delta === "收到：你好") && events.at(-1)?.type === "done");
check("sse includes thinking", events.some((event) => event.type === "thinking" && event.delta === "想一下"));

const blocking = api("/api/sessions/c_block/messages", {
  method: "POST",
  headers: authHeaders({ "content-type": "application/json" }),
  body: JSON.stringify({ text: "停一下" }),
});
await new Promise((resolve) => setTimeout(resolve, 80));
const conflict = await api("/api/sessions/c_block/messages", {
  method: "POST",
  headers: authHeaders({ "content-type": "application/json" }),
  body: JSON.stringify({ text: "再来一条" }),
});
check("a busy session rejects a second turn", conflict.status === 409);
const stopped = await api("/api/sessions/c_block/stop", { method: "POST", headers: authHeaders() });
check("stop aborts the live turn", stopped.status === 200 && (await stopped.json()).ok === true);
const blockedEvents = await readSse(await blocking);
check("stopped turn ends with stopped", blockedEvents.at(-1)?.stopped === true, JSON.stringify(blockedEvents.at(-1)));
const idleStop = await api("/api/sessions/c_one/stop", { method: "POST", headers: authHeaders() });
check("stop with nothing running is 404", idleStop.status === 404);

await server.close();

// The turn itself goes through ingest + runTask hooks, with a fake executor so no model is required.
const cfg = {
  ...loadConfig(),
  dataDir: dir,
  workspace: dir,
  ownerName: "Rick",
  batchTurns: 99,
  memoryEnabled: false,
};
const memoryStore = new MemoryStore(dir, "Rick");
const members = new Members(dir);
members.ensureOwner("Rick");
const gateway = { store, members, dataDir: dir, ownerName: "Rick", ownerIds: [] };
const approvals = new ApprovalStore(dir);
const proposals = new ProposalStore(dir);
const reminders = new ReminderStore(dir);
const feedback = new FeedbackStore(dir);
const seen = [];

const live = await startWebServer({
  port: 0,
  host: "127.0.0.1",
  workspace: dir,
  info: () => info,
  sessions: () => listWebSessions(store),
  session: (chatId) => readWebSession(store, chatId, {}, dir),
  inspect: () => ({}),
  turn: (input) =>
    runWebTurn(
      {
        cfg,
        store,
        memory: memoryStore,
        gateway,
        approvals,
        proposals,
        reminders,
        feedback,
        control: { setSession() {} },
        busy: new Set(),
        run: async (_store, _cfg, task, hooks) => {
          seen.push(task.prompt);
          hooks.onText?.("仓库是个人 Agent 运行时。");
          hooks.onActivity?.({ kind: "tool", phase: "start", name: "read", callId: "k1" });
          hooks.onActivity?.({ kind: "tool", phase: "end", name: "read", callId: "k1", preview: "ok" });
          _store.finishTask(task.id, "仓库是个人 Agent 运行时。");
          _store.addConversationEvent(task.thread, "agent", "assistant", "仓库是个人 Agent 运行时。", task.id);
          return "仓库是个人 Agent 运行时。";
        },
      },
      input,
    ),
});

const bare = await fetch(`http://127.0.0.1:${live.port}/api/health`);
check("generated token is not optional", bare.status === 401 && live.token.length > 16);
const open = await fetch(`http://127.0.0.1:${live.port}/api/health`, {
  headers: { authorization: `Bearer ${live.token}` },
});
check("generated token is accepted", open.status === 200);

const turn = await fetch(`http://127.0.0.1:${live.port}/api/sessions/c_live/messages`, {
  method: "POST",
  headers: { "content-type": "application/json", authorization: `Bearer ${live.token}` },
  body: JSON.stringify({ text: "这个仓库是做什么的", messageId: "m_live" }),
});
const turnEvents = await readSse(turn);
check("runWebTurn streams the executor text", turnEvents.some((event) => event.type === "text" && event.delta.includes("运行时")));
check("runWebTurn forwards tool activity", turnEvents.some((event) => event.type === "tool" && event.name === "read" && event.phase === "end"));
check("runWebTurn finishes the turn", turnEvents.at(-1)?.type === "done" && turnEvents.at(-1).text.includes("运行时"));

const again = await fetch(`http://127.0.0.1:${live.port}/api/sessions/c_live/messages`, {
  method: "POST",
  headers: { "content-type": "application/json", authorization: `Bearer ${live.token}` },
  body: JSON.stringify({ text: "这个仓库是做什么的", messageId: "m_live" }),
});
const againEvents = await readSse(again);
check("duplicate message id is ignored", againEvents[0]?.type === "error");

const saved = readWebSession(store, "c_live", {}, dir);
check("turn is persisted on the web thread", saved.messages.length === 2 && saved.messages[0].role === "user" && saved.messages[1].role === "assistant", JSON.stringify(saved.messages.map((m) => m.role)));
check("thread name is channel scoped", webThread("c_live") === "web:c_live");
check("executor saw the user text", seen[0] === "这个仓库是做什么的" && seen.length === 1, JSON.stringify(seen));

await live.close();
memoryStore.close();
members.close();
store.close();
rmSync(dir, { recursive: true, force: true });

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
