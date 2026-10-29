#!/usr/bin/env node
/**
 * Terminal-bench style tool bridge.
 *
 * The agent runs in one container, the *task* runs in another. Every tool call is forwarded with
 * `docker exec` instead of touching the agent's own filesystem — that is the whole point: the
 * task container is the sandbox, and a bridged tool can never read the agent's files (no API key,
 * no host paths).
 *
 * Four details are load-bearing, each learned from a failure mode rather than invented:
 *
 * 1. `docker exec` is stateless, so `cd` would be forgotten between calls. Every command is
 *    wrapped with a sentinel (`__CWD__:`) that reports the container's real pwd back, and the
 *    server remembers it.
 * 2. Writing files goes through base64, never through string interpolation — a heredoc with
 *    quotes or backslashes in it corrupts the file silently.
 * 3. Output is truncated (50KB / 2000 lines) and stripped of ANSI escapes and `\r` progress
 *    lines, otherwise a `pip install` can eat the whole context window.
 * 4. Commands time out. A hung `apt-get` must not hang the run.
 */
import { spawn } from "node:child_process";

const CONTAINER = process.env.PI_RT_TASK_CONTAINER ?? "";
const TIMEOUT_MS = Number(process.env.PI_RT_TASK_TIMEOUT_MS ?? 120_000);
const MAX_BYTES = 50 * 1024;
const MAX_LINES = 2_000;
const PROTOCOL_VERSION = "2024-11-05";

const TOOLS = [
  {
    name: "task_bash",
    description: "在任务沙箱容器里执行 shell 命令。工作目录会在多次调用之间保持。",
    inputSchema: {
      type: "object",
      properties: { command: { type: "string", description: "要执行的命令。" } },
      required: ["command"],
      additionalProperties: false,
    },
  },
  {
    name: "task_read",
    description: "读取任务沙箱里的文件。大文件用 offset/limit 分片读。",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string" },
        offset: { type: "integer", minimum: 1 },
        limit: { type: "integer", minimum: 1, maximum: 2000 },
      },
      required: ["path"],
      additionalProperties: false,
    },
  },
  {
    name: "task_write",
    description: "写入（覆盖）任务沙箱里的文件。内容通过 base64 传输，不受引号/转义影响。",
    inputSchema: {
      type: "object",
      properties: { path: { type: "string" }, content: { type: "string" } },
      required: ["path", "content"],
      additionalProperties: false,
    },
  },
];

let cwd = "/app";

