import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import path from "node:path";
import type { ApprovalStore } from "../approval.ts";
import { extractAskDirectives, parseDecision } from "../approval.ts";
import { extractAttachments } from "../attachments.ts";
import type { RuntimeConfig } from "../config.ts";
import type { Store } from "../db.ts";
import { isComplaint, type FeedbackStore } from "../feedback.ts";
import { ingest, type GatewayDeps } from "../gateway.ts";
import type { KnowledgeStore } from "../knowledge.ts";
import type { MemoryStore } from "../memory.ts";
import { readContracts, readSoul, contractsUsage, personaUsage } from "../persona.ts";
import type { ProposalStore } from "../proposal.ts";
import { violations, resolvePreferences } from "../preference.ts";
import { extractReminderDirectives, parseWhen, type ReminderStore } from "../reminders.ts";
import { discoverSkills } from "../skills.ts";
import { listMcpServers } from "../tools-report.ts";
import { RunAbortedError, type RunActivity, type RunHooks, runTask } from "../worker.ts";

/**
 * Browser channel.
 *
 * The runtime already speaks CLI and IM. A browser needs HTTP plus a stream, which none of
 * those transports offer, so this file is a thin adapter: one localhost server, the same
 * `ingest → runTask → record` path the other channels use, and Server-Sent Events for the
 * deltas `runTask` already produces. It does not own a second queue or a second memory.
 *
 * Bound to loopback unless `PI_RT_WEB_TOKEN` is set. There is no account system — the person
 * at the machine is the owner, same assumption as the control API.
 */

export const WEB_CHANNEL = "web";
export const CHAT_ID = /^[A-Za-z0-9_-]{1,80}$/;

const MAX_MESSAGE_CHARS = 16_000;
const MAX_BODY = 64 * 1024;
const FILE_EXT = [".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".pdf", ".txt", ".md", ".csv", ".json", ".zip", ".log", ".html", ".svg", ".yaml", ".yml"];
const INLINE_EXT = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp"]);
const MAX_FILE_BYTES = Number(process.env.PI_RT_SEND_MAX_BYTES ?? 4 * 1024 * 1024);

const STATIC_MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".ico": "image/x-icon",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
};

export type WebEvent =
  | { type: "status"; message: string }
  | { type: "text"; delta: string }
  | { type: "thinking"; delta: string }
  | { type: "tool"; phase: "start" | "end"; name: string; callId?: string; isError?: boolean; preview?: string; argsPreview?: string }
  | { type: "notice"; text: string }
  | { type: "attachment"; name: string; path: string; bytes: number }
  | { type: "done"; text: string; taskId: string; stopped?: boolean }
  | { type: "error"; message: string };

export type WebTool = {
  callId: string;
  name: string;
  isError: boolean;
  preview: string;
  argsPreview?: string;
};

export type WebMessage = {
  id: number;
  role: "user" | "assistant";
  speaker: string;
  text: string;
  createdAt: string;
  taskId: string | null;
  tools: WebTool[];
  steps: string[];
  attachments: Array<{ name: string; path: string; bytes: number }>;
};

export type WebSessionSummary = {
  id: string;
  title: string;
  updatedAt: string;
  events: number;
};

export type WebSessionDetail = WebSessionSummary & {
  messages: WebMessage[];
  pendingApproval: { id: number; action: string; prompt: string; expiresAt: string } | null;
  pendingProposal: { id: number; path: string; rationale: string } | null;
};

export type WebInfo = {
  ok: true;
  name: "Tree-Agent";
  channel: "web";
  ownerName: string;
  provider: string | null;
  model: string | null;
  workspace: string;
  sandbox: string;
  memoryEnabled: boolean;
  usageToday: { total: number; cost: number; runs: number };
};

export function webThread(chatId: string): string {
  return `${WEB_CHANNEL}:${chatId}`;
}

export function chatIdFromThread(thread: string): string | null {
  if (!thread.startsWith(`${WEB_CHANNEL}:`)) return null;
  const id = thread.slice(WEB_CHANNEL.length + 1);
  return CHAT_ID.test(id) ? id : null;
}

export function sessionTitle(text: string | null | undefined): string {
  const line = String(text ?? "").split("\n").map((part) => part.trim()).find(Boolean) ?? "";
  if (!line) return "新对话";
  return [...line].slice(0, 32).join("") + ([...line].length > 32 ? "…" : "");
}

/** Hide control tokens from the transcript. The runtime still stores the raw reply. */
export function presentAssistantText(text: string): string {
  const reminders = extractReminderDirectives(text);
  const asks = extractAskDirectives(reminders.cleaned);
  return asks.cleaned;
}

