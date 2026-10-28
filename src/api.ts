import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { buildFanoutDigest, NoteStore, retryPrompt, shouldRetry, type Note } from "./fanout.ts";
import { FileLockStore } from "./file-lock.ts";
import { ProposalStore, describeMcpEntry } from "./proposal.ts";
import { buildSplitPrompt, parseSubtasks, runWithLimit, type ChildSpec } from "./subagent.ts";

/**
 * Local control API.
 *
 * The agent reaches fan-out through an MCP server, which is a separate process from the runtime.
 * Rather than letting that server own a second scheduler (two owners of one queue is how you get
 * double-spawned children), it calls this API: one process decides what runs, how many at once,
 * and when to stop.
 *
 * Bound to 127.0.0.1 on purpose. It has no auth, because it must not be reachable from anywhere
 * except inside the container.
 *
 * Known limitation, stated rather than hidden: one fan-out at a time. The shared-note scope is a
 * process-wide variable, so two concurrent fan-outs would see each other's notes. The gate that
 * serialises tasks per thread makes this acceptable at single-user scale; a per-scope registry
 * is the fix when it stops being true.
 */
export type FanoutDeps = {
  /** Run one child task and return its text. Index 0 is reserved for the split step. */
  runChild: (input: { prompt: string; thread: string; index: number; parentTaskId?: string }) => Promise<string>;
  notes: NoteStore;
  maxChildren?: number;
  concurrency?: number;
  /** Thread the children belong to; also the parent task's thread. */
  defaultThread?: string;
  /** Deliver a proactive message to the user. Set by the channel adapter per incoming message. */
  sendText?: (text: string) => Promise<void>;
  /** Advisory path locks shared by fan-out children. */
  locks?: FileLockStore;
  /** Controlled self-modification: persona files and MCP server entries. */
  proposals?: ProposalStore;
  log?: (message: string) => void;
};

export type ControlServer = {
  port: number;
  /** Bind the sender + reset the quota for the task that is starting. */
  setSession: (thread: string, sendText: (text: string) => Promise<void>) => void;
  close: () => Promise<void>;
};

const MAX_BODY = 256 * 1024;

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

function json(response: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  response.end(payload);
}

