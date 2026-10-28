#!/usr/bin/env node
/**
 * MCP server for the document knowledge base.
 *
 * Reads the same SQLite file the runtime uses, with the same chunk/embedding code path, so a
 * document ingested by the CLI is immediately searchable from chat without a sync step.
 *
 * Write access is limited to `knowledge_add`, and it only touches `knowledge_chunks`. The memory
 * tables are not reachable from here — a document must never be able to masquerade as something
 * the user said.
 */
import { DatabaseSync } from "node:sqlite";
import { blobToVector, cosine, embedText } from "./lib/embed.mjs";

const DB_PATH = process.env.PI_RT_DB ?? "/data/runtime.db";
const PROTOCOL_VERSION = "2024-11-05";
const CHUNK_CHARS = 600;
const CHUNK_OVERLAP = 80;

const TOOLS = [
  {
    name: "knowledge_search",
    description:
      "在文档知识库里检索。用于用户问到的资料、手册、规范、你之前导入过的文档内容；" +
      "和 memory_search 的区别：知识库是文档原文，记忆是关于用户的结论。",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "要查找的内容。" },
        limit: { type: "integer", minimum: 1, maximum: 10, description: "返回段数，默认 5。" },
      },
      required: ["query"],
      additionalProperties: false,
    },
  },
  {
    name: "knowledge_list",
    description: "列出知识库里已导入的文档。添加新文档前先看一眼，避免重复导入。",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "knowledge_add",
    description:
      "把一段文本导入知识库（按 source 去重，同名会覆盖）。适合用户粘贴的长文档、规范、笔记。" +
      "不要用它记用户偏好或身份信息，那些属于记忆。",
    inputSchema: {
      type: "object",
      properties: {
        source: { type: "string", description: "文档名，例如 feishu-api.md。" },
        text: { type: "string", description: "文档正文。" },
      },
      required: ["source", "text"],
      additionalProperties: false,
    },
  },
];

export function chunkText(text, chars = CHUNK_CHARS, overlap = CHUNK_OVERLAP) {
  const normalized = String(text ?? "").replace(/\r\n/g, "\n").trim();
  if (!normalized) return [];
  if (normalized.length <= chars) return [normalized];
  const chunks = [];
  let start = 0;
  while (start < normalized.length) {
    let end = Math.min(normalized.length, start + chars);
    if (end < normalized.length) {
      const window = normalized.slice(start, end);
      const boundary = Math.max(
        window.lastIndexOf("\n\n"),
        window.lastIndexOf("。"),
        window.lastIndexOf("\n"),
        window.lastIndexOf("；"),
      );
      if (boundary > chars * 0.7) end = start + boundary + 1;
    }
    const piece = normalized.slice(start, end).trim();
    if (piece) chunks.push(piece);
    if (end >= normalized.length) break;
    start = Math.max(end - overlap, start + 1);
  }
  return chunks;
}

function openDb() {
  const db = new DatabaseSync(DB_PATH);
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA busy_timeout = 5000;");
  db.exec(`
    CREATE TABLE IF NOT EXISTS knowledge_chunks (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      source          TEXT NOT NULL,
      chunk_no        INTEGER NOT NULL,
      text            TEXT NOT NULL,
      embedding       BLOB,
      embedding_model TEXT,
      created_at      TEXT NOT NULL
    );
  `);
  return db;
}

async function search(query, limit = 5) {
  const trimmed = String(query ?? "").trim();
  if (!trimmed) throw new Error("查询为空");
  const { vector, model } = await embedText(trimmed);
  const db = openDb();
  try {
    const rows = db
      .prepare("SELECT * FROM knowledge_chunks WHERE embedding IS NOT NULL AND embedding_model = ?")
      .all(model);
    const hits = [];
    for (const row of rows) {
      const stored = blobToVector(row.embedding ?? null);
      if (!stored || stored.length !== vector.length) continue;
      const score = cosine(vector, stored);
      if (score < 0.08) continue;
      hits.push({ source: row.source, chunkNo: Number(row.chunk_no), text: String(row.text), score });
    }
    hits.sort((a, b) => b.score - a.score);
    const top = hits.slice(0, Math.min(Math.max(Number(limit), 1), 10));
    if (top.length === 0) return `知识库里没有和「${trimmed}」相关的内容。`;
    return [
      `## 知识库命中（${top.length} 段）`,
      ...top.map((hit) => `\n### ${hit.source} #${hit.chunkNo}（相关度 ${hit.score.toFixed(2)}）\n${hit.text}`),
    ].join("\n");
  } finally {
    db.close();
  }
}

async function add(source, text) {
  const name = String(source ?? "").trim();
  const body = String(text ?? "").trim();
  if (!name || !body) throw new Error("source 和 text 必填");
  if (body.length > 200_000) throw new Error("单次导入上限 20 万字符，请拆分");
  const chunks = chunkText(body);
  const db = openDb();
  try {
    db.prepare("DELETE FROM knowledge_chunks WHERE source = ?").run(name);
    let model = "";
    const createdAt = new Date().toISOString();
    for (const [index, chunk] of chunks.entries()) {
      const embedded = await embedText(chunk);
      model = embedded.model;
      db.prepare(
        `INSERT INTO knowledge_chunks (source, chunk_no, text, embedding, embedding_model, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      ).run(name, index, chunk, Buffer.from(embedded.vector.buffer), embedded.model, createdAt);
    }
    return `已导入 ${name}：${chunks.length} 段（模型 ${model}）`;
  } finally {
    db.close();
  }
}

function list() {
  const db = openDb();
  try {
    const rows = db
      .prepare("SELECT source, COUNT(*) chunks, SUM(LENGTH(text)) chars FROM knowledge_chunks GROUP BY source ORDER BY source")
      .all();
    if (rows.length === 0) return "（知识库还是空的）";
    return rows.map((row) => `- ${row.source}: ${row.chunks} 段，${row.chars} 字符`).join("\n");
  } finally {
    db.close();
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
      serverInfo: { name: "knowledge", version: "1.0.0" },
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
      let text = "";
      if (name === "knowledge_search") text = await search(args.query, args.limit);
      else if (name === "knowledge_list") text = list();
      else if (name === "knowledge_add") text = await add(args.source, args.text);
      else {
        fail(id, `未知工具：${name}`);
        return;
      }
      reply(id, { content: [{ type: "text", text }], isError: false });
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
