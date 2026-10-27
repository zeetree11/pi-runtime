#!/usr/bin/env node
/**
 * MCP server exposing read-only memory search.
 *
 * This is the "pull" half of the memory system: the runtime still injects a scoped block every
 * turn (free, no latency), and this server lets the model look further when the injected block
 * does not cover the question — "上次那个并发的问题" style recall.
 *
 * Three deliberate limits:
 *
 * 1. READ-ONLY. Opens the database read-only; a write here would break the invariant that the
 *    read path never mutates memory.
 * 2. Only `active` rows. Cross-checked against the same status filter the injector uses, so a
 *    search can never surface a superseded/invalidated/contested claim as fact.
 * 3. Same embedding model only. Vectors from different providers are incomparable; rows whose
 *    `embedding_model` differs from the query's are skipped instead of mis-scored.
 */
import { DatabaseSync } from "node:sqlite";
import { blobToVector, cosine, embedText } from "./lib/embed.mjs";

const PROTOCOL_VERSION = "2024-11-05";
const DB_PATH = process.env.PI_RT_DB ?? "/data/runtime.db";

const TOOL = {
  name: "memory_search",
  description:
    "在长期记忆里做语义检索，返回相关的事实及其证据。当注入的记忆块没有覆盖用户提到的事情时使用，" +
    "例如「上次那个并发的问题」。只返回当前有效的记忆，附带原始对话引文。",
  inputSchema: {
    type: "object",
    properties: {
      query: { type: "string", description: "要查找的内容（自然语言）。" },
      limit: { type: "integer", minimum: 1, maximum: 20, description: "返回条数，默认 5。" },
      thread: { type: "string", description: "可选：限定到某个会话，防止跨会话串味。" },
    },
    required: ["query"],
    additionalProperties: false,
  },
};

function openReadOnly() {
  try {
    return new DatabaseSync(DB_PATH, { readOnly: true });
  } catch {
    // Fallback for Node builds that ignore the option: opening normally and refusing writes is
    // still safer than failing the whole tool.
    return new DatabaseSync(DB_PATH);
  }
}

export async function searchMemory(query, options = {}) {
  const trimmed = String(query ?? "").trim();
  if (!trimmed) throw new Error("查询为空");
  if (trimmed.length > 300) throw new Error("查询过长（上限 300 字符）");
  const limit = Math.min(Math.max(Number(options.limit ?? 5), 1), 20);

  const { vector, model } = await embedText(trimmed);
  const db = openReadOnly();
  try {
    const rows = db
      .prepare(
        `SELECT id, key, target_name, subject, category, content, evidence_event_id,
                evidence_quote, importance, thread, updated_at
           FROM memories
          WHERE status = 'active' AND embedding IS NOT NULL AND embedding_model = ?`,
      )
      .all(model);

    const scored = [];
    for (const row of rows) {
      if (options.thread && row.thread && row.thread !== options.thread) continue;
      const stored = blobToVector(row.embedding ?? null);
      if (!stored || stored.length !== vector.length) continue;
      const score = cosine(vector, stored);
      if (score < 0.12) continue;
      scored.push({ row, score });
    }
    scored.sort((a, b) => b.score - a.score);

    if (scored.length === 0) {
      return `记忆库里没有和「${trimmed}」相关的内容（可能还没建向量索引）。`;
    }

    const lines = scored.slice(0, limit).map(({ row, score }) => {
      const who = row.target_name ? `${row.target_name} · ` : "";
      const quote = row.evidence_quote ? `\n   证据 #${row.evidence_event_id}：「${row.evidence_quote}」` : "";
      return `- [${who}${row.category}·${row.importance}] ${row.content}（相关度 ${score.toFixed(2)}）${quote}`;
    });

    return [`## 检索到的记忆（${lines.length} 条，模型 ${model}）`, ...lines].join("\n");
  } finally {
    try {
      db.close();
    } catch {
      /* ignore */
    }
  }
}

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function reply(id, result) {
  send({ jsonrpc: "2.0", id, result });
}

function fail(id, message) {
  send({ jsonrpc: "2.0", id, error: { code: -32603, message } });
}

async function handle(message) {
  const { id, method, params } = message;

  if (method === "initialize") {
    reply(id, {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: { tools: {} },
      serverInfo: { name: "memory", version: "1.0.0" },
    });
    return;
  }
  if (method === "notifications/initialized" || method === "initialized") return;
  if (method === "ping") {
    reply(id, {});
    return;
  }
  if (method === "tools/list") {
    reply(id, { tools: [TOOL] });
    return;
  }
  if (method === "tools/call") {
    if (params?.name !== TOOL.name) {
      fail(id, `未知工具：${params?.name}`);
      return;
    }
    try {
      const text = await searchMemory(params?.arguments?.query, params?.arguments ?? {});
      reply(id, { content: [{ type: "text", text }], isError: false });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      reply(id, { content: [{ type: "text", text: `记忆检索失败：${reason}` }], isError: true });
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