export function listWebSessions(store: Store): WebSessionSummary[] {
  const sessions: WebSessionSummary[] = [];
  for (const row of store.listThreads(`${WEB_CHANNEL}:`)) {
    const id = chatIdFromThread(row.thread);
    if (!id) continue;
    sessions.push({
      id,
      title: sessionTitle(store.firstUserText(row.thread)),
      updatedAt: row.lastAt,
      events: row.events,
    });
  }
  return sessions;
}

export function readWebSession(
  store: Store,
  chatId: string,
  pending?: {
    approval?: { id: number; action: string; prompt: string; expiresAt: string } | null;
    proposal?: { id: number; path: string; rationale: string } | null;
  },
  workspace = process.cwd(),
): WebSessionDetail {
  const thread = webThread(chatId);
  const events = store.conversationEvents(thread, 400);
  const messages: WebMessage[] = events.map((event) => {
    const taskId = event.task_id;
    const trace = taskId && event.role === "assistant" ? traceForTask(store, taskId) : { tools: [], steps: [] };
    const text = event.role === "assistant" ? presentAssistantText(event.text) : event.text;
    return {
      id: event.id,
      role: event.role,
      speaker: event.speaker,
      text,
      createdAt: event.created_at,
      taskId,
      tools: trace.tools,
      steps: trace.steps,
      attachments: event.role === "assistant" ? attachmentViews(text, workspace) : [],
    };
  });
  const last = events.at(-1);
  return {
    id: chatId,
    title: sessionTitle(events.find((event) => event.role === "user")?.text),
    updatedAt: last?.created_at ?? new Date(0).toISOString(),
    events: events.length,
    messages,
    pendingApproval: pending?.approval ?? null,
    pendingProposal: pending?.proposal ?? null,
  };
}

function attachmentViews(text: string, workspace: string): Array<{ name: string; path: string; bytes: number }> {
  return extractAttachments(text, { workspace, max: 4 }).map((file) => ({
    name: path.basename(file.path),
    path: path.relative(workspace, file.path).split(path.sep).join("/"),
    bytes: file.bytes,
  }));
}

function traceForTask(store: Store, taskId: string): { tools: WebTool[]; steps: string[] } {
  const tools: WebTool[] = [];
  const byId = new Map<string, WebTool>();
  const steps: string[] = [];
  for (const event of store.eventsOf(taskId)) {
    const payload = parsePayload(event.payload);
    if (event.type === "tool_execution_start" || event.type === "tool_execution_end") {
      const callId = String(payload.toolCallId ?? payload.toolName ?? tools.length);
      let tool = byId.get(callId);
      if (!tool) {
        tool = { callId, name: String(payload.toolName ?? "tool"), isError: false, preview: "" };
        byId.set(callId, tool);
        tools.push(tool);
      }
      if (typeof payload.toolName === "string") tool.name = payload.toolName;
      if (event.type === "tool_execution_end") {
        tool.isError = payload.isError === true;
        tool.preview = previewOf(payload.output ?? payload.preview);
      }
      continue;
    }
    const label = stepLabel(event.type, payload);
    if (label) steps.push(label);
  }
  return { tools, steps };
}

function parsePayload(raw: string): Record<string, unknown> {
  try {
    const value = JSON.parse(raw) as unknown;
    if (!value || typeof value !== "object") return {};
    const record = value as Record<string, unknown>;
    if (record.truncated === true && typeof record.preview === "string") {
      try {
        const inner = JSON.parse(record.preview) as unknown;
        if (inner && typeof inner === "object") return inner as Record<string, unknown>;
      } catch {
        return { preview: record.preview };
      }
    }
    return record;
  } catch {
    return {};
  }
}

