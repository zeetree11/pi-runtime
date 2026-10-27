import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { hashEmbed, cosine, vectorToBlob, blobToVector, embedText } from "../mcp/lib/embed.mjs";
import { MemoryStore } from "../src/memory.ts";

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

// 1) hash embedding basics
{
  const a = hashEmbed("用 SQLite 单机部署");
  const b = hashEmbed("SQLite 单机部署用");
  const c = hashEmbed("明天下午三点开会");
  check("deterministic", cosine(a, hashEmbed("用 SQLite 单机部署")) > 0.999);
  check("related texts score higher", cosine(a, b) > cosine(a, c), `${cosine(a, b).toFixed(2)} vs ${cosine(a, c).toFixed(2)}`);
  check("normalised", Math.abs(Math.hypot(...a) - 1) < 1e-5);
  check("empty text is zero vector", Math.hypot(...hashEmbed("")) === 0);
  check("chinese bigrams capture overlap", cosine(hashEmbed("并发问题"), hashEmbed("并发")) > 0.3);
}

// 2) blob round-trip
{
  const vector = hashEmbed("测试向量往返");
  const back = blobToVector(vectorToBlob(vector));
  check("blob round-trips length", back?.length === vector.length);
  check("blob round-trips values", Math.abs(back[3] - vector[3]) < 1e-6);
  check("null blob is null", blobToVector(null) === null);
}

// 3) embedText falls back to hash without credentials
{
  const result = await embedText("没有配置 key 时应该降级");
  check("fallback model is hash", result.model.startsWith("hash"), result.model);
  check("fallback returns vector", result.vector.length > 0);
}

// 4) store: backfill, search, scope and status filters
{
  const dir = mkdtempSync(path.join(tmpdir(), "pi-memsearch-"));
  const store = new MemoryStore(dir, "Rick");

  store.apply({ action: "create", category: "fact", key: "runtime.db", content: "runtime 用 SQLite 单机部署", importance: 4 });
  store.apply({ action: "create", category: "preference", key: "pref.brevity", content: "用户喜欢简短回答", importance: 3 });
  store.apply({ action: "create", category: "fact", key: "proj.orion7.owner", content: "Orion-7 由王工负责", importance: 5 });

  const pending = store.needingEmbedding(50);
  check("rows need embedding before backfill", pending.length === 3, String(pending.length));
  for (const item of pending) {
    const embedded = await embedText(item.text);
    store.setEmbedding(item.id, embedded.vector, embedded.model);
  }
  const stats = store.embeddingStats();
  check("all rows embedded", stats.embedded === stats.total, `${stats.embedded}/${stats.total}`);
  check("nothing left to backfill", store.needingEmbedding(50).length === 0);

  const query = await embedText("SQLite 怎么部署");
  const hits = store.similaritySearch(query.vector, { limit: 3, model: query.model });
  check("search returns hits", hits.length > 0, String(hits.length));
  check("sqlite row ranks first", hits[0]?.row.content.includes("SQLite"), hits[0]?.row.content);
  check("scores sorted desc", hits.every((hit, i) => i === 0 || hits[i - 1].score >= hit.score));
  check("never returns non-active rows", hits.every((hit) => hit.row.status === "active"));

  // Different embedding spaces must not be compared.
  const foreign = store.similaritySearch(query.vector, { limit: 3, model: "some-other-model" });
  check("foreign model yields nothing", foreign.length === 0, String(foreign.length));

  // Thread scoping: a row from another thread must not leak into this one.
  store.apply({ action: "create", category: "fact", key: "thread.fact", content: "这个会话专属的事实", importance: 3, thread: "feishu:oc_a" });
  const scoped = store.needingEmbedding(10);
  for (const item of scoped) {
    const embedded = await embedText(item.text);
    store.setEmbedding(item.id, embedded.vector, embedded.model);
  }
  const otherThread = store.similaritySearch(query.vector, { limit: 10, model: query.model, thread: "feishu:oc_b" });
  check("thread filter excludes other threads", otherThread.every((hit) => hit.row.thread !== "feishu:oc_a"));

  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* Windows keeps the WAL handle briefly */
  }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
