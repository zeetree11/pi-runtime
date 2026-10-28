#!/usr/bin/env node
/**
 * MCP server exposing fan-out control to the agent.
 *
 * Why a local HTTP hop: the MCP server runs as a child of pi (inside the container), while the
 * tasks, the gate and the memory store live in the runtime process. Rather than duplicating the
 * scheduler here, this server is a thin client of the runtime's local control API — one owner of
 * the state, one place to enforce limits.
 *
 * Tools:
 * - `fanout(prompt, count)`  split a task and run sub-agents in parallel; returns the digest
 * - `note_write(key, value)` publish a finding to the shared scratchpad for this fan-out
 * - `note_read()`            read everything published so far
 *
 * Depth is enforced by the runtime, not here: a child gets `PI_RT_FANOUT_DEPTH=1` and the
 * runtime refuses a second level. Guessing depth in the tool would be a second source of truth.
 */
const API = process.env.PI_RT_API ?? "http://127.0.0.1:8899";
const DEPTH = Number(process.env.PI_RT_FANOUT_DEPTH ?? 0);
const SCOPE = process.env.PI_RT_FANOUT_SCOPE ?? "";

const PROTOCOL_VERSION = "2024-11-05";

const TOOLS = [
  {
    name: "fanout",
    description:
      "把一个复杂任务拆成多个子任务并行执行，返回各子任务结果与汇总。适用于彼此独立、可以同时做的部分" +
      "（多个文件/多个来源/多角度分析）。不要在任务本身很小或强顺序依赖时使用。",
    inputSchema: {
      type: "object",
      properties: {
        prompt: { type: "string", description: "要拆分的完整任务描述。" },
        count: { type: "integer", minimum: 2, maximum: 4, description: "子任务个数，默认 3。" },
      },
      required: ["prompt"],
      additionalProperties: false,
    },
  },
  {
    name: "note_write",
    description: "把一条结论写进本轮子任务的共享便签，其他子任务和汇总都能看到。用于避免重复劳动。",
    inputSchema: {
      type: "object",
      properties: {
        key: { type: "string", description: "结论的主题（同一个主题用同一个 key）。" },
        value: { type: "string", description: "结论内容。" },
      },
      required: ["key", "value"],
      additionalProperties: false,
    },
  },
  {
    name: "note_read",
    description: "读取本轮子任务已经写下的共享便签。开始工作前先读，避免重复别人已经查过的部分。",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
];

async function call(path, body) {
  const response = await fetch(`${API}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body ?? {}),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`运行时返回 ${response.status}: ${text.slice(0, 200)}`);
  try {
    return JSON.parse(text);
  } catch {
    return { text };
  }
}

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}
const reply = (id, result) => send({ jsonrpc: "2.0", id, result });
const fail = (id, message) => send({ jsonrpc: "2.0", id, error: { code: -32603, message } });

async function handle(message) {
  const { id, method, params } = message;

  if (method === "initialize") {
    reply(id, {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: { tools: {} },
      serverInfo: { name: "fanout", version: "1.0.0" },
    });
    return;
  }
  if (method === "notifications/initialized" || method === "initialized") return;
  if (method === "ping") return reply(id, {});
  if (method === "tools/list") return reply(id, { tools: TOOLS });

  if (method === "tools/call") {
    const name = params?.name;
    const args = params?.arguments ?? {};
    try {
      if (name === "fanout") {
        if (DEPTH > 0) throw new Error("子任务里不能再派生（深度上限 1）");
        const result = await call("/fanout", { prompt: args.prompt, count: args.count, scope: SCOPE });
        reply(id, { content: [{ type: "text", text: result.digest }], isError: false });
        return;
      }
      if (name === "note_write") {
        await call("/notes", { scope: SCOPE || "default", key: args.key, value: args.value, by: `depth${DEPTH}` });
        reply(id, { content: [{ type: "text", text: `已记录：${args.key}` }], isError: false });
        return;
      }
      if (name === "note_read") {
        const result = await call("/notes/read", { scope: SCOPE || "default" });
        reply(id, { content: [{ type: "text", text: result.text }], isError: false });
        return;
      }
      fail(id, `未知工具：${name}`);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      reply(id, { content: [{ type: "text", text: `${name} 失败：${reason}` }], isError: true });
    }
    return;
  }
  if (typeof id !== "undefined") fail(id, `未知方法：${method}`);
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
          if (message?.id !== undefined) fail(message.id, error.message);
        });
      } catch {
        /* ignore malformed line */
      }
    }
    index = buffer.indexOf("\n");
  }
});