function previewOf(value: unknown, max = 500): string {
  if (value == null) return "";
  const text = typeof value === "string" ? value : safeJson(value);
  const trimmed = text.trim();
  if (!trimmed) return "";
  return trimmed.length > max ? `${trimmed.slice(0, max)}…` : trimmed;
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function stepLabel(type: string, payload: Record<string, unknown>): string | null {
  switch (type) {
    case "memory_injected":
      return `记忆注入 ${Array.isArray(payload.ids) ? payload.ids.length : 0} 条`;
    case "context_injected":
      return `携带 ${Number(payload.messages ?? 0)} 条历史`;
    case "short_state_injected":
      return `短期状态 ${Array.isArray(payload.keys) ? payload.keys.length : 0} 条`;
    case "loop_warn":
      return `循环告警：${String(payload.reason ?? "")}`;
    case "loop_abort":
      return `循环中止：${String(payload.reason ?? "")}`;
    case "preference_violation":
      return "回答用到了已作废的偏好";
    case "state_directive":
      return `记下短期状态 ${String(payload.key ?? "")}`;
    case "task_retry":
      return `重试：${String(payload.error ?? "")}`;
    case "context_summarized":
      return "已压缩更早的对话";
    case "context_conflict":
      return "上下文有冲突，以最近对话为准";
    default:
      return null;
  }
}

export type WorkspaceFile =
  | { ok: true; abs: string; relative: string; bytes: number; ext: string }
  | { ok: false; status: number; error: string };

function isInside(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

/**
 * A file the browser may download.
 *
 * The lexical path is not enough: a symlink inside the workspace can point at config or the
 * data directory. Resolve the real path, then refuse anything outside the workspace, anything
 * under a blocked root (the runtime data dir), and `config.json` by name.
 */
export function resolveWorkspaceFile(workspace: string, rawPath: string, blockedRoots: string[] = []): WorkspaceFile {
  const trimmed = String(rawPath ?? "").trim();
  if (!trimmed) return { ok: false, status: 400, error: "path 必填" };
  const root = path.resolve(workspace);
  const resolved = path.resolve(root, trimmed);
  const relative = path.relative(root, resolved);
  if (!isInside(root, resolved)) {
    return { ok: false, status: 403, error: "只能读取工作区内的文件" };
  }
  const ext = path.extname(resolved).toLowerCase();
  if (!FILE_EXT.includes(ext)) return { ok: false, status: 400, error: `不支持的文件类型 ${ext || "(无扩展名)"}` };
  if (path.basename(resolved).toLowerCase() === "config.json") {
    return { ok: false, status: 403, error: "不能读取配置文件" };
  }
  let realRoot: string;
  let realFile: string;
  try {
    realRoot = realpathSync(root);
    realFile = realpathSync(resolved);
  } catch {
    return { ok: false, status: 404, error: "文件不存在" };
  }
  if (!isInside(realRoot, realFile)) {
    return { ok: false, status: 403, error: "只能读取工作区内的文件" };
  }
  if (path.basename(realFile).toLowerCase() === "config.json") {
    return { ok: false, status: 403, error: "不能读取配置文件" };
  }
  for (const blocked of blockedRoots) {
    let realBlocked: string;
    try {
      realBlocked = realpathSync(path.resolve(blocked));
    } catch {
      continue;
    }
    if (isInside(realBlocked, realFile)) {
      return { ok: false, status: 403, error: "不能读取运行时数据目录" };
    }
  }
  let size = 0;
  try {
    const stat = statSync(realFile);
    if (!stat.isFile()) return { ok: false, status: 404, error: "不是文件" };
    size = stat.size;
  } catch {
    return { ok: false, status: 404, error: "文件不存在" };
  }
  if (size > MAX_FILE_BYTES) return { ok: false, status: 413, error: "文件过大" };
  return { ok: true, abs: realFile, relative: relative.split(path.sep).join("/"), bytes: size, ext };
}

export type WebTurnDeps = {
  cfg: RuntimeConfig;
  store: Store;
  memory: MemoryStore;
  gateway: GatewayDeps;
  approvals: ApprovalStore;
  proposals: ProposalStore;
  reminders: ReminderStore;
  feedback: FeedbackStore;
  control: {
    setSession: (
      thread: string,
      sendText: (text: string) => Promise<void>,
      sendFile?: (filePath: string, caption?: string) => Promise<void>,
    ) => void;
  };
  busy: Set<string>;
  log?: (message: string) => void;
  run?: typeof runTask;
  distill?: (thread: string) => Promise<void>;
};

/**
 * One web turn. Mirrors the shared IM handler: proposals and approvals are decided before
 * ingest, the user event is recorded by `ingest`, and `runTask` streams the reply.
 */
export async function runWebTurn(
  deps: WebTurnDeps,
  input: { chatId: string; text: string; messageId?: string; emit: (event: WebEvent) => void; signal: AbortSignal },
): Promise<void> {
  const { emit, signal } = input;
  const text = input.text.trim();
  const thread = webThread(input.chatId);
  const log = deps.log ?? (() => {});
  const execute = deps.run ?? runTask;

  if (signal.aborted) {
    emit({ type: "done", text: "", taskId: "", stopped: true });
    return;
  }

  const pendingProposal = deps.proposals.pendingFor(thread);
  const proposalDecision = pendingProposal ? parseDecision(text) : null;
  if (pendingProposal && proposalDecision) {
    const result = proposalDecision === "approved" ? deps.proposals.apply(pendingProposal.id) : deps.proposals.reject(pendingProposal.id);
    const isMcp = pendingProposal.path.startsWith("mcp:");
    const label = isMcp ? `MCP server「${pendingProposal.path.slice(4)}」` : pendingProposal.path;
    emit({
      type: "done",
      taskId: "",
      text:
        result?.status === "applied"
          ? `好，已应用：${label}。${isMcp ? "下一条消息起这个工具可用。" : "下一轮对话起生效。"}`
          : `好，没动：${label}。`,
    });
    return;
  }

  const pendingApproval = deps.approvals.pendingFor(thread);
  const decision = pendingApproval ? parseDecision(text) : null;
  if (pendingApproval && decision) {
    deps.approvals.decide(pendingApproval.id, decision, { approvedBy: "web" });
    if (decision === "denied") {
      emit({ type: "done", text: "好，取消。", taskId: "" });
      return;
    }
    emit({ type: "status", message: "收到，继续。" });
    const retryId = deps.store.createTask(pendingApproval.request, deps.cfg.workspace, thread);
    try {
      const reply = await execute(deps.store, deps.cfg, deps.store.getTask(retryId)!, hooksFor(emit, signal), deps.memory);
      emit({ type: "done", text: presentAssistantText(reply), taskId: retryId, stopped: signal.aborted });
    } catch (error) {
      emitStoppedOrError(emit, signal, error);
    }
    return;
  }

  const result = ingest(deps.gateway, {
    channel: WEB_CHANNEL,
    chatId: input.chatId,
    chatType: "dm",
    externalId: "owner",
    displayName: deps.cfg.ownerName,
    text,
    messageId: input.messageId,
    addressed: true,
  });
  if (result.duplicate) {
    emit({ type: "error", message: "这条消息已经处理过了" });
    return;
  }

  deps.control.setSession(
    result.thread,
    async (note) => {
      emit({ type: "notice", text: note });
    },
    async (filePath, caption) => {
      const relative = path.relative(deps.cfg.workspace, filePath).split(path.sep).join("/");
      emit({ type: "attachment", name: path.basename(filePath), path: relative, bytes: statSync(filePath).size });
      if (caption?.trim()) emit({ type: "notice", text: caption.trim() });
    },
  );

  if (isComplaint(text)) {
    const captured = deps.feedback.captureFromThread(result.thread, text);
    if (captured) log(`badcase #${captured.id} 已记录（草稿，待审）`);
  }

  deps.busy.add(result.thread);
  let taskId = "";
  try {
    taskId = deps.store.createTask(text, deps.cfg.workspace, result.thread);
    const reply = await execute(
      deps.store,
      deps.cfg,
      deps.store.getTask(taskId)!,
      hooksFor(emit, signal, false),
      deps.memory,
    );
    const reminders = extractReminderDirectives(reply);
    for (const directive of reminders.reminders) {
      const dueAt = parseWhen(directive.when);
      if (!dueAt || dueAt.getTime() <= Date.now()) continue;
      if (deps.reminders.findDuplicate(result.thread, directive.text, dueAt)) continue;
      deps.reminders.add({
        thread: result.thread,
        channel: WEB_CHANNEL,
        chatId: input.chatId,
        text: directive.text,
        dueAt,
      });
      log(`提醒已登记：${directive.text} @ ${dueAt.toISOString()}`);
    }
    const asks = extractAskDirectives(reminders.cleaned);
    if (asks.asks.length > 0) {
      const approval = deps.approvals.request({
        thread: result.thread,
        taskId,
        action: asks.asks[0].action,
        request: text,
      });
      log(`approval #${approval.id} parked: ${approval.action}`);
      const visible = [asks.cleaned, approval.prompt].filter(Boolean).join("\n\n");
      emit({ type: "done", text: visible, taskId, stopped: signal.aborted });
      return;
    }

    try {
      const prefs = deps.memory.list(undefined, true).filter((row) => row.category === "preference");
      const resolved = resolvePreferences(prefs);
      if (resolved.outdated.length > 0) {
        const hits = violations(reminders.cleaned, resolved);
        if (hits.length > 0) {
          deps.store.appendEvent(taskId, "preference_violation", { hits });
          log(`偏好违规：用了 ${hits.map((hit) => hit.staleValue).join(",")}`);
        }
      }
    } catch (error) {
      log(`偏好检查失败（不影响回复）：${error instanceof Error ? error.message : String(error)}`);
    }

    for (const file of attachmentViews(reminders.cleaned, deps.cfg.workspace)) {
      emit({ type: "attachment", name: file.name, path: file.path, bytes: file.bytes });
    }

    const pending = deps.store.pendingTurnCount(result.thread);
    if (!signal.aborted && pending >= deps.cfg.batchTurns && deps.distill) {
      log(`累积 ${pending} 轮，提炼记忆…`);
      await deps.distill(result.thread);
    }
    emit({ type: "done", text: reminders.cleaned, taskId, stopped: signal.aborted });
  } catch (error) {
    emitStoppedOrError(emit, signal, error, taskId);
  } finally {
    deps.busy.delete(result.thread);
  }
}

function hooksFor(emit: (event: WebEvent) => void, signal: AbortSignal, recordUserEvent = false): RunHooks {
  return {
    recordUserEvent,
    signal,
    onText: (delta) => emit({ type: "text", delta }),
    onStatus: (message) => emit({ type: "status", message }),
    onActivity: (activity: RunActivity) => {
      if (activity.kind === "thinking") emit({ type: "thinking", delta: activity.delta });
      else emit({ type: "tool", phase: activity.phase, name: activity.name, callId: activity.callId, isError: activity.isError, preview: activity.preview, argsPreview: activity.argsPreview });
    },
  };
}

function emitStoppedOrError(emit: (event: WebEvent) => void, signal: AbortSignal, error: unknown, taskId = ""): void {
  if (signal.aborted || error instanceof RunAbortedError || (error instanceof Error && error.message === "aborted")) {
    emit({ type: "done", text: "", taskId, stopped: true });
    return;
  }
  const message = error instanceof Error ? error.message : String(error);
  emit({ type: "error", message: message.split("\n")[0].slice(0, 300) });
}

export type WebServerOptions = {
  port?: number;
  host?: string;
  /** When omitted, a random token is generated and returned on the server handle. */
  token?: string;
  /** Real directories the file route must not read, even if they sit inside the workspace. */
  blockedRoots?: string[];
  staticDir?: string;
  workspace: string;
  info: () => WebInfo;
  sessions: () => WebSessionSummary[];
  session: (chatId: string) => WebSessionDetail;
  inspect: (section: string, params: URLSearchParams) => unknown;
  turn: (input: { chatId: string; text: string; messageId?: string; emit: (event: WebEvent) => void; signal: AbortSignal }) => Promise<void>;
};

export type WebServer = { port: number; host: string; token: string; close: () => Promise<void> };

const DEV_ORIGIN_PORTS = [5173];

export function startWebServer(options: WebServerOptions): Promise<WebServer> {
  const host = options.host ?? "127.0.0.1";
  const token = options.token?.trim() || randomBytes(24).toString("base64url");
  const blockedRoots = options.blockedRoots ?? [];
  const inflight = new Map<string, AbortController>();
  let boundPort = options.port && options.port > 0 ? options.port : 0;

  const server = createServer((request, response) => {
    void handle(request, response).catch((error) => {
      if (response.headersSent || response.writableEnded) {
        response.end();
        return;
      }
      json(response, request, 500, { error: error instanceof Error ? error.message : String(error) });
    });
  });
  server.requestTimeout = 0;
  server.timeout = 0;

  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (!loopbackHost(request)) {
      response.writeHead(403, { "content-type": "text/plain; charset=utf-8" }).end("forbidden host");
      return;
    }
    const origin = originOf(request);
    if (origin && !originAllowed(origin, boundPort)) {
      response.writeHead(403, { "content-type": "text/plain; charset=utf-8" }).end("forbidden origin");
      return;
    }
    if (request.method === "OPTIONS" && url.pathname.startsWith("/api/")) {
      writeCors(response, origin);
      response.writeHead(204).end();
      return;
    }
    if (url.pathname.startsWith("/api/") && !authorized(request, token, url)) {
      json(response, request, 401, { error: "需要访问令牌" }, origin);
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/health") {
      json(response, request, 200, options.info(), origin);
      return;
    }
    if (request.method === "GET" && url.pathname === "/api/sessions") {
      json(response, request, 200, { sessions: options.sessions() }, origin);
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/sessions") {
      json(response, request, 201, { id: newChatId() }, origin);
      return;
    }

    const sessionMatch = /^\/api\/sessions\/([^/]+)$/.exec(url.pathname);
    if (request.method === "GET" && sessionMatch) {
      const chatId = decodeURIComponent(sessionMatch[1]);
      if (!CHAT_ID.test(chatId)) {
        json(response, request, 400, { error: "会话 id 不合法" }, origin);
        return;
      }
      json(response, request, 200, options.session(chatId), origin);
      return;
    }

    const messageMatch = /^\/api\/sessions\/([^/]+)\/messages$/.exec(url.pathname);
    if (request.method === "POST" && messageMatch) {
      const chatId = decodeURIComponent(messageMatch[1]);
      if (!CHAT_ID.test(chatId)) {
        json(response, request, 400, { error: "会话 id 不合法" }, origin);
        return;
      }
      if (inflight.has(chatId)) {
        json(response, request, 409, { error: "这条会话正在回复" }, origin);
        return;
      }
      const body = await readJson(request);
      const text = String(body.text ?? "");
      if (!text.trim()) {
        json(response, request, 400, { error: "消息为空" }, origin);
        return;
      }
      if ([...text].length > MAX_MESSAGE_CHARS) {
        json(response, request, 413, { error: `消息过长（上限 ${MAX_MESSAGE_CHARS} 字符）` }, origin);
        return;
      }
      const messageId = typeof body.messageId === "string" ? body.messageId : undefined;
      if (messageId && !CHAT_ID.test(messageId)) {
        json(response, request, 400, { error: "messageId 不合法" }, origin);
        return;
      }
      const controller = new AbortController();
      inflight.set(chatId, controller);
      writeCors(response, origin);
      response.writeHead(200, {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache, no-transform",
        connection: "keep-alive",
        "x-accel-buffering": "no",
      });
      const emit = (event: WebEvent) => {
        if (response.writableEnded || response.destroyed) return;
        response.write(`data: ${JSON.stringify(event)}\n\n`);
      };
      const heartbeat = setInterval(() => {
        if (!response.writableEnded && !response.destroyed) response.write(`: ping\n\n`);
      }, 15_000);
      try {
        await options.turn({ chatId, text, messageId, emit, signal: controller.signal });
      } catch (error) {
        emit({ type: "error", message: error instanceof Error ? error.message : String(error) });
      } finally {
        clearInterval(heartbeat);
        inflight.delete(chatId);
        if (!response.writableEnded) response.end();
      }
      return;
    }

    const stopMatch = /^\/api\/sessions\/([^/]+)\/stop$/.exec(url.pathname);
    if (request.method === "POST" && stopMatch) {
      const chatId = decodeURIComponent(stopMatch[1]);
      const current = inflight.get(chatId);
      if (!current) {
        json(response, request, 404, { error: "没有进行中的回复" }, origin);
        return;
      }
      current.abort();
      json(response, request, 200, { ok: true }, origin);
      return;
    }

    const inspectMatch = /^\/api\/(memory|skills|mcp|knowledge|persona|reminders|state|config)$/.exec(url.pathname);
    if (request.method === "GET" && inspectMatch) {
      json(response, request, 200, options.inspect(inspectMatch[1], url.searchParams), origin);
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/files") {
      const resolved = resolveWorkspaceFile(options.workspace, url.searchParams.get("path") ?? "", blockedRoots);
      if (!resolved.ok) {
        json(response, request, resolved.status, { error: resolved.error }, origin);
        return;
      }
      const body = readFileSync(resolved.abs);
      const inline = INLINE_EXT.has(resolved.ext);
      writeCors(response, origin);
      response.writeHead(200, {
        "content-type": mimeFor(resolved.ext),
        "content-length": body.length,
        "x-content-type-options": "nosniff",
        "content-disposition": `${inline ? "inline" : "attachment"}; filename="${encodeURIComponent(path.basename(resolved.abs))}"`,
        "cache-control": "private, max-age=60",
      });
      response.end(body);
      return;
    }

    if (request.method === "GET" && options.staticDir && !url.pathname.startsWith("/api/")) {
      if (serveStatic(options.staticDir, url.pathname, response, token)) return;
    }

    if (request.method === "GET" && url.pathname === "/" && !options.staticDir) {
      const html = `<!doctype html><meta charset="utf-8"><title>Tree-Agent</title><body style="font:16px/1.5 sans-serif;padding:48px">
<p>Web 通道已在 <code>${host}:${options.port ?? ""}</code> 监听。</p>
<p>开发界面：在 <code>web/</code> 里运行 <code>npm run dev</code>，打开 <code>http://127.0.0.1:5173</code>。</p>
<p>或先 <code>npm run build</code>，再由本进程托管 <code>web/dist</code>。</p></body>`;
      writeCors(response, origin);
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(html);
      return;
    }

    json(response, request, 404, { error: "not found" }, origin);
  }

  return new Promise((resolve, reject) => {
    server.on("error", reject);
    server.listen(options.port ?? 0, host, () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : Number(options.port ?? 0);
      boundPort = port;
      resolve({
        port,
        host,
        token,
        close: () =>
          new Promise<void>((done) => {
            for (const controller of inflight.values()) controller.abort();
            server.close(() => done());
          }),
      });
    });
  });
}