export function startControlServer(deps: FanoutDeps, port = Number(process.env.PI_RT_API_PORT ?? 8899)): Promise<ControlServer> {
  const log = deps.log ?? (() => {});
  const maxChildren = Math.min(Math.max(deps.maxChildren ?? 4, 2), 6);
  const concurrency = Math.min(Math.max(deps.concurrency ?? Number(process.env.PI_RT_SPAWN_CONCURRENCY ?? 3), 1), 4);

  // Notes are scoped to the fan-out that is currently running. Single-user scale means one at a
  // time; the gate already serialises tasks per thread.
  let currentScope = "default";
  let running = false;

  // Proactive sends are quota-limited per task. `send` exists so a long task can report
  // progress; without a cap it becomes a second, unchosen reply stream — and the user has no
  // way to tell which message is the answer.
  const MAX_SENDS = Number(process.env.PI_RT_SEND_MAX ?? 3);
  const MAX_SEND_CHARS = Number(process.env.PI_RT_SEND_CHARS ?? 600);
  let sendCount = 0;
  let sendWindowThread = "";
  let sender: ((text: string) => Promise<void>) | null = null;

  const server = createServer((request, response) => {
    const url = request.url ?? "/";
    void (async () => {
      try {
        if (request.method === "GET" && url === "/health") {
          json(response, 200, { ok: true, running, scope: currentScope, notes: deps.notes.read(currentScope).length });
          return;
        }

        if (request.method === "POST" && url === "/notes/read") {
          const notes = deps.notes.read(currentScope);
          if (notes.length === 0) {
            json(response, 200, { text: "（还没有共享便签）" });
            return;
          }
          const text = notes.map((note) => `- ${note.key}: ${note.value}（${note.by}）`).join("\n");
          json(response, 200, { text });
          return;
        }

        // The channel adapter registers the sender for the message it is currently answering,
        // and resets the quota. One sender at a time is correct here: tasks are serialised per
        // thread, and a proactive message must go to the conversation that asked for it.
        if (request.method === "POST" && url === "/send/session") {
          const body = await readJson(request);
          const thread = String(body.thread ?? "");
          if (!thread) {
            json(response, 400, { error: "thread 必填" });
            return;
          }
          sendWindowThread = thread;
          sendCount = 0;
          sender = deps.sendText ?? null;
          json(response, 200, { ok: Boolean(sender), thread });
          return;
        }

        if (request.method === "POST" && url === "/send") {
          const body = await readJson(request);
          const text = String(body.text ?? "").trim();
          if (!text) {
            json(response, 400, { error: "text 必填" });
            return;
          }
          if (text.length > MAX_SEND_CHARS) {
            json(response, 400, { error: `消息过长（上限 ${MAX_SEND_CHARS} 字符），请只发结论` });
            return;
          }
          const target = body.thread ? String(body.thread) : sendWindowThread;
          if (target && target !== sendWindowThread) {
            json(response, 403, { error: "只能发往当前会话" });
            return;
          }
          if (!sender) {
            json(response, 409, { error: "没有可用的发送通道" });
            return;
          }
          if (sendCount >= MAX_SENDS) {
            // Refuse instead of silently dropping: the model should know it hit the cap.
            json(response, 429, { error: `本次任务最多主动发送 ${MAX_SENDS} 条，已用完` });
            return;
          }
          await sender(text);
          sendCount += 1;
          json(response, 200, { ok: true, remaining: MAX_SENDS - sendCount });
          return;
        }

        // Self-modification requests: validate, store as pending, tell the user how to approve.
        // Nothing is applied here — the approval reply is what triggers `apply`.
        if (request.method === "POST" && url === "/proposal") {
          if (!deps.proposals) {
            json(response, 503, { error: "自改通道未启用" });
            return;
          }
          const body = await readJson(request);
          const thread = sendWindowThread || "default";
          const rationale = String(body.rationale ?? "").trim();
          if (!rationale) {
            json(response, 400, { error: "必须写理由（rationale），否则用户无法判断该不该批" });
            return;
          }

          const kind = String(body.kind ?? "persona");
          const requested =
            kind === "mcp"
              ? deps.proposals.requestMcp({
                  thread,
                  rationale,
                  server: {
                    name: String(body.name ?? ""),
                    command: String(body.command ?? ""),
                    args: Array.isArray(body.args) ? body.args.map(String) : undefined,
                    env: body.env && typeof body.env === "object" ? (body.env as Record<string, string>) : undefined,
                    exposure: body.exposure ? String(body.exposure) : undefined,
                    description: body.description ? String(body.description) : undefined,
                  },
                })
              : deps.proposals.request({
                  thread,
                  rationale,
                  path: String(body.path ?? ""),
                  content: String(body.content ?? ""),
                });

          if (!requested.ok) {
            json(response, 400, { error: requested.reason });
            return;
          }

          const proposal = requested.proposal;
          const isMcp = proposal.path.startsWith("mcp:");
          const what = isMcp ? `给自装上 MCP server「${proposal.path.slice(4)}」` : `修改 ${proposal.path}`;
          const messageParts = [`我想${what}。`, `理由：${proposal.rationale}`];

          // For an MCP server the approval decision is really "may this command run on every turn
          // from now on", so the command line is part of the message, not a detail behind it.
          if (isMcp) {
            const described = describeMcpEntry(proposal.after);
            messageParts.push(`要运行的命令：\`${described.commandLine}\``);
            if (described.downloads) {
              messageParts.push("⚠️ 这会从网络下载第三方代码并在容器里运行，能读到 /data 下的记忆库。");
            }
          }

          messageParts.push("回复「同意」我就改，回复「拒绝」保持原样（30 分钟内有效）。");
          const message = messageParts.join("\n");
          if (sender) await sender(message);
          json(response, 200, { ok: true, id: proposal.id, status: proposal.status, preview: message });
          return;
        }

        if (request.method === "POST" && (url === "/lock" || url === "/unlock" || url === "/locks")) {
          if (!deps.locks) {
            json(response, 503, { error: "锁服务未启用" });
            return;
          }
          const body = await readJson(request);
          if (url === "/locks") {
            json(response, 200, { locks: deps.locks.list() });
            return;
          }
          const owner = String(body.owner ?? "child");
          if (url === "/unlock") {
            json(response, 200, { released: deps.locks.release({ path: String(body.path ?? ""), owner }) });
            return;
          }
          const result = deps.locks.acquire({
            path: String(body.path ?? ""),
            owner,
            reason: body.reason ? String(body.reason) : null,
            ttlMinutes: body.ttlMinutes ? Number(body.ttlMinutes) : undefined,
          });
          if (!result.ok) {
            // 409 with the holder is the useful answer: the child can wait, or pick another file.
            json(response, 409, {
              error: `${result.heldBy.path} 已被 ${result.heldBy.owner} 锁定（到 ${result.heldBy.expiresAt}）`,
              heldBy: result.heldBy,
            });
            return;
          }
          json(response, 200, { ok: true, lock: result.lock });
          return;
        }

        if (request.method === "POST" && url === "/notes") {
          const body = await readJson(request);
          const key = String(body.key ?? "").trim();
          const value = String(body.value ?? "").trim();
          if (!key || !value) {
            json(response, 400, { error: "key 和 value 必填" });
            return;
          }
          deps.notes.write(currentScope, key, value, String(body.by ?? "child"));
          json(response, 200, { ok: true, scope: currentScope });
          return;
        }

        if (request.method === "POST" && url === "/fanout") {
          const body = await readJson(request);
          const prompt = String(body.prompt ?? "").trim();
          if (!prompt) {
            json(response, 400, { error: "prompt 必填" });
            return;
          }
          if (prompt.length > 8_000) {
            json(response, 400, { error: "prompt 过长（上限 8000 字符）" });
            return;
          }
          if (running) {
            json(response, 409, { error: "已有 fan-out 在执行，稍后再试" });
            return;
          }

          running = true;
          currentScope = String(body.scope ?? "") || `fanout-${Date.now()}`;
          const count = Math.min(Math.max(Number(body.count ?? 3), 2), maxChildren);
          const thread = deps.defaultThread ?? "default";
          log(`fan-out start scope=${currentScope} count=${count}`);

          try {
            const splitOut = await deps.runChild({ prompt: buildSplitPrompt(prompt, count), thread, index: 0 });
            const specs: ChildSpec[] = parseSubtasks(splitOut, count);
            if (specs.length === 0) {
              deps.notes.clear(currentScope);
              json(response, 200, { digest: "拆分失败：模型没有返回可用的子任务列表。", results: [] });
              return;
            }

            const results = await runWithLimit(specs, concurrency, async (spec) => {
              let attempts = 0;
              let lastError = "";
              while (attempts < 2) {
                attempts += 1;
                const childPrompt = attempts === 1 ? spec.prompt : retryPrompt(spec.prompt, lastError);
                try {
                  const output = await deps.runChild({ prompt: childPrompt, thread, index: spec.index });
                  return { title: spec.title, ok: true, output, attempts };
                } catch (error) {
                  lastError = error instanceof Error ? error.message : String(error);
                  if (!shouldRetry("failed", attempts)) break;
                  log(`子任务 ${spec.index} 失败，重试一次：${lastError}`);
                }
              }
              return { title: spec.title, ok: false, output: "", attempts, error: lastError };
            });

            const notes: Note[] = deps.notes.read(currentScope);
            const digest = buildFanoutDigest({ prompt, results, notes });
            log(`fan-out done scope=${currentScope} ok=${results.filter((r) => r.ok).length}/${results.length} notes=${notes.length}`);
            json(response, 200, { digest, results, notes, scope: currentScope });
          } catch (error) {
            json(response, 500, { error: error instanceof Error ? error.message : String(error) });
          } finally {
            running = false;
          }
          return;
        }

        json(response, 404, { error: "not found" });
      } catch (error) {
        json(response, 500, { error: error instanceof Error ? error.message : String(error) });
      }
    })();
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      const actual = (server.address() as { port: number }).port;
      resolve({
        port: actual,
        setSession: (thread, sendText) => {
          sendWindowThread = thread;
          sendCount = 0;
          sender = sendText;
        },
        close: () => new Promise<void>((done) => server.close(() => done())),
      });
    });
  });
}
