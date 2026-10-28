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
    name: "lock_file",
    description:
      "在改某个文件前先锁住它（路径级租约，默认 10 分钟自动过期）。如果已被别人锁定会返回持有者。" +
      "改完后用 unlock_file 释放。并发子任务改同一个文件时必须先锁。",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "文件路径，例如 src/a.ts 或 /workspace/src/a.ts。" },
        reason: { type: "string", description: "可选：为什么要改这个文件。" },
      },
      required: ["path"],
      additionalProperties: false,
    },
  },
  {
    name: "unlock_file",
    description: "释放自己持有的文件锁。",
    inputSchema: {
      type: "object",
      properties: { path: { type: "string", description: "文件路径。" } },
      required: ["path"],
      additionalProperties: false,
    },
  },
  {
    name: "list_locks",
    description: "列出当前有效的文件锁（谁在改什么）。写文件前可以先看一眼避免撞车。",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "propose_self_edit",
    description:
      "申请修改你自己的能力面：人格文件（persona/SOUL.md、persona/CONTRACTS.md）或新增/替换一个 MCP server。" +
      "运行时不会立即生效，会先问用户，用户回「同意」才应用。改不了运行时代码（src/**）。" +
      "有明确理由时才用，理由要能让人判断该不该批。",
    inputSchema: {
      type: "object",
      properties: {
        kind: { type: "string", enum: ["persona", "mcp"], description: "persona=改人格文件；mcp=加工具服务器。" },
        path: { type: "string", description: "kind=persona 时必填，例如 persona/SOUL.md。" },
        content: { type: "string", description: "kind=persona 时必填，完整的文件新内容。" },
        name: { type: "string", description: "kind=mcp 时必填，server 名（小写 a-z0-9_-）。" },
        command: { type: "string", description: "kind=mcp 时必填，只能是 node/npx/uvx/python3/deno/bun。" },
        args: { type: "array", items: { type: "string" }, description: "kind=mcp 时的参数，路径必须在 /workspace 内。" },
        description: { type: "string", description: "kind=mcp 时的一句话说明。" },
        rationale: { type: "string", description: "为什么需要这个改动（必填）。" },
      },
      required: ["kind", "rationale"],
      additionalProperties: false,
    },
  },
  {
    name: "send",
    description:
      "在任务执行过程中主动给用户发一条消息（进度、中间结论、需要等待的原因）。" +
      "一次任务最多 3 条，每条不超过 600 字符。最终结论仍然通过正常回复给出，不要用 send 代替最终答复。",
    inputSchema: {
      type: "object",
      properties: { text: { type: "string", description: "要发送的内容（简短）。" } },
      required: ["text"],
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
      if (name === "lock_file") {
        const result = await call("/lock", { path: args.path, reason: args.reason, owner: `depth${DEPTH}` });
        reply(id, { content: [{ type: "text", text: `已锁定 ${result.lock.path}（到 ${result.lock.expiresAt}）` }], isError: false });
        return;
      }
      if (name === "unlock_file") {
        const result = await call("/unlock", { path: args.path, owner: `depth${DEPTH}` });
        reply(id, { content: [{ type: "text", text: result.released ? "已释放" : "没有你持有的该锁" }], isError: false });
        return;
      }
      if (name === "list_locks") {
        const result = await call("/locks", {});
        const text = result.locks.length === 0
          ? "（当前没有文件锁）"
          : result.locks.map((lock) => `- ${lock.path} ← ${lock.owner}（到 ${lock.expiresAt}）`).join("\n");
        reply(id, { content: [{ type: "text", text }], isError: false });
        return;
      }
      if (name === "propose_self_edit") {
        const result = await call("/proposal", {
          kind: args.kind,
          path: args.path,
          content: args.content,
          name: args.name,
          command: args.command,
          args: args.args,
          description: args.description,
          rationale: args.rationale,
        });
        reply(id, {
          content: [{ type: "text", text: `已提交申请 #${result.id}，等待用户确认。\n\n${result.preview}` }],
          isError: false,
        });
        return;
      }
      if (name === "send") {
        const result = await call("/send", { text: args.text });
        reply(id, { content: [{ type: "text", text: `已发送（本次还剩 ${result.remaining} 条额度）` }], isError: false });
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