function newChatId(): string {
  return `c_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function authorized(request: IncomingMessage, token: string, url: URL): boolean {
  if (!token) return false;
  const header = request.headers.authorization ?? "";
  const prefix = "Bearer ";
  if (header.startsWith(prefix) && safeEqual(header.slice(prefix.length), token)) return true;
  // File links are ordinary navigations, so they cannot set an Authorization header.
  const query = url.searchParams.get("access_token") ?? "";
  return Boolean(query) && safeEqual(query, token);
}

function originOf(request: IncomingMessage): string | undefined {
  const origin = request.headers.origin;
  return typeof origin === "string" && origin ? origin : undefined;
}

/** DNS rebinding sends a public Host that happens to resolve here. Only loopback names are served. */
function loopbackHost(request: IncomingMessage): boolean {
  const raw = request.headers.host;
  if (!raw) return false;
  let hostname = raw;
  if (hostname.startsWith("[")) {
    const end = hostname.indexOf("]");
    hostname = end === -1 ? hostname : hostname.slice(1, end);
  } else {
    hostname = hostname.replace(/:\d+$/, "");
  }
  return hostname === "127.0.0.1" || hostname === "localhost" || hostname === "::1";
}

function originAllowed(origin: string, port: number): boolean {
  const allowed = new Set<string>();
  for (const name of ["127.0.0.1", "localhost"]) {
    if (port > 0) allowed.add(`http://${name}:${port}`);
    for (const dev of DEV_ORIGIN_PORTS) allowed.add(`http://${name}:${dev}`);
  }
  return allowed.has(origin);
}

