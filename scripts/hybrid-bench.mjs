import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { MemoryStore } from "/app/src/memory.ts";
import { scoreRecall } from "/app/src/bench.ts";
import { bm25, rrf, rerank } from "/app/src/hybrid.ts";

const fx = JSON.parse(readFileSync("/app/bench/recall.json", "utf8"));
const BASE = process.env.MEM0_EMBED_BASE_URL;
const KEY = process.env.MEM0_EMBED_API_KEY;
const MODEL = process.env.MEM0_EMBED_MODEL;

const embed = async (texts) => {
  const r = await fetch(`${BASE}/embeddings`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${KEY}` },
    body: JSON.stringify({ model: MODEL, input: texts }),
  });
  if (!r.ok) throw new Error(await r.text());
  return (await r.json()).data.map((d) => new Float32Array(d.embedding));
};

const dir = mkdtempSync(path.join(tmpdir(), "hy-"));
const store = new MemoryStore(dir, "bench");
const memVecs = await embed(fx.memories.map((m) => m.content));
for (const [i, m] of fx.memories.entries()) {
  const r = store.apply({ action: "create", category: m.category, key: m.key, content: m.content, importance: 3 });
  if (typeof r.id === "number") store.setEmbedding(r.id, memVecs[i], MODEL);
}
const docs = fx.memories.map((m) => ({ key: m.key, text: m.content }));
const qVecs = await embed(fx.queries.map((q) => q.q));

const vectorTop = (i, limit, minScore) =>
  store.similaritySearch(qVecs[i], { limit, model: MODEL, minScore }).map((h) => h.row.key);
const lexTop = (i, limit) => bm25(fx.queries[i].q, docs).slice(0, limit).map((h) => h.key);

const rows = [];
const addRow = (label, runs) => rows.push([label, scoreRecall(runs, 5)]);

addRow("向量 top-5（线上）", fx.queries.map((q, i) => ({ q: q.q, expected: q.expect, got: vectorTop(i, 5, 0.55) })));
addRow("向量 top-20（候选池 0.3）", fx.queries.map((q, i) => ({ q: q.q, expected: q.expect, got: vectorTop(i, 20, 0.3) })));
addRow("BM25 top-5", fx.queries.map((q, i) => ({ q: q.q, expected: q.expect, got: lexTop(i, 5) })));
addRow("向量+BM25（RRF）", fx.queries.map((q, i) => ({
  q: q.q,
  expected: q.expect,
  got: rrf([vectorTop(i, 20, 0.3), lexTop(i, 20)]).slice(0, 5).map((h) => h.key),
})));

{
  const runs = [];
  let failed = 0;
  for (const [i, q] of fx.queries.entries()) {
    const fused = rrf([vectorTop(i, 20, 0.3), lexTop(i, 20)]).slice(0, 10).map((h) => h.key);
    const candidateDocs = fused.map((key) => docs.find((d) => d.key === key)).filter(Boolean);
    const ordered = await rerank(q.q, candidateDocs, { baseURL: BASE, apiKey: KEY, model: "BAAI/bge-reranker-v2-m3" });
    if (!ordered) {
      failed += 1;
      runs.push({ q: q.q, expected: q.expect, got: fused.slice(0, 5) });
      continue;
    }
    runs.push({ q: q.q, expected: q.expect, got: ordered.slice(0, 5).map((h) => h.key) });
  }
  if (failed) console.log(`(重排失败 ${failed} 次，已回退融合顺序)`);
  addRow("向量+BM25+重排", runs);
}

const pct = (v) => `${(v * 100).toFixed(0)}%`;
console.log("\n| 配置 | hit@5 | recall@5 | precision@5 | MRR | 误命中 |");
console.log("|---|---|---|---|---|---|");
for (const [label, m] of rows) {
  console.log(`| ${label} | ${pct(m.hitRate)} | ${pct(m.recallAtK)} | ${pct(m.precisionAtK)} | ${m.mrr.toFixed(2)} | ${m.falsePositives} |`);
}
store.close();
try { rmSync(dir, { recursive: true, force: true }); } catch {}