function clean(text) {
  return String(text)
    .replace(/\u001b\[[0-9;?]*[A-Za-z]/g, "")
    .replace(/\r(?!\n)/g, "\n")
    .replace(/\n{3,}/g, "\n\n");
}

function truncate(text) {
  let out = text;
  if (Buffer.byteLength(out) > MAX_BYTES) {
    out = Buffer.from(out).subarray(0, MAX_BYTES).toString("utf8");
    out += `\n…（输出已截断到 ${MAX_BYTES / 1024}KB）`;
  }
  const lines = out.split("\n");
  if (lines.length > MAX_LINES) {
    out = `${lines.slice(0, MAX_LINES).join("\n")}\n…（输出已截断到 ${MAX_LINES} 行）`;
  }
  return out;
}

/** Run a command inside the task container and return {stdout, stderr, code}. */
function execInTask(command, options = {}) {
  return new Promise((resolve) => {
    const child = spawn("docker", ["exec", CONTAINER, "sh", "-c", command], {
      timeout: options.timeoutMs ?? TIMEOUT_MS,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    child.on("error", (error) => resolve({ stdout: "", stderr: String(error), code: 127 }));
    child.on("close", (code) => resolve({ stdout, stderr, code: code ?? 1 }));
  });
}

async function runBash(command) {
  // The sentinel reports the container pwd after the command, so `cd` survives between calls.
  const wrapped = `cd ${JSON.stringify(cwd)} 2>/dev/null || cd /; ${command}\n__RC__=$?; printf '\\n__CWD__:%s' "$(pwd)"; exit $__RC__`;
  const result = await execInTask(wrapped);
  let stdout = clean(result.stdout);
  let stderr = clean(result.stderr);
  const marker = stdout.lastIndexOf("__CWD__:");
  if (marker >= 0) {
    const after = stdout.slice(marker + "__CWD__:".length).trim();
    if (after.startsWith("/")) cwd = after;
    stdout = stdout.slice(0, marker).replace(/\n+$/, "");
  }
  const parts = [];
  if (stdout.trim()) parts.push(stdout.trim());
  if (stderr.trim()) parts.push(`[stderr]\n${stderr.trim()}`);
  if (result.code !== 0) parts.push(`[exit ${result.code}]`);
  return truncate(parts.join("\n\n") || "（无输出）");
}

function shQuote(text) {
  return `'${String(text).replace(/'/g, "'\\''")}'`;
}

async function runRead(path, offset = 1, limit = 400) {
  const start = Math.max(1, Number(offset) || 1);
  const count = Math.min(Math.max(Number(limit) || 400, 1), 2000);
  const end = start + count - 1;
  const result = await execInTask(`test -f ${shQuote(path)} && sed -n '${start},${end}p' ${shQuote(path)} || echo "__MISSING__"`);
  if (result.stdout.includes("__MISSING__")) return `文件不存在：${path}`;
  return truncate(clean(result.stdout) || "（空文件或该区间没有内容）");
}

async function runWrite(path, content) {
  const base64 = Buffer.from(String(content ?? ""), "utf8").toString("base64");
  const dir = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : ".";
  const result = await execInTask(
    `mkdir -p ${shQuote(dir || ".")} && printf '%s' ${shQuote(base64)} | base64 -d > ${shQuote(path)} && printf '已写入 %s 字节' "$(wc -c < ${shQuote(path)})"`,
  );
  if (result.code !== 0) return `写入失败：${clean(result.stderr) || `exit ${result.code}`}`;
  return clean(result.stdout).trim();
}

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}
const reply = (id, result) => send({ jsonrpc: "2.0", id, result });

async function handle(message) {
  const { id, method, params } = message;
  if (method === "initialize") {
    reply(id, {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: { tools: {} },
      serverInfo: { name: "task", version: "1.0.0" },
    });
    return;
  }
  if (method === "notifications/initialized" || method === "initialized") return;
  if (method === "ping") return reply(id, {});
  if (method === "tools/list") return reply(id, { tools: TOOLS });

  if (method === "tools/call") {
    const name = params?.name;
    const args = params?.arguments ?? {};
    if (!CONTAINER) {
      reply(id, { content: [{ type: "text", text: "没有配置任务容器（PI_RT_TASK_CONTAINER 为空）" }], isError: true });
      return;
    }
    try {
      let text = "";
      if (name === "task_bash") text = await runBash(String(args.command ?? ""));
      else if (name === "task_read") text = await runRead(String(args.path ?? ""), args.offset, args.limit);
      else if (name === "task_write") text = await runWrite(String(args.path ?? ""), args.content);
      else {
        reply(id, { content: [{ type: "text", text: `未知工具：${name}` }], isError: true });
        return;
      }
      reply(id, { content: [{ type: "text", text }], isError: false });
    } catch (error) {
      reply(id, { content: [{ type: "text", text: `工具失败：${error instanceof Error ? error.message : String(error)}` }], isError: true });
    }
    return;
  }
  if (typeof id !== "undefined") send({ jsonrpc: "2.0", id, error: { code: -32603, message: `未知方法：${method}` } });
}

let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let index = buffer.indexOf("\n");
  while (index >= 0) {
    const line = buffer.slice(0, index).trim();
    buffer = buffer.slice(index + 1);
    if (line) {
      try {
        const message = JSON.parse(line);
        void handle(message).catch((error) => {
          if (message?.id !== undefined) {
            send({ jsonrpc: "2.0", id: message.id, error: { code: -32603, message: String(error?.message ?? error) } });
          }
        });
      } catch {
        /* ignore malformed line */
      }
    }
    index = buffer.indexOf("\n");
  }
});