function writeCors(response: ServerResponse, origin: string | undefined): void {
  if (!origin) return;
  response.setHeader("access-control-allow-origin", origin);
  response.setHeader("vary", "origin");
  response.setHeader("access-control-allow-headers", "content-type, authorization");
  response.setHeader("access-control-allow-methods", "GET, POST, OPTIONS");
}

function safeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

function json(response: ServerResponse, _request: IncomingMessage, status: number, body: unknown, origin?: string): void {
  writeCors(response, origin);
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  response.end(JSON.stringify(body));
}

async function readJson(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY) throw new Error("请求体过大");
    chunks.push(chunk as Buffer);
  }
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
}

function mimeFor(ext: string): string {
  if (ext === ".svg") return "image/svg+xml";
  if (ext === ".pdf") return "application/pdf";
  if (ext === ".json") return "application/json; charset=utf-8";
  if (ext === ".txt" || ext === ".md" || ext === ".csv" || ext === ".log" || ext === ".yaml" || ext === ".yml") {
    return "text/plain; charset=utf-8";
  }
  if (ext === ".html") return "text/html; charset=utf-8";
  if (ext === ".png") return "image/png";
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  if (ext === ".gif") return "image/gif";
  if (ext === ".webp") return "image/webp";
  if (ext === ".bmp") return "image/bmp";
  return "application/octet-stream";
}

