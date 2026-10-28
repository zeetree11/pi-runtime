import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { buildFanoutDigest, NoteStore, retryPrompt, shouldRetry, type Note } from "./fanout.ts";
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
  log?: (message: string) => void;
};

export type ControlServer = { port: number; close: () => Promise<void> };

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
        close: () => new Promise<void>((done) => server.close(() => done())),
      });
    });
  });
}
