#!/usr/bin/env node
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { DB_PATH, DATA_DIR, PI_CLI, ensureDirs, loadConfig, piArgs, piEnv } from "./config.ts";
import { Store } from "./db.ts";
import { MemoryStore } from "./memory.ts";
import type { MemoryCategory } from "./memory.ts";
import { distillBatch } from "./distill.ts";
import type { DistillResult } from "./distill.ts";
import { runEval } from "./eval.ts";
import { runContextEval } from "./eval-context.ts";
import { PiRpc } from "./rpc.ts";
import { runTask } from "./worker.ts";
import { Members } from "./members.ts";
import { ShortStateStore, parseTtl } from "./short-state.ts";
import { ReminderStore, extractReminderDirectives, parseWhen } from "./reminders.ts";
import { enforceBrevity } from "./brevity.ts";
import { embedText } from "../mcp/lib/embed.mjs";
import { ApprovalStore, extractAskDirectives, parseDecision } from "./approval.ts";
import { NoteStore } from "./fanout.ts";
import { startControlServer } from "./api.ts";
import { DEFAULT_CONTRACTS_LIMIT, DEFAULT_SOUL_LIMIT, PERSONA_DIR, SOUL_FILE, contractsPath, contractsUsage, ensureStanding, personaUsage, readContracts, readSoul, soulPath, standingUsage, writeContracts, writeSoul } from "./persona.ts";
import { CalibrationStore, charsPerTokenFrom, DEFAULT_CHARS_PER_TOKEN, MIN_SAMPLES } from "./calibration.ts";
import { NOISE_TYPES } from "./event-log.ts";
import { runMaintenance } from "./maintenance.ts";
import { archiveConversationEvents, backupDatabase, inspectArchives, newestBackupAgeHours } from "./archive.ts";
import { normalizeMode, sandboxReport } from "./sandbox.ts";
import { exportMemoryToGit } from "./memory-git.ts";
import { summarizeToolCalls, listMcpServers, formatToolReport } from "./tools-report.ts";
import { buildSpanTree, formatSpanTree } from "./trace.ts";
import { describePolicy } from "./sandbox.ts";
import { OneBotClient, oneBotToIncoming, sendTargetFromChatId, shouldAnswer } from "./channels/onebot.ts";
import { Gate } from "./gate.ts";
import { buildDigest, buildSplitPrompt, canSpawn, parseSubtasks, runWithLimit } from "./subagent.ts";
import type { ChildResult } from "./subagent.ts";
import { promoteShortState } from "./promote.ts";
import { ingest } from "./gateway.ts";
import type { Incoming } from "./gateway.ts";
import { TelegramChannel } from "./channels/telegram.ts";
import { FeishuChannel } from "./channels/feishu.ts";
import { startFeishuWebhook } from "./channels/feishu-webhook.ts";

const USAGE = `pi-runtime — a personal agent runtime built on pi

tasks:
  node src/cli.ts doctor                     check pi, model and config state
  node src/cli.ts login                      run pi's /login against the isolated config dir
  node src/cli.ts ask "<prompt>"             run one task now (queued + persisted)
  node src/cli.ts ask "..." [--thread <t>]   keep turns in a conversation thread
  node src/cli.ts ask "..." --extract        force memory extraction after the run
  node src/cli.ts worker [--once]            daemon: drain queue, distil idle threads
  node src/cli.ts list [n]                   recent tasks
  node src/cli.ts show <task-id>             one task, result and event trail

memory:
  node src/cli.ts remember "<text>" --key <slot> [--category preference|fact|event]
                                          [--importance 1-5] [--target self|group|member:张三]
                                          [--evidence "<原话>"] [--event <event-id>]
  node src/cli.ts memories [category] [--all]
  node src/cli.ts history <key>              full supersede / invalidate / contest chain
  node src/cli.ts events <thread>            the numbered conversation events
  node src/cli.ts thread <thread>            rolling summary + compression cursor

short state (临时状态，按 key 命中，带 TTL):
  node src/cli.ts state set <key> <value> [--ttl 12h] [--scope <thread>]
  node src/cli.ts state list [--scope <thread>]
  node src/cli.ts state prune                mark expired rows stale
  node src/cli.ts state promote <key> [--category fact] [--as <memory-key>]
  node src/cli.ts state del <key> [--scope <thread>]
  node src/cli.ts calibrate [--backfill] [--reset]   token 估算校准
  node src/cli.ts compact [--dry-run] [--vacuum]    清理事件表里的流式增量
  node src/cli.ts archive [--days 30] [--dry-run] [--list]   归档旧事件为 JSONL.gz
  node src/cli.ts backup [--keep 7]               压缩快照数据库
  node src/cli.ts sandbox [--mode readonly|safe|full]  工具能力策略
  node src/cli.ts memory-git [--message "..."]   把记忆导出成可 diff 的 Git 仓库
  node src/cli.ts tree <task-id>                   查看任务与子 Agent 的派生树
  node src/cli.ts tools [--days 30] [--json]      工具调用审计（次数/成功率/耗时）+ MCP 清单
  node src/cli.ts trace <task-id>                  看一次运行的分层耗时（compose/model/tool）
  node src/cli.ts ask "..." --spawn N              拆成 N 个子 Agent 并行执行后汇总
  node src/cli.ts resolve <key> <keep-id>    adjudicate a contested slot
  node src/cli.ts forget <id>
  node src/cli.ts distill [--thread t] [--limit n]
  node src/cli.ts stats                      task + memory counters
  node src/cli.ts eval [--keep] [--only id] [--repeat N]  memory-extraction benchmark

channels:
  node src/cli.ts feed "<text>" --chat <id> --as <name> [--id <uid>] [--dm] [--run]
                                             ingest a message as a specific speaker
  node src/cli.ts members                    known identities
  node src/cli.ts serve --channel telegram    long-poll Telegram (needs TELEGRAM_BOT_TOKEN)
  node src/cli.ts serve --channel feishu      Feishu long connection (needs FEISHU_APP_ID/SECRET)
  node src/cli.ts serve --channel feishu-webhook [--port 8787]
  node src/cli.ts serve --channel qq            OneBot v11 (NapCat / Lagrange)
                                             Feishu webhook mode (testable locally)

env / config.json:
  PI_RT_WORKSPACE   folder the agent works in   (default: cwd)
  PI_RT_PROVIDER / PI_RT_MODEL
  PI_RT_MAX_MINUTES  wall-clock cap per task    (default: 30)
  PI_RT_BATCH_TURNS  distil after N turns       (default: 10)
  PI_RT_IDLE_MINUTES distil idle threads after  (default: 15)
`;