function injectToken(html: string, token: string): string {
  const tag = `<script>window.__PI_RT_TOKEN__=${JSON.stringify(token)};</script>`;
  return html.includes("</head>") ? html.replace("</head>", `${tag}</head>`) : tag + html;
}

function serveStatic(rootDir: string, pathname: string, response: ServerResponse, token: string): boolean {
  const root = path.resolve(rootDir);
  if (!existsSync(root)) return false;
  const requested = pathname === "/" ? "/index.html" : pathname;
  const target = path.resolve(root, `.${requested}`);
  const relative = path.relative(root, target);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    response.writeHead(403).end("forbidden");
    return true;
  }
  const send = (file: string, ext: string) => {
    let body: Buffer | string = readFileSync(file);
    if (path.basename(file) === "index.html") body = injectToken(body.toString("utf8"), token);
    response.writeHead(200, {
      "content-type": STATIC_MIME[ext] ?? "application/octet-stream",
      "content-length": Buffer.byteLength(body),
      "cache-control": ext === ".html" ? "no-cache" : "public, max-age=3600",
    });
    response.end(body);
  };
  if (existsSync(target) && statSync(target).isFile()) {
    send(target, path.extname(target).toLowerCase());
    return true;
  }
  if (path.extname(requested)) {
    response.writeHead(404).end("not found");
    return true;
  }
  const index = path.join(root, "index.html");
  if (!existsSync(index)) return false;
  send(index, ".html");
  return true;
}

