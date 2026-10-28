import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { CHUNK_CHARS, KnowledgeStore, chunkText, formatHits } from "../src/knowledge.ts";

let pass = 0;
let fail = 0;
function check(name, ok, detail = "") {
  if (ok) {
    pass += 1;
    console.log(`PASS ${name}`);
  } else {
    fail += 1;
    console.log(`FAIL ${name} ${detail}`);
  }
}

// 1) chunking
{
  check("short text is one chunk", chunkText("很短的一段话").length === 1);
  check("empty yields nothing", chunkText("   ").length === 0);

  const long = "句子一。".repeat(400); // 1600 chars
  const chunks = chunkText(long);
  check("long text splits", chunks.length >= 2, String(chunks.length));
  check("chunks respect size", chunks.every((chunk) => chunk.length <= CHUNK_CHARS + 20), `max ${Math.max(...chunks.map((c) => c.length))}`);
  check("chunks cover the text", chunks.join("").replace(/\s/g, "").length >= long.replace(/\s/g, "").length * 0.95);
  check("splits on sentence boundary", chunks[0].endsWith("。") || chunks[0].endsWith("\n"), JSON.stringify(chunks[0].slice(-6)));

  const para = `${"a".repeat(500)}\n\n${"b".repeat(500)}`;
  const paraChunks = chunkText(para);
  check("prefers paragraph break", paraChunks[0].length <= 520, String(paraChunks[0].length));
}

// 2) ingest + search
{
  const dir = mkdtempSync(path.join(tmpdir(), "pi-knowledge-"));
  const store = new KnowledgeStore(dir);

  const added = await store.add("feishu.md", "长连接不需要公网地址。事件订阅选择长连接即可，无需 ICP 备案。" + "无关内容。".repeat(100));
  check("add reports chunks", added.chunks >= 1, String(added.chunks));
  check("model recorded", added.model.length > 0, added.model);

  const hits = await store.search("长连接 备案", { limit: 3 });
  check("search returns hits", hits.length > 0, String(hits.length));
  check("best hit mentions the topic", hits[0]?.text.includes("长连接"), hits[0]?.text?.slice(0, 40));
  check("hit carries source and position", hits[0]?.source === "feishu.md" && typeof hits[0]?.chunkNo === "number");

  // re-ingest replaces instead of duplicating
  const before = store.stats().chunks;
  await store.add("feishu.md", "完全不同的内容，讲的是别的事。");
  check("re-ingest replaces chunks", store.stats().chunks < before + 2, `${before} -> ${store.stats().chunks}`);
  check("one document listed", store.list().length === 1, String(store.list().length));

  const other = await store.add("qq.md", "OneBot v11 用 WebSocket 收消息，HTTP 发消息。");
  check("second document added", store.list().length === 2, other.source);

  const qqHits = await store.search("怎么发消息", { limit: 2 });
  check("search finds the right document", qqHits[0]?.source === "qq.md", qqHits[0]?.source);

  check("remove works", store.remove("qq.md") === true);
  check("removed doc is gone", store.list().length === 1);
  check("removing twice is false", store.remove("qq.md") === false);

  const empty = await store.search("完全不存在的话题xyzzy", { limit: 3 });
  check("unrelated query returns few/none", empty.length <= 1, String(empty.length));

  const rendered = formatHits(hits, "长连接 备案");
  check("format includes source", rendered.includes("feishu.md"));
  check("format includes query", rendered.includes("长连接 备案"));

  try { rmSync(dir, { recursive: true, force: true }); } catch { /* Windows handle */ }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