function flagValue(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  if (index === -1) return undefined;
  const value = args[index + 1];
  args.splice(index, value === undefined ? 1 : 2);
  return value;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const dim = (text: string) => process.stderr.write(`\x1b[2m[${text}]\x1b[0m\n`);

/** Memory rows are keyed by the owner's name, so every command must agree on it. */
function openMemory(): MemoryStore {
  return new MemoryStore(DATA_DIR, loadConfig().ownerName);
}

function printDistill(result: DistillResult): void {
  for (const applied of result.applied) {
    console.log(`  ${applied.action.padEnd(10)} ${applied.key}${applied.id ? ` (#${applied.id})` : ""} — ${applied.reason}`);
  }
  for (const rejected of result.rejected) {
    console.log(`  REJECTED   ${rejected.why} :: ${JSON.stringify(rejected.item).slice(0, 140)}`);
  }
  console.log(`  ${result.events} 条事件 → 应用 ${result.applied.length} 条，拒绝 ${result.rejected.length} 条`);
}

async function cmdDoctor(): Promise<number> {
  const cfg = loadConfig();
  console.log("runtime config");
  console.log(`  pi cli      ${PI_CLI}`);
  console.log(`  database    ${DB_PATH}`);
  console.log(`  workspace   ${cfg.workspace}`);
  console.log(`  provider    ${cfg.provider ?? "(pi default)"}`);
  console.log(`  model       ${cfg.model ?? "(pi default)"}`);
  console.log(`  memory      enabled=${cfg.memoryEnabled} budget=${cfg.memoryBudgetChars} turn/batch=${cfg.batchTurns} idle=${cfg.idleMinutes}m auto=${cfg.autoExtract}`);

  const rpc = new PiRpc({ cliPath: PI_CLI, cwd: cfg.workspace, args: piArgs(cfg), env: piEnv(cfg) });
  rpc.start();
  try {
    const state = await rpc.getState();
    const model = state?.model ?? {};
    console.log("\npi rpc handshake: ok");
    console.log(`  session     ${state?.sessionId}`);
    console.log(`  model       ${model.id ?? "unknown"} (${model.provider ?? "unknown"})`);
    console.log(`  compaction  autoCompaction=${state?.autoCompactionEnabled} streaming=${state?.isStreaming}`);
    if (!model.id || model.id === "unknown") {
      console.log("\n  ! no model bound yet — the pipe works, but a task cannot run.");
      console.log("    fix: `node src/cli.ts login`, or set PI_RT_PROVIDER / PI_RT_MODEL + a key.");
    }
    return 0;
  } finally {
    await rpc.dispose();
  }
}

async function cmdLogin(): Promise<number> {
  const cfg = loadConfig();
  console.log(`opening pi with config dir: ${piEnv(cfg).PI_CODING_AGENT_DIR}`);
  console.log("inside pi: run /login, pick a provider, then /quit when done.\n");
  const child = spawn(process.execPath, [PI_CLI], {
    cwd: cfg.workspace,
    env: { ...process.env, ...piEnv(cfg) } as NodeJS.ProcessEnv,
    stdio: "inherit",
  });
  return await new Promise<number>((resolve) => {
    child.on("exit", (code) => resolve(code ?? 0));
    child.on("error", (error) => {
      console.error(error);
      resolve(1);
    });
  });
}

/**
 * Spawn N sub-agents, then have a parent turn synthesise their reports.
 *
 * The split is done by the model rather than by punctuation: the boundaries should follow the
 * work, not the formatting. Children get their own gate so a batch runs in parallel even
 * though unrelated tasks stay serialised.
 */
async function runSpawned(
  store: Store,
  cfg: ReturnType<typeof loadConfig>,
  memory: ReturnType<typeof openMemory>,
  prompt: string,
  thread: string,
  count: number,
): Promise<number> {
  const concurrency = Math.max(1, Math.min(count, Number(process.env.PI_RT_SPAWN_CONCURRENCY ?? 3)));
  const gate = new Gate(concurrency, 0);
  const root = store.createTask(prompt, cfg.workspace, thread);
  console.log(`task ${root} queued  (thread: ${thread}  spawn: ${count} 并发: ${concurrency})\n`);

  const status = (message: string) => dim(message);

  const splitTask = store.createChildTask(buildSplitPrompt(prompt, count), cfg.workspace, thread, root, 0);
  const splitOut = await runTask(store, cfg, store.getTask(splitTask)!, { onStatus: status }, memory, gate);
  const specs = parseSubtasks(splitOut, count);
  if (specs.length === 0) {
    store.failTask(root, "拆分失败：模型没有返回可用的子任务 JSON");
    console.error("拆分失败：模型没有返回可用的子任务 JSON");
    return 1;
  }
  console.log(`拆成 ${specs.length} 个子任务：`);
  for (const spec of specs) console.log(`  ${spec.index}. ${spec.title}`);

  const results: ChildResult[] = await runWithLimit(specs, concurrency, async (spec) => {
    // Children get their own thread: they must not see the parent's conversation history, and
    // their turns must not be distilled into the parent's memory. Sharing a thread made the
    // "independent context" claim false — each child was reading the whole window.
    const childThread = `${thread}#sub${spec.index}`;
    const taskId = store.createChildTask(spec.prompt, cfg.workspace, childThread, root, spec.index);
    const started = Date.now();
    console.log(`\n--- 子任务 ${spec.index}/${specs.length} ${spec.title} (${taskId}) ---`);
    try {
      const output = await runTask(store, cfg, store.getTask(taskId)!, { onStatus: status }, memory, gate);
      console.log(`  完成 ${output.length} 字符，${Math.round((Date.now() - started) / 1000)}s`);
      return { index: spec.index, title: spec.title, status: "ok", output, taskId, ms: Date.now() - started };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.log(`  失败：${message}`);
      return { index: spec.index, title: spec.title, status: "failed", output: "", error: message, taskId, ms: Date.now() - started };
    }
  });

  const ok = results.filter((item) => item.status === "ok").length;
  console.log(`\n子任务完成 ${ok}/${results.length}，开始汇总…\n`);

  const synthTask = store.createChildTask(`${prompt}\n\n${buildDigest(results)}`, cfg.workspace, thread, root, specs.length + 1);
  const final = await runTask(store, cfg, store.getTask(synthTask)!, { onText: (delta) => process.stdout.write(delta), onStatus: status }, memory, gate);
  store.finishTask(root, final);
  console.log(`\n\ntask ${root} done — ${final.length} chars (子任务 ${ok}/${results.length})\n`);
  return 0;
}

async function cmdAsk(args: string[]): Promise<number> {
  const sandboxFlag = args.indexOf("--sandbox");
  if (sandboxFlag !== -1) {
    const mode = normalizeMode(args[sandboxFlag + 1]);
    args.splice(sandboxFlag, 2);
    process.env.PI_RT_SANDBOX = mode;
  }
  const spawnFlag = args.indexOf("--spawn");
  const spawnCount = spawnFlag === -1 ? 0 : Math.max(2, Math.min(6, Number(args[spawnFlag + 1] ?? 0) || 0));
  if (spawnFlag !== -1) args.splice(spawnFlag, 2);
  const cwdFlag = flagValue(args, "--cwd");
  const thread = flagValue(args, "--thread") ?? "default";
  const extract = args.includes("--extract");
  if (extract) args.splice(args.indexOf("--extract"), 1);
  const prompt = args.join(" ").trim();
  if (!prompt) {
    console.error('usage: node src/cli.ts ask "<prompt>" [--cwd <dir>] [--thread <t>] [--extract]');
    return 2;
  }

  const cfg = loadConfig();
  if (cwdFlag) cfg.workspace = cwdFlag;
  const store = new Store(DB_PATH);
  const memory = openMemory();
  if (spawnCount > 0) {
    if (!canSpawn(0, Number(process.env.PI_RT_MAX_DEPTH ?? 1))) {
      console.error("PI_RT_MAX_DEPTH=0 时禁止派生");
      return 2;
    }
    return runSpawned(store, cfg, memory, prompt, thread, spawnCount);
  }
  const id = store.createTask(prompt, cfg.workspace, thread);
  console.log(`task ${id} queued  (thread: ${thread}  workspace: ${cfg.workspace})\n`);

  let printedStatus = false;
  const onStatus = (message: string) => {
    if (!printedStatus) process.stdout.write("\n");
    printedStatus = true;
    dim(message);
  };

  try {
    const result = await runTask(store, cfg, store.getTask(id)!, { onText: (delta) => process.stdout.write(delta), onStatus }, memory);
    console.log(`\n\ntask ${id} done — ${result.length} chars\n`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`\n\ntask ${id} failed\n${message}\n`);
    memory.close();
    store.close();
    return 1;
  }

  try {
    const pending = store.pendingTurnCount(thread);
    if (extract) {
      dim(`强制提炼：${pending} 轮待处理`);
      await runDistill(store, memory, cfg, thread, 20, onStatus);
    } else if (cfg.autoExtract && pending >= cfg.batchTurns) {
      dim(`累积 ${pending} 轮 ≥ 阈值 ${cfg.batchTurns}，后台提炼中…`);
      await runDistill(store, memory, cfg, thread, 20, onStatus);
    } else if (pending > 0) {
      dim(`记忆：${pending}/${cfg.batchTurns} 轮待提炼`);
    }
    return 0;
  } finally {
    memory.close();
    store.close();
  }
}

async function runDistill(
  store: Store,
  memory: MemoryStore,
  cfg: ReturnType<typeof loadConfig>,
  thread: string | undefined,
  limit: number,
  onStatus?: (message: string) => void,
): Promise<DistillResult> {
  // limit counts turns; one turn is a user event plus an assistant event.
  const events = store.pendingEvents(thread, Math.max(2, limit * 2));
  if (events.length === 0) {
    console.log("没有待提炼的对话事件");
    return { events: 0, applied: [], rejected: [], raw: "" };
  }
  const members = new Members(DATA_DIR);
  const ownerNames = members.list().filter((m) => m.is_owner).map((m) => m.display_name);
  members.close();
  const result = await distillBatch(store, memory, cfg, events, { onStatus }, ownerNames);
  printDistill(result);
  return result;
}

function parseTarget(raw: string | undefined): { targetType: "current_speaker" | "named_member" | "current_group" | "self"; targetName: string | null } {
  if (!raw || raw === "speaker" || raw === "current_speaker") return { targetType: "current_speaker", targetName: null };
  if (raw === "self" || raw === "agent") return { targetType: "self", targetName: null };
  if (raw === "group" || raw === "current_group") return { targetType: "current_group", targetName: null };
  if (raw.startsWith("member:")) return { targetType: "named_member", targetName: raw.slice(7) };
  return { targetType: "current_speaker", targetName: null };
}

function cmdRemember(args: string[]): number {
  const category = (flagValue(args, "--category") ?? flagValue(args, "--kind") ?? "fact") as MemoryCategory;
  const key = flagValue(args, "--key");
  const importanceRaw = flagValue(args, "--importance");
  const evidence = flagValue(args, "--evidence");
  const targetRaw = flagValue(args, "--target");
  const eventRaw = flagValue(args, "--event");
  const { targetType, targetName } = parseTarget(targetRaw);
  const content = args.join(" ").trim();

  if (!content || !key) {
    console.error('usage: node src/cli.ts remember "<text>" --key <slot> [--category …] [--importance 1-5] [--target self|group|member:张三] [--evidence "…"] [--event <id>]');
    return 2;
  }

  const memory = openMemory();
  const result = memory.apply({
    action: "create",
    targetType,
    targetName,
    category,
    key,
    content,
    importance: importanceRaw ? Number(importanceRaw) : 3,
    evidenceQuote: evidence ?? null,
    evidenceEventId: eventRaw ? Number(eventRaw) : null,
    reason: "手工写入",
  });
  memory.close();

  if (result.action === "rejected") {
    console.error(`rejected: ${result.reason}`);
    return 1;
  }
  console.log(`${result.action.padEnd(10)} ${result.key}${result.id ? ` (#${result.id})` : ""} — ${result.reason}`);
  return 0;
}

function cmdMemories(args: string[]): number {
  const showAll = args.includes("--all");
  const category = args.filter((arg) => !arg.startsWith("--"))[0] as MemoryCategory | undefined;
  const memory = openMemory();
  const rows = memory.list(category, showAll);
  if (rows.length === 0) {
    console.log('no memories yet — try: node src/cli.ts remember "只喝美式" --key user_drink_preference --category preference');
    memory.close();
    return 0;
  }
  for (const row of rows) {
    const evidence = row.evidence_quote
      ? ` 「${row.evidence_quote.slice(0, 40)}」${row.evidence_event_id ? `#${row.evidence_event_id}` : ""}`
      : "";
    console.log(`#${String(row.id).padEnd(4)} [${row.category.padEnd(10)}|${row.importance}] ${row.status.padEnd(11)} ${row.content}`);
    console.log(`      key=${row.key} target=${row.subject} used=${row.use_count}${evidence}`);
  }
  const stats = memory.stats();
  console.log(`\n活跃 ${stats.active}（偏好 ${stats.byCategory.preference ?? 0} / 事实 ${stats.byCategory.fact ?? 0} / 事件 ${stats.byCategory.event ?? 0}），历史 ${stats.superseded + stats.invalidated} 条`);
  memory.close();
  return 0;
}

function cmdHistory(args: string[]): number {
  const key = args[0];
  if (!key) {
    console.error("usage: node src/cli.ts history <key>");
    return 2;
  }
  const memory = openMemory();
  const rows = memory.history(key);
  if (rows.length === 0) {
    console.log(`no history for key: ${key}`);
    memory.close();
    return 1;
  }
  for (const row of rows) {
    console.log(`#${row.id} ${row.status.padEnd(11)} [${row.category}|${row.importance}] ${row.content}`);
    console.log(`    ${row.created_at} → ${row.updated_at}`);
    if (row.evidence_quote) console.log(`    证据：「${row.evidence_quote}」`);
    if (row.note) console.log(`    备注：${row.note}`);
  }
  memory.close();
  return 0;
}

function cmdResolve(args: string[]): number {
  const key = args[0];
  const keepId = Number(args[1]);
  if (!key || !Number.isInteger(keepId)) {
    console.error("usage: node src/cli.ts resolve <key> <keep-id>");
    return 2;
  }
  const memory = openMemory();
  const ok = memory.resolve(key, keepId);
  memory.close();
  console.log(ok ? `resolved ${key}: kept #${keepId}, others superseded` : `no contested rows to resolve for ${key} (or #${keepId} not among them)`);
  return ok ? 0 : 1;
}

function cmdTrace(args: string[]): number {
  const id = args[0];
  if (!id) {
    console.error("usage: node src/cli.ts trace <task-id>");
    return 2;
  }
  const store = new Store(DB_PATH);
  try {
    const rows = store.spansOf(id);
    if (rows.length === 0) {
      console.error(`该任务没有 span 记录（trace 是后加的，旧任务没有）`);
      return 1;
    }
    for (const line of formatSpanTree(buildSpanTree(rows), { totalChars: 0 })) console.log(line);
    return 0;
  } finally {
    store.close();
  }
}

function cmdTools(args: string[]): number {
  const days = Number(flagValue(args, "--days") ?? 30);
  const asJson = args.includes("--json");
  const cfg = loadConfig();
  const store = new Store(DB_PATH);
  try {
    const since = new Date(Date.now() - days * 86_400_000).toISOString();
    const stats = summarizeToolCalls(store.toolCallRows(since));
    const servers = listMcpServers(DATA_DIR);

    if (asJson) {
      console.log(JSON.stringify({ days, sandbox: cfg.sandbox, servers, stats }, null, 2));
      return 0;
    }
    for (const line of formatToolReport(stats, servers)) console.log(line);
    console.log(`沙箱     ${cfg.sandbox} · ${describePolicy(cfg.sandbox)}`);
    console.log(`统计范围 最近 ${days} 天`);
    return 0;
  } finally {
    store.close();
  }
}

function cmdTree(args: string[]): number {
  const id = args[0];
  if (!id) {
    console.error("usage: node src/cli.ts tree <task-id>");
    return 2;
  }
  const store = new Store(DB_PATH);
  try {
    const root = store.getTask(id);
    if (!root) {
      console.error(`task not found: ${id}`);
      return 1;
    }
    const ms = (task: { created_at: string; updated_at: string }) =>
      Math.max(0, new Date(task.updated_at).getTime() - new Date(task.created_at).getTime());
    const line = (task: any, prefix: string) => {
      const chars = task.result ? `${task.result.length} 字符` : "-";
      console.log(`${prefix}${task.id}  ${String(task.status).padEnd(7)} ${chars.padEnd(11)} ${Math.round(ms(task) / 1000)}s  ${String(task.prompt).slice(0, 46)}`);
    };
    line(root, "");
    for (const child of store.childrenOf(root.id)) line(child, "  └─ ");
    const kids = store.childrenOf(root.id);
    if (kids.length > 0) {
      const ok = kids.filter((k) => k.status === "done").length;
      console.log(`\n子任务 ${ok}/${kids.length} 成功，总耗时 ${Math.round(ms(root) / 1000)}s`);
    }
    return 0;
  } finally {
    store.close();
  }
}

function cmdMemoryGit(args: string[]): number {
  const message = flagValue(args, "--message");
  const memory = openMemory();
  try {
    const result = exportMemoryToGit(memory, DATA_DIR, { message });
    console.log(`仓库      ${result.dir}`);
    console.log(`文件      ${result.files} 个`);
    if (result.error) {
      console.error(`提交失败：${result.error}`);
      return 1;
    }
    console.log(result.changed ? `已提交    ${result.commit}` : "无变化    未产生提交");
    console.log("查看      git -C " + result.dir + " log --oneline");
    return 0;
  } finally {
    memory.close();
  }
}

function cmdSandbox(args: string[]): number {
  const cfg = loadConfig();
  const mode = normalizeMode(flagValue(args, "--mode") ?? cfg.sandbox);
  const report = sandboxReport(mode, cfg.workspace);
  console.log(`mode        ${report.mode}`);
  console.log(`policy      ${report.description}`);
  console.log(`excluded    ${report.excluded.length ? report.excluded.join(", ") : "(none)"}`);
  console.log(`workspace   ${report.workspace}`);
  console.log(`workspace   ${report.workspaceOk ? "ok" : `拒绝：${report.workspaceReason}`}`);
  console.log(`env         ${Object.keys(piEnv(cfg)).length} 个变量（白名单，不含任何密钥）`);
  return report.workspaceOk ? 0 : 1;
}

function cmdArchive(args: string[]): number {
  const days = Number(flagValue(args, "--days") ?? loadConfig().archiveDays ?? 30);
  const dryRun = args.includes("--dry-run");
  const includeUndistilled = args.includes("--include-undistilled");
  const list = args.includes("--list");
  const store = new Store(DB_PATH);

  try {
    if (list) {
      const summary = inspectArchives(DATA_DIR);
      const age = newestBackupAgeHours(DATA_DIR);
      console.log(`archive   ${summary.archive.files} 个文件 / ${(summary.archive.bytes / 1024).toFixed(1)} KB`);
      console.log(`backups   ${summary.backups.files} 个文件 / ${(summary.backups.bytes / 1024).toFixed(1)} KB`);
      console.log(`最新备份  ${age === null ? "无" : `${age.toFixed(1)} 小时前`}`);
      return 0;
    }

    const result = archiveConversationEvents(store, DATA_DIR, { olderThanDays: days, dryRun, includeUndistilled });
    console.log(`${dryRun ? "可归档" : "已归档"}  ${result.events} 条事件（${days} 天前，已提炼）`);
    if (result.skippedEvidence > 0) console.log(`保留      ${result.skippedEvidence} 条：被记忆引用为证据`);
    if (result.skippedUndistilled > 0) console.log(`保留      ${result.skippedUndistilled} 条：尚未提炼`);
    if (result.file) console.log(`文件      ${result.file}（${(result.bytes / 1024).toFixed(1)} KB）`);
    if (dryRun) console.log("（预览模式，未做修改）");
    return 0;
  } finally {
    store.close();
  }
}

function cmdBackup(args: string[]): number {
  const keep = Number(flagValue(args, "--keep") ?? loadConfig().backupKeep ?? 7);
  const store = new Store(DB_PATH);
  try {
    const result = backupDatabase(store, DATA_DIR, keep);
    console.log(`备份完成  ${result.file}（${(result.bytes / 1024).toFixed(1)} KB）`);
    if (result.pruned.length > 0) console.log(`清理旧备份 ${result.pruned.length} 个（保留 ${keep}）`);
    return 0;
  } finally {
    store.close();
  }
}

function cmdCompact(args: string[]): number {
  const vacuum = args.includes("--vacuum");
  const dryRun = args.includes("--dry-run");
  const store = new Store(DB_PATH);
  try {
    const maxPayload = Number(flagValue(args, "--payload-max") ?? 2000);
    const before = store.eventStats();
    const deleted = store.deleteEventsOfTypes(NOISE_TYPES, dryRun);
    const shrunk = dryRun ? { rows: 0, freedBytes: 0 } : store.truncateEventPayloads(maxPayload);
    const after = store.eventStats();

    console.log(`events    ${before.rows} 行 / ${(before.bytes / 1024).toFixed(1)} KB`);
    console.log(`${dryRun ? "将删除" : "已删除"}  ${deleted} 行（${NOISE_TYPES.join(", ")}）`);
    console.log(`${dryRun ? "将截断" : "已截断"}  ${shrunk.rows} 条超长 payload，省下 ${(shrunk.freedBytes / 1024).toFixed(1)} KB`);
    console.log(`现在      ${after.rows} 行 / ${(after.bytes / 1024).toFixed(1)} KB`);

    if (dryRun) {
      console.log("（预览模式，未做修改）");
      return 0;
    }
    if (vacuum) {
      console.log(`VACUUM 完成，数据库 ${(store.vacuum() / 1024 / 1024).toFixed(2)} MB`);
    } else {
      console.log("提示：加 --vacuum 回收磁盘空间");
    }
    return 0;
  } finally {
    store.close();
  }
}

function cmdCalibrate(args: string[]): number {
  const backfill = args.includes("--backfill");
  const reset = args.includes("--reset");
  const store = new CalibrationStore(DATA_DIR);
  try {
    if (reset) {
      console.log(`cleared ${store.reset()} sample(s)`);
      return 0;
    }
    if (backfill) {
      console.log(`backfilled ${store.backfill()} sample(s) from history`);
    }

    const samples = store.samples();
    const fit = store.fit();
    console.log(`samples      ${samples.length}  (fit needs ${MIN_SAMPLES})`);
    if (samples.length > 0) {
      const ratios = samples.slice(0, 5).map((s) => (s.chars > 0 ? (s.tokens / s.chars).toFixed(2) : "-"));
      console.log(`last ratios  ${ratios.join(", ")}  (tokens/char, raw — inflated by pi overhead)`);
    }
    if (fit) {
      console.log(`slope        ${fit.slope.toFixed(4)} tokens/char`);
      console.log(`intercept    ${fit.intercept.toFixed(0)} tokens  (pi system prompt + tool schemas)`);
      console.log(`r2           ${fit.r2.toFixed(3)}${fit.r2 < 0.5 ? "  ← 拟合质量差，谨慎使用" : ""}`);
      console.log(`estimate     ${charsPerTokenFrom(fit)} chars/token  ← 用于 compose`);
    } else {
      console.log(`estimate     ${DEFAULT_CHARS_PER_TOKEN} chars/token  (default: 样本不足或斜率不可辨识)`);
    }
    return 0;
  } finally {
    store.close();
  }
}

function cmdState(args: string[]): number {
  const sub = args.shift();
  const ttlRaw = flagValue(args, "--ttl");
  const scope = flagValue(args, "--scope") ?? "global";
  const store = new ShortStateStore(DATA_DIR);

  try {
    switch (sub) {
      case "set": {
        const key = args[0];
        const value = args.slice(1).join(" ").trim();
        if (!key || !value) {
          console.error('usage: node src/cli.ts state set <key> <value> [--ttl 12h] [--scope <thread>]');
          return 2;
        }
        const row = store.set(key, value, { scope, ttlMs: ttlRaw ? parseTtl(ttlRaw) : undefined });
        const hours = Math.round((Date.parse(row.expires_at) - Date.now()) / 3_600_000);
        console.log(`set  ${row.key} = ${row.value}`);
        console.log(`     scope=${row.scope}  约 ${hours} 小时后过期（${row.expires_at}）`);
        return 0;
      }
      case "list":
      case "ls": {
        const rows = store.list(scope, 100);
        if (rows.length === 0) {
          console.log("(no active short state)");
          return 0;
        }
        for (const row of rows) {
          const hours = Math.max(0, Math.round((Date.parse(row.expires_at) - Date.now()) / 3_600_000));
          const hint = row.use_count >= 3 ? "  ← 可晋升为长期记忆（state promote）" : "";
          console.log(`${row.key.padEnd(20)} = ${row.value.slice(0, 60).padEnd(40)} [${row.scope}]  ${hours}h left  used=${row.use_count}${hint}`);
        }
        return 0;
      }
      case "prune": {
        const pruned = store.prune();
        console.log(`marked ${pruned} row(s) stale`);
        return 0;
      }
      case "promote": {
        const key = args[0];
        if (!key) {
          console.error("usage: node src/cli.ts state promote <key> [--category fact|preference|event] [--as <memory-key>] [--scope <thread>]");
          return 2;
        }
        const category = (flagValue(args, "--category") ?? "fact") as MemoryCategory;
        const memoryKey = flagValue(args, "--as");
        const memory = openMemory();
        try {
          const result = promoteShortState(store, memory, key, { scope, category, memoryKey });
          console.log(result.ok ? `${result.reason} → ${result.memoryKey}` : `failed: ${result.reason}`);
          return result.ok ? 0 : 1;
        } finally {
          memory.close();
        }
      }
      case "del":
      case "rm": {
        const key = args[0];
        if (!key) {
          console.error("usage: node src/cli.ts state del <key> [--scope <thread>]");
          return 2;
        }
        console.log(store.remove(key, scope) ? `deleted ${key}` : `not found: ${key}`);
        return 0;
      }
      default:
        console.error("usage: node src/cli.ts state <set|list|prune|del> ...");
        return 2;
    }
  } finally {
    store.close();
  }
}

function cmdThread(args: string[]): number {
  const thread = args[0];
  if (!thread) {
    console.error("usage: node src/cli.ts thread <thread>");
    return 2;
  }
  const store = new Store(DB_PATH);
  const state = store.threadState(thread);
  const events = store.conversationEvents(thread, 500);
  console.log(`thread      ${thread}`);
  console.log(`events      ${events.length}`);
  console.log(`cursor      #${state.summarizedUntil}`);
  console.log(`summary     ${state.summary ? `${state.summary.length} 字符` : "(none)"}`);
  if (state.summary) {
    console.log("\n--- 摘要 ---");
    console.log(state.summary);
  }
  store.close();
  return 0;
}

function cmdEvents(args: string[]): number {
  const thread = args[0];
  if (!thread) {
    console.error("usage: node src/cli.ts events <thread>");
    return 2;
  }
  const store = new Store(DB_PATH);
  const events = store.conversationEvents(thread, 100);
  if (events.length === 0) {
    console.log(`no events for thread: ${thread}`);
    store.close();
    return 1;
  }
  for (const event of events) {
    const mark = event.distilled_at ? "✓" : "·";
    console.log(`${mark} [#${String(event.id).padEnd(5)} | ${event.speaker.padEnd(8)}] ${event.text.replace(/\s+/g, " ").slice(0, 90)}`);
  }
  console.log(`\n${events.length} events (✓ = 已提炼)`);
  store.close();
  return 0;
}

function cmdForget(args: string[]): number {
  const id = Number(args[0]);
  if (!Number.isInteger(id)) {
    console.error("usage: node src/cli.ts forget <id>");
    return 2;
  }
  const memory = openMemory();
  const removed = memory.forget(id);
  memory.close();
  console.log(removed ? `memory #${id} deleted` : `memory #${id} not found`);
  return removed ? 0 : 1;
}

async function cmdDistill(args: string[]): Promise<number> {
  const thread = flagValue(args, "--thread");
  const limitRaw = flagValue(args, "--limit");
  const limit = Math.max(1, Number(limitRaw ?? 20) || 20);

  const cfg = loadConfig();
  const store = new Store(DB_PATH);
  const memory = openMemory();
  try {
    await runDistill(store, memory, cfg, thread, limit, dim);
    return 0;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  } finally {
    memory.close();
    store.close();
  }
}

async function cmdEvalContext(args: string[]): Promise<number> {
  const only = flagValue(args, "--only");
  const casesPath = flagValue(args, "--cases");
  return runContextEval({ only, casesPath });
}

async function cmdEval(args: string[]): Promise<number> {
  const keep = args.includes("--keep");
  const only = flagValue(args, "--only");
  const casesPath = flagValue(args, "--cases");
  const repeat = Math.max(1, Number(flagValue(args, "--repeat") ?? 1));

  if (repeat === 1) return runEval({ keep, only, casesPath });

  // Repeated runs exist to make variance visible. A single pass reports a number; three passes
  // tell you whether that number is stable enough to quote.
  const runs: Array<Record<string, number>> = [];
  for (let index = 1; index <= repeat; index++) {
    console.log(`\n=== run ${index}/${repeat} ===`);
    const code = await runEval({ keep, only, casesPath });
    if (code !== 0) return code;
    const report = JSON.parse(readFileSync(path.join(DATA_DIR, "..", "eval", "latest.json"), "utf8")) as {
      metrics: Record<string, number>;
    };
    runs.push(report.metrics);
  }

  const keys = ["passRate", "precision", "recall", "f1", "leaks", "evidenceRejectionRate"] as const;
  console.log(`\n=== ${repeat} 次运行的稳定性 ===`);
  console.log("metric".padEnd(22) + "mean".padEnd(10) + "min".padEnd(10) + "max".padEnd(10) + "range");
  for (const key of keys) {
    const values = runs.map((metrics) => Number(metrics[key] ?? 0));
    const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
    const min = Math.min(...values);
    const max = Math.max(...values);
    const format = (value: number) => (key === "leaks" ? value.toFixed(0) : `${(value * 100).toFixed(1)}%`);
    console.log(
      key.padEnd(22) + format(mean).padEnd(10) + format(min).padEnd(10) + format(max).padEnd(10) + format(max - min),
    );
  }
  console.log(`\n逐次通过率：${runs.map((metrics) => `${(Number(metrics.passRate) * 100).toFixed(1)}%`).join("  ")}`);
  return 0;
}

function cmdMembers(): number {
  const members = new Members(DATA_DIR);
  members.ensureOwner(loadConfig().ownerName);
  const rows = members.list();
  if (rows.length === 0) {
    console.log("no identities yet — feed a message first");
  }
  for (const row of rows) {
    console.log(`#${String(row.id).padEnd(3)} ${row.channel.padEnd(9)} ${row.external_id.padEnd(16)} ${row.display_name}${row.is_owner ? "  (owner)" : ""}`);
  }
  members.close();
  return 0;
}

async function cmdFeed(args: string[]): Promise<number> {
  const chatId = flagValue(args, "--chat") ?? "local";
  const channel = flagValue(args, "--channel") ?? "local";
  const name = flagValue(args, "--as");
  const externalId = flagValue(args, "--id");
  const isDm = args.includes("--dm");
  if (isDm) args.splice(args.indexOf("--dm"), 1);
  const wantRun = args.includes("--run");
  if (wantRun) args.splice(args.indexOf("--run"), 1);
  const text = args.join(" ").trim();

  if (!text || !name) {
    console.error('usage: node src/cli.ts feed "<text>" --as <name> [--chat <id>] [--id <uid>] [--dm] [--run]');
    return 2;
  }

  const cfg = loadConfig();
  const store = new Store(DB_PATH);
  const members = new Members(DATA_DIR);
  members.ensureOwner(cfg.ownerName);
  const deps = { store, members, dataDir: DATA_DIR, ownerName: cfg.ownerName, ownerIds: cfg.ownerIds };

  const result = ingest(deps, {
    channel,
    chatId,
    chatType: isDm ? "dm" : "group",
    externalId: externalId ?? `${channel}:${name}`,
    displayName: name,
    text,
  });
  console.log(`event #${result.eventId} [${result.speaker}${result.isOwner ? " · owner" : ""}] → ${result.thread}`);

  if (wantRun) {
    const memory = openMemory();
    try {
      const taskId = store.createTask(text, cfg.workspace, result.thread);
      const reply = await runTask(store, cfg, store.getTask(taskId)!, { onStatus: dim, recordUserEvent: false }, memory);
      console.log(`\n[agent → ${result.speaker}]\n${reply}`);
    } catch (error) {
      console.error(`reply failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      memory.close();
    }
  }

  members.close();
  store.close();
  return 0;
}

async function cmdServe(args: string[]): Promise<number> {
  const channel = flagValue(args, "--channel") ?? "telegram";
  const portFlag = flagValue(args, "--port");
  if (channel !== "telegram" && channel !== "feishu" && channel !== "feishu-webhook" && channel !== "qq") {
    console.error(`channel "${channel}" is not implemented (available: telegram, feishu, feishu-webhook, qq)`);
    return 2;
  }

  const cfg = loadConfig();
  const store = new Store(DB_PATH);
  const members = new Members(DATA_DIR);
  members.ensureOwner(cfg.ownerName);
  const memory = openMemory();
  const deps = { store, members, dataDir: DATA_DIR, ownerName: cfg.ownerName, ownerIds: cfg.ownerIds };

  // Threads with a reply in flight. The maintenance loop must not distil a thread whose turn
  // is still being written, or the extractor sees half a conversation.
  const busy = new Set<string>();

  // Some groups are yours alone; there the mention requirement is friction, not a filter.
  const noMentionGroups = new Set(
    (process.env.QQ_GROUP_NO_MENTION ?? "")
      .split(",")
      .map((id) => id.trim())
      .filter(Boolean)
      .map((id) => (id.startsWith("group:") ? id : `group:${id}`)),
  );
  // Wake words are channel-agnostic on purpose: the user's habit is "say the name", and which
  // transport the message arrived on is an implementation detail from their point of view.
  const wakeWords = [process.env.QQ_WAKE_WORDS, process.env.FEISHU_WAKE_WORDS]
    .flatMap((value) => (value ?? "").split(","))
    .map((word) => word.trim())
    .filter(Boolean);
  // Approvals are parked per thread: the agent asks, the user answers, the task resumes.
  const approvals = new ApprovalStore(DATA_DIR);

  // Fan-out control API. The agent reaches it through the `fanout` MCP tool; the runtime stays the
  // only owner of the task queue. Children run on their own threads (`#subN`) so their context and
  // memory do not leak into the parent — the same isolation the CLI --spawn path uses.
  const fanoutGate = new Gate(3, 0);
  const control = await startControlServer({
    notes: new NoteStore(DATA_DIR),
    defaultThread: "fanout",
    log: (message) => dim(message),
    runChild: async ({ prompt, thread, index }) => {
      const childThread = `${thread}#sub${index}`;
      const childTask = store.createTask(prompt, cfg.workspace, childThread);
      return runTask(store, cfg, store.getTask(childTask)!, { onStatus: dim }, memory, fanoutGate);
    },
  });
  dim(`fan-out API listening on 127.0.0.1:${control.port}`);

  // One handler for every transport: identity → event → run → reply → maybe distil.
  const handler = async (message: Incoming, send: (chatId: string, text: string) => Promise<void>) => {
    // A reply of "同意"/"拒绝" belongs to a parked approval, not to a new task. Checked before
    // ingest so the decision never pollutes the conversation as a user turn.
    const pendingApproval = approvals.pendingFor(`${message.channel}:${message.chatId}`);
    const decision = pendingApproval ? parseDecision(message.text) : null;
    if (pendingApproval && decision) {
      approvals.decide(pendingApproval.id, decision, { approvedBy: message.externalId });
      if (decision === "denied") {
        await send(message.chatId, "好，取消。");
        return;
      }
      // Re-run the original request now that it has consent. The task is re-created rather than
      // resumed because pi sessions are one-shot; what carries over is the request, not a half
      // finished tool loop.
      await send(message.chatId, "收到，继续。");
      const retryId = store.createTask(pendingApproval.request, cfg.workspace, `${message.channel}:${message.chatId}`);
      try {
        const reply = await runTask(store, cfg, store.getTask(retryId)!, { onStatus: dim, recordUserEvent: false }, memory);
        await send(message.chatId, reply);
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        await send(message.chatId, `执行失败：${reason.slice(0, 300)}`).catch(() => {});
      }
      return;
    }
    // In a group, every message reaches us. Answering all of them is noisy and expensive, so we
    // stay quiet unless the bot was mentioned (DMs are always addressed).

    if (!shouldAnswer(message, { noMentionGroups, wakeWords })) {
      dim(`群消息未 @ 我，跳过：${message.text.slice(0, 20)}｜at=[${(message.mentions ?? []).join(",")}]`);
      return;
    }
    const result = ingest(deps, message);
    if (result.duplicate) {
      dim(`duplicate message ${message.messageId} ignored`);
      return;
    }
    dim(`event #${result.eventId} ${result.speaker} @ ${result.thread}`);
    busy.add(result.thread);
    try {
      const taskId = store.createTask(message.text, cfg.workspace, result.thread);
      const reply = await runTask(
        store,
        cfg,
        store.getTask(taskId)!,
        { onStatus: dim, recordUserEvent: false },
        memory,
      );
      // An `<!--ask: ...-->` token parks the task: the question is what the user sees, and the
      // original request is stored so a "同意" can resume it without copy-paste.
      const asks = extractAskDirectives(reply);
      if (asks.asks.length > 0) {
        const approval = approvals.request({
          thread: result.thread,
          taskId,
          action: asks.asks[0].action,
          request: message.text,
        });
        dim(`approval #${approval.id} parked: ${approval.action}`);
        await send(message.chatId, asks.cleaned || approval.prompt);
        if (asks.cleaned) await send(message.chatId, approval.prompt);
        return;
      }
      await send(message.chatId, reply);
      const pending = store.pendingTurnCount(result.thread);
      if (pending >= cfg.batchTurns) {
        dim(`累积 ${pending} 轮，提炼记忆…`);
        await runDistill(store, memory, cfg, result.thread, 20, dim);
      }
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      console.error(`failed to handle message: ${reason}`);
      await send(message.chatId, `执行失败：${reason.slice(0, 300)}`).catch(() => {});
    } finally {
      busy.delete(result.thread);
    }
  };

  // Background maintenance: the batch trigger above only fires at N turns, so a two-message
  // conversation would never be extracted. This tick closes that gap.
  const maintenanceMinutes = Number(process.env.PI_RT_MAINTENANCE_MINUTES ?? 5);
  const maintenanceEnabled = !args.includes("--no-maintenance") && maintenanceMinutes > 0;
  const maintenanceTimer = maintenanceEnabled
    ? setInterval(() => {
        // One summary line per tick: per-thread logging buries the transcript once a few
        // idle threads exist.
        void runMaintenance({
          idleThreads: () => store.idleEventThreads(cfg.idleMinutes),
          distill: async (thread) => {
            await runDistill(store, memory, cfg, thread, 20, dim);
          },
          prune: () => {
            const state = new ShortStateStore(DATA_DIR);
            try {
              return state.prune();
            } finally {
              state.close();
            }
          },
          busy,
        })
          .then((report) => {
            const parts: string[] = [];
            if (report.distilled.length > 0) parts.push(`提炼 ${report.distilled.length} 个闲置线程`);
            if (report.failed.length > 0) parts.push(`${report.failed.length} 个失败`);
            if (report.pruned > 0) parts.push(`清理 ${report.pruned} 条过期短状态`);

            // Daily snapshot: "yesterday" must always be recoverable without a manual command.
            const age = newestBackupAgeHours(DATA_DIR);
            if (age === null || age >= 24) {
              try {
                const backup = backupDatabase(store, DATA_DIR, cfg.backupKeep);
                parts.push(`备份 ${(backup.bytes / 1024).toFixed(0)} KB`);
              } catch (error) {
                parts.push(`备份失败 ${error instanceof Error ? error.message : String(error)}`);
              }
            }

            if (parts.length > 0) dim(`[maintenance] ${parts.join("，")}`);
          })
          .catch((error) => dim(`[maintenance] ${error instanceof Error ? error.message : String(error)}`));
      }, maintenanceMinutes * 60_000)
    : null;
  if (maintenanceEnabled) {
    dim(`维护循环已启用：每 ${maintenanceMinutes} 分钟提炼闲置线程（闲置阈值 ${cfg.idleMinutes} 分钟）`);
  }

  const controller = new AbortController();
  process.on("SIGINT", () => controller.abort());

  try {
    if (channel === "qq") {
      // OneBot v11: a local protocol bridge (NapCat / Lagrange) owns the QQ login; this runtime
      // only speaks its WebSocket in and HTTP out.
      const client = new OneBotClient({
        wsUrl: process.env.QQ_WS_URL ?? "ws://127.0.0.1:3001",
        httpUrl: process.env.QQ_HTTP_URL ?? "http://127.0.0.1:3001",
        accessToken: process.env.QQ_ACCESS_TOKEN,
        wsToken: process.env.QQ_WS_TOKEN,
        httpToken: process.env.QQ_HTTP_TOKEN,
        botUin: process.env.QQ_BOT_UIN,
        allowedUsers: process.env.QQ_ALLOW_USERS?.split(",").map((id) => id.trim()).filter(Boolean),
        allowedGroups: process.env.QQ_ALLOW_GROUPS?.split(",").map((id) => id.trim()).filter(Boolean),
      });
      console.log(`qq (onebot) -> ${process.env.QQ_WS_URL ?? "ws://127.0.0.1:3001"} - ctrl+c to stop`);
      // Reminders are the one thing the runtime pushes without being spoken to, so the loop
      // owns its own timer and reuses the same send path as a normal reply.
      const reminderStore = new ReminderStore(DATA_DIR);
      const stopReminders = setInterval(() => {
        void (async () => {
          for (const reminder of reminderStore.due()) {
            try {
              await client.send(sendTargetFromChatId(reminder.chatId), `⏰ ${reminder.text}`);
              reminderStore.markFired(reminder.id);
            } catch (error) {
              console.error(`reminder ${reminder.id} 发送失败：${(error as Error).message}`);
            }
          }
        })();
      }, 30_000);
      reminderStore.pending().length > 0 &&
        console.log(`待触发提醒 ${reminderStore.pending().length} 条`);
      controller.signal.addEventListener("abort", () => clearInterval(stopReminders));
      await client.run(
        (message) =>
          handler(oneBotToIncoming(message) as Incoming, async (_chatId, text) => {
            const incoming = oneBotToIncoming(message);
            const thread = `${incoming.channel}:${incoming.chatId}`;
            const { reminders: directives, cleaned } = extractReminderDirectives(text);
            for (const directive of directives) {
              const dueAt = parseWhen(directive.when);
              if (!dueAt || dueAt.getTime() <= Date.now()) continue;
              if (reminderStore.findDuplicate(thread, directive.text, dueAt)) continue;
              reminderStore.add({ thread, channel: incoming.channel, chatId: incoming.chatId, text: directive.text, dueAt });
            }
            // Length is a product decision, not a model preference: SOUL.md says "短句" and the
            // model still wrote 200-character answers. The cap is mechanical, and it steps aside
            // when the user actually asked for detail.
            const brevity = enforceBrevity(cleaned, incoming.chatType === "group" ? "group" : "dm", incoming.text);
            if (brevity.trimmed) dim(`[简短化 ${cleaned.length} → ${brevity.text.length} 字：${brevity.reason ?? ""}]`);
            await client.send(sendTargetFromChatId(message.chatId), brevity.text);
          }),
        controller.signal,
      );
      return 0;
    }

    if (channel === "telegram") {
      const token = process.env.TELEGRAM_BOT_TOKEN;
      if (!token) {
        console.error("set TELEGRAM_BOT_TOKEN first (get one from @BotFather)");
        return 1;
      }
      const telegram = new TelegramChannel({
        token,
        allowedChats: process.env.TELEGRAM_CHAT_ALLOW?.split(",").map((id) => id.trim()).filter(Boolean),
      });
      console.log("telegram polling — ctrl+c to stop");
      await telegram.serve((message) => handler(message, (chatId, text) => telegram.send(chatId, text)), controller.signal);
      return 0;
    }

    // Feishu family: the same handler, two transports. Sending replies always needs the
    // app credentials; receiving does too in WS mode, but webhook mode can run without them.
    const appId = cfg.feishu.appId;
    const appSecret = cfg.feishu.appSecret;
    const encryptKey = cfg.feishu.encryptKey;
    const verificationToken = cfg.feishu.verificationToken;
    const allowedChats = process.env.FEISHU_CHAT_ALLOW?.split(",").map((id) => id.trim()).filter(Boolean);
    const sender =
      appId && appSecret
        ? new FeishuChannel({ appId, appSecret, encryptKey, verificationToken, allowedChats })
        : null;

    if (channel === "feishu-webhook") {
      const port = Number(portFlag ?? process.env.FEISHU_WEBHOOK_PORT ?? 8787);
      const server = await startFeishuWebhook({
        port,
        encryptKey,
        verificationToken,
        allowedChats,
        resolveName: sender ? (openId) => sender.nameFor(openId) : undefined,
        onMessage: (message) =>
          handler(message, async (_chatId, text) => {
            if (sender) await sender.send(message.chatId, text);
            else console.log(`[reply suppressed — no app credentials]\n${text}`);
          }),
      });
      console.log(`feishu webhook listening on http://127.0.0.1:${server.port}/feishu/event`);
      console.log(sender ? "replies: enabled" : "replies: disabled (set FEISHU_APP_ID / FEISHU_APP_SECRET)");
      await new Promise<void>((resolve) => controller.signal.addEventListener("abort", () => resolve()));
      await server.close();
      return 0;
    }

    if (!appId || !appSecret) {
      console.error("set FEISHU_APP_ID / FEISHU_APP_SECRET first (open.feishu.cn → 开发者后台 → 应用凭证)");
      return 1;
    }
    console.log("feishu long connection starting — ctrl+c to stop");
    await sender!.serve((message) => handler(message, (chatId, text) => sender!.send(chatId, text)));
    await new Promise<void>((resolve) => controller.signal.addEventListener("abort", () => resolve()));
    sender!.close();
    return 0;
  } finally {
    if (maintenanceTimer) clearInterval(maintenanceTimer);
    memory.close();
    members.close();
    store.close();
  }
}

function cmdStats(): number {
  const store = new Store(DB_PATH);
  const memory = openMemory();
  const tasks = store.listTasks(1_000);
  const byStatus = new Map<string, number>();
  for (const task of tasks) byStatus.set(task.status, (byStatus.get(task.status) ?? 0) + 1);
  console.log("tasks");
  for (const [status, count] of byStatus) console.log(`  ${status.padEnd(9)} ${count}`);
  console.log(`  pending distil  ${store.pendingCount()}`);
  const stats = memory.stats();
  console.log("memory");
  console.log(`  active      ${stats.active} (preference ${stats.byCategory.preference ?? 0} / fact ${stats.byCategory.fact ?? 0} / event ${stats.byCategory.event ?? 0})`);
  console.log(`  superseded  ${stats.superseded}`);
  console.log(`  invalidated ${stats.invalidated}`);
  const today = store.usageToday();
  console.log("usage（今日）");
  console.log(`  tokens      ${today.total}`);
  console.log(`  cost        $${today.cost.toFixed(4)}`);
  console.log(`  runs        ${today.runs}`);
  console.log(`  budget      ${loadConfig().limits.dailyTokens} tokens/day`);
  memory.close();
  store.close();
  return 0;
}

function cmdList(args: string[]): number {
  const limit = Number(args[0] ?? 20) || 20;
  const store = new Store(DB_PATH);
  const rows = store.listTasks(limit);
  if (rows.length === 0) {
    console.log("no tasks yet");
    store.close();
    return 0;
  }
  for (const row of rows) {
    const preview = row.prompt.replace(/\s+/g, " ").slice(0, 52);
    console.log(`${row.status.padEnd(8)} ${row.id}  ${row.created_at.slice(11, 19)}  [${row.thread}]  ${preview}`);
  }
  store.close();
  return 0;
}

function cmdShow(args: string[]): number {
  const id = args[0];
  if (!id) {
    console.error("usage: node src/cli.ts show <task-id>");
    return 2;
  }
  const store = new Store(DB_PATH);
  const task = store.getTask(id);
  if (!task) {
    console.error(`task not found: ${id}`);
    store.close();
    return 1;
  }
  console.log(`id          ${task.id}`);
  console.log(`status      ${task.status}`);
  console.log(`thread      ${task.thread}`);
  console.log(`workspace   ${task.cwd}`);
  console.log(`distilled   ${task.distilled_at ?? "no"}`);
  console.log(`prompt      ${task.prompt}`);
  if (task.error) console.log(`error       ${task.error}`);
  if (task.result) console.log(`\nresult\n------\n${task.result}`);

  const events = store.eventsOf(task.id);
  console.log(`\nevents      ${events.length}`);
  for (const event of events.slice(-10)) console.log(`  #${event.seq} ${event.type}`);
  store.close();
  return 0;
}

async function cmdWorker(args: string[]): Promise<number> {
  const once = args.includes("--once");
  const cfg = loadConfig();
  const store = new Store(DB_PATH);
  const memory = openMemory();
  const reaped = store.reapStale();
  if (reaped) console.log(`requeued ${reaped} stale task(s)`);
  console.log(`worker up — db=${DB_PATH} workspace=${cfg.workspace} batch=${cfg.batchTurns} idle=${cfg.idleMinutes}m`);

  let stopping = false;
  process.on("SIGINT", () => {
    stopping = true;
    console.log("\nstopping after current task…");
  });

  while (!stopping) {
    const task = store.claimNext();
    if (!task) {
      if (once) break;
      // Idle path: threads that went quiet long enough get their memory extracted.
      for (const idle of store.idleEventThreads(cfg.idleMinutes)) {
        console.log(`\n--- distil idle thread ${idle.thread} (${idle.pending} events) ---`);
        try {
          await runDistill(store, memory, cfg, idle.thread, 20, dim);
        } catch (error) {
          console.error(`distil failed: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
      await sleep(1_000);
      continue;
    }
    console.log(`\n--- ${task.id} running ---`);
    try {
      await runTask(
        store,
        cfg,
        task,
        { onText: (delta) => process.stdout.write(delta), onStatus: (message) => dim(message) },
        memory,
      );
      console.log(`\n--- ${task.id} done ---`);
    } catch (error) {
      console.error(`--- ${task.id} failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  memory.close();
  store.close();
  return 0;
}

async function main(): Promise<number> {
  ensureDirs();
  const [command, ...rest] = process.argv.slice(2);
  switch (command) {
    case "doctor":
    case "check":
      return cmdDoctor();
    case "login":
    case "auth":
      return cmdLogin();
    case "ask":
    case "run":
      return cmdAsk(rest);
    case "list":
    case "ls":
      return cmdList(rest);
    case "show":
      return cmdShow(rest);
    case "worker":
    case "daemon":
      return cmdWorker(rest);
    case "remember":
    case "mem":
      return cmdRemember(rest);
    case "memories":
    case "memory":
      return cmdMemories(rest);
    case "history":
      return cmdHistory(rest);
    case "events":
      return cmdEvents(rest);
    case "thread":
      return cmdThread(rest);
    case "state":
      return cmdState(rest);
    case "persona": {
      const sub = rest[0] ?? "show";
      if (sub === "init") {
        const written = ensureStanding(DATA_DIR);
        console.log(written.length > 0 ? written.map((file) => `已生成：${file}`).join("\n") : "两个人格文件都已存在");
        return 0;
      }
      if (sub === "usage") {
        const usage = standingUsage(DATA_DIR);
        for (const entry of usage) console.log(`${entry.path}  ${entry.chars}/${entry.limit} 字符（${entry.percent}%）`);
        return usage.length > 0 ? 0 : 1;
      }
      if (sub === "edit") {
        console.log(`人格：${soulPath(DATA_DIR)}`);
        console.log(`纪律：${contractsPath(DATA_DIR)}`);
        return 0;
      }
      const soul = readSoul(DATA_DIR);
      const contracts = readContracts(DATA_DIR);
      if (!soul && !contracts) {
        console.log(`还没有人格文件。运行 \`node src/cli.ts persona init\` 生成默认人格（${DEFAULT_SOUL_LIMIT} 字符）与执行纪律（${DEFAULT_CONTRACTS_LIMIT} 字符）`);
        return 1;
      }
      const usage = standingUsage(DATA_DIR);
      console.log(`# ${usage.map((u) => `${u.role} ${u.chars}/${u.limit}（${u.percent}%）`).join(" · ")}\n`);
      if (soul) console.log(soul);
      if (contracts) console.log(`\n---\n\n${contracts}`);
      return 0;
    }
    case "memory-embed": {
      // Backfill vectors for rows written before retrieval existed. Idempotent: only rows with
      // a NULL embedding are touched, so it is safe to run on every deploy.
      const store = new MemoryStore(DATA_DIR, loadConfig().ownerName);
      const pending = store.needingEmbedding(200);
      if (pending.length === 0) {
        const stats = store.embeddingStats();
        console.log(`无需回填：${stats.embedded}/${stats.total} 条已有向量（模型 ${stats.models.join(",") || "无"}）`);
        return 0;
      }
      let done = 0;
      let model = "";
      for (const item of pending) {
        const embedded = await embedText(item.text);
        store.setEmbedding(item.id, embedded.vector, embedded.model);
        model = embedded.model;
        done += 1;
      }
      const stats = store.embeddingStats();
      console.log(`已回填 ${done} 条向量（模型 ${model}），当前 ${stats.embedded}/${stats.total}`);
      return 0;
    }
    case "memory-search": {
      const store = new MemoryStore(DATA_DIR, loadConfig().ownerName);
      const query = rest.join(" ").trim();
      if (!query) {
        console.log("用法：memory-search <查询>");
        return 1;
      }
      const embedded = await embedText(query);
      const hits = store.similaritySearch(embedded.vector, { limit: 5, model: embedded.model });
      if (hits.length === 0) {
        console.log(`没有命中（模型 ${embedded.model}）`);
        return 0;
      }
      for (const { row, score } of hits) {
        console.log(`${score.toFixed(3)}  ${row.content}`);
        if (row.evidenceQuote) console.log(`        证据 #${row.evidenceEventId}：「${row.evidenceQuote}」`);
      }
      return 0;
    }
    case "approvals": {
      const store = new ApprovalStore(DATA_DIR);
      store.expire();
      const rows = store.listPending();
      if (rows.length === 0) {
        console.log("没有待确认的请求");
        return 0;
      }
      for (const row of rows) {
        const left = Math.max(0, Math.round((new Date(row.expiresAt).getTime() - Date.now()) / 1000));
        console.log(`#${row.id}  ${row.action}  （${left}s 后过期，线程 ${row.thread}）`);
      }
      return 0;
    }
    case "approve":
    case "deny": {
      const store = new ApprovalStore(DATA_DIR);
      const id = Number(rest[0]);
      if (!Number.isInteger(id)) {
        console.log(`用法：${command} <id>（先用 approvals 查 id）`);
        return 1;
      }
      const decided = store.decide(id, command === "approve" ? "approved" : "denied");
      console.log(decided ? `#${id} ${decided.status}` : `#${id} 不存在或已决定`);
      return decided ? 0 : 1;
    }
    case "remind": {
      const store = new ReminderStore(DATA_DIR);
      const sub = rest[0] ?? "list";
      if (sub === "cancel") {
        const id = Number(rest[1]);
        const ok = Number.isInteger(id) && store.cancel(id);
        console.log(ok ? `已取消 #${id}` : `没有可取消的 #${rest[1]}`);
        return ok ? 0 : 1;
      }
      const rows = store.pending();
      if (rows.length === 0) {
        console.log("没有待触发的提醒");
        return 0;
      }
      for (const row of rows) {
        const local = new Date(new Date(row.dueAt).getTime() + 8 * 3_600_000).toISOString().slice(0, 16).replace("T", " ");
        console.log(`#${row.id}  ${local}  [${row.channel}] ${row.text}`);
      }
      return 0;
    }
    case "calibrate":
      return cmdCalibrate(rest);
    case "compact":
      return cmdCompact(rest);
    case "archive":
      return cmdArchive(rest);
    case "sandbox":
      return cmdSandbox(rest);
    case "memory-git":
      return cmdMemoryGit(rest);
    case "tree":
      return cmdTree(rest);
    case "tools":
      return cmdTools(rest);
    case "trace":
      return cmdTrace(rest);
    case "backup":
      return cmdBackup(rest);
    case "resolve":
      return cmdResolve(rest);
    case "forget":
      return cmdForget(rest);
    case "distill":
      return cmdDistill(rest);
    case "stats":
      return cmdStats();
    case "eval":
    case "bench":
      return cmdEval(rest);
    case "eval-context":
    case "bench-ctx":
      return cmdEvalContext(rest);
    case "feed":
      return cmdFeed(rest);
    case "members":
      return cmdMembers();
    case "serve":
      return cmdServe(rest);
    case undefined:
    case "-h":
    case "--help":
    case "help":
      console.log(USAGE);
      return 0;
    default:
      console.error(`unknown command: ${command}\n`);
      console.log(USAGE);
      return 2;
  }
}

main()
  .then((code) => process.exit(code))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