export type InspectInput = {
  cfg: RuntimeConfig;
  store: Store;
  memory: MemoryStore;
  reminders: ReminderStore;
  knowledge: KnowledgeStore;
  shortState: { list: (scope?: string) => unknown[] };
};

/** Read-only views of state the runtime already keeps. No writes, no invented fields. */
export function inspectRuntime(input: InspectInput, section: string, params: URLSearchParams): unknown {
  switch (section) {
    case "memory": {
      const includeInactive = params.get("all") === "1";
      const category = params.get("category");
      const allowed = category === "preference" || category === "fact" || category === "event" ? category : undefined;
      const items = input.memory.list(allowed, includeInactive).map((row) => ({
        id: row.id,
        category: row.category,
        key: row.key,
        content: row.content,
        status: row.status,
        importance: row.importance,
        subject: row.subject,
        targetType: row.target_type,
        targetName: row.target_name,
        evidenceQuote: row.evidence_quote,
        evidenceEventId: row.evidence_event_id,
        thread: row.thread,
        updatedAt: row.updated_at,
        useCount: row.use_count,
      }));
      return { items, stats: input.memory.stats() };
    }
    case "skills": {
      const skills = discoverSkills({ home: input.cfg.dataDir, cwd: input.cfg.workspace, repoRoot: input.cfg.workspace });
      return {
        skills: skills.map((skill) => ({
          name: skill.name,
          description: skill.description,
          scope: skill.scope,
          bytes: skill.bytes,
          path: skill.path,
        })),
      };
    }
    case "mcp":
      return { servers: listMcpServers(input.cfg.dataDir) };
    case "knowledge":
      return { documents: input.knowledge.list(), stats: input.knowledge.stats() };
    case "persona": {
      const soul = personaUsage(input.cfg.dataDir);
      const contracts = contractsUsage(input.cfg.dataDir);
      return {
        soul: soul ? { ...soul, text: readSoul(input.cfg.dataDir) ?? "" } : null,
        contracts: contracts ? { ...contracts, text: readContracts(input.cfg.dataDir) ?? "" } : null,
      };
    }
    case "reminders":
      return {
        pending: input.reminders.pending().map((row) => ({
          id: row.id,
          thread: row.thread,
          channel: row.channel,
          chatId: row.chatId,
          text: row.text,
          dueAt: row.dueAt,
          createdAt: row.createdAt,
        })),
      };
    case "state": {
      const chatId = params.get("chat") ?? "";
      const scope = CHAT_ID.test(chatId) ? webThread(chatId) : "global";
      return { scope, items: input.shortState.list(scope) };
    }
    case "config":
      return publicConfig(input.cfg, input.store);
    default:
      return { error: "unknown section" };
  }
}

export function publicConfig(cfg: RuntimeConfig, store: Store): Record<string, unknown> {
  return {
    ownerName: cfg.ownerName,
    provider: cfg.provider ?? null,
    model: cfg.model ?? null,
    workspace: cfg.workspace,
    sandbox: cfg.sandbox,
    maxMinutes: cfg.maxMinutes,
    memory: {
      enabled: cfg.memoryEnabled,
      budgetChars: cfg.memoryBudgetChars,
      batchTurns: cfg.batchTurns,
      idleMinutes: cfg.idleMinutes,
      autoExtract: cfg.autoExtract,
    },
    context: {
      turns: cfg.contextTurns,
      budgetChars: cfg.contextBudgetChars,
      summaryEnabled: cfg.summaryEnabled,
      summaryTriggerChars: cfg.summaryTriggerChars,
      summaryMaxChars: cfg.summaryMaxChars,
    },
    limits: {
      maxAttempts: cfg.limits.maxAttempts,
      maxConcurrent: cfg.limits.maxConcurrent,
      dailyTokens: cfg.limits.dailyTokens,
      taskTokens: cfg.limits.taskTokens,
    },
    usageToday: store.usageToday(),
  };
}

export function webInfo(cfg: RuntimeConfig, store: Store): WebInfo {
  return {
    ok: true,
    name: "Tree-Agent",
    channel: "web",
    ownerName: cfg.ownerName,
    provider: cfg.provider ?? null,
    model: cfg.model ?? null,
    workspace: cfg.workspace,
    sandbox: cfg.sandbox,
    memoryEnabled: cfg.memoryEnabled,
    usageToday: store.usageToday(),
  };
}
