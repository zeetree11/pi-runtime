import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { MemoryStore } from "../src/memory.ts";
import { scoreRecall } from "../src/bench.ts";
import { Mem0Engine, mem0ConfigFromEnv } from "../src/mem0-engine.ts";

const fx = JSON.parse(readFileSync("bench/recall.json", "utf8"));
const cfg = mem0ConfigFromEnv();
if (!cfg) {
  console.error("缺少 MEM0_EMBED_* 配置");
  process.exit(1);
}
const BASE = cfg.baseURL;
const KEY = cfg.apiKey;
const MODEL = cfg.model;

const embed = async (texts) => {
  const r = await fetch(`${BASE}/embeddings`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${KEY}` },
    body: JSON.stringify({ model: MODEL, input: texts }),
  });
  if (!r.ok) throw new Error((await r.text()).slice(0, 200));
  return (await r.json()).data.map((d) => new Float32Array(d.embedding));
};

// 基线：bge-m3 + SQLite 余弦（线上配置）
const dir = mkdtempSync(path.join(tmpdir(), "cmp-"));
const store = new MemoryStore(dir, "bench");
const memVecs = await embed(fx.memories.map((m) => m.content));
for (const [i, m] of fx.memories.entries()) {
  const r = store.apply({ action: "create", category: m.category, key: m.key, content: m.content, importance: 3 });
  if (typeof r.id === "number") store.setEmbedding(r.id, memVecs[i], MODEL);
}
const qVecs = await embed(fx.queries.map((q) => q.q));
const ours = fx.queries.map((q, i) => ({
  q: q.q,
  expected: q.expect,
  got: store.similaritySearch(qVecs[i], { limit: 5, model: MODEL, minScore: 0.55 }).map((h) => h.row.key),
}));

// 实验组：Mem0（进程内 store，同一 bge-m3）
const engine = new Mem0Engine(cfg);
await engine.sync(
  fx.memories.map((m) => ({ key: m.key, content: m.content, subject: "Rick", evidenceEventId: null, updatedAt: "1" })),
);

const mem0Runs = [];
for (const q of fx.queries) {
  const started = Date.now();
  const hits = await engine.recall(q.q, 5);
  mem0Runs.push({ q: q.q, expected: q.expect, got: hits.map((h) => h.key), ms: Date.now() - started });
}

const pct = (v) => `${(v * 100).toFixed(0)}%`;
const oursMetrics = scoreRecall(ours, 5);
const mem0Metrics = scoreRecall(mem0Runs.map(({ q, expected, got }) => ({ q, expected, got })), 5);
const avg = (runs) => Math.round(runs.reduce((sum, r) => sum + (r.ms ?? 0), 0) / runs.length);

console.log("\n| 配置 | hit@5 | recall@5 | precision@5 | MRR | 误命中 | 平均延迟 |");
console.log("|---|---|---|---|---|---|---|");
console.log(`| bge-m3 + SQLite 余弦（线上） | ${pct(oursMetrics.hitRate)} | ${pct(oursMetrics.recallAtK)} | ${pct(oursMetrics.precisionAtK)} | ${oursMetrics.mrr.toFixed(2)} | ${oursMetrics.falsePositives} | 本地 <1ms |`);
console.log(`| bge-m3 + Mem0（进程内） | ${pct(mem0Metrics.hitRate)} | ${pct(mem0Metrics.recallAtK)} | ${pct(mem0Metrics.precisionAtK)} | ${mem0Metrics.mrr.toFixed(2)} | ${mem0Metrics.falsePositives} | ${avg(mem0Runs)}ms |`);

const misses = mem0Runs.filter((run) => !run.expected.some((key) => run.got.includes(key)));
if (misses.length) {
  console.log(`\nMem0 未命中 ${misses.length} 条：`);
  for (const miss of misses.slice(0, 8)) console.log(`- 「${miss.q}」期望 ${miss.expected.join(",")}，实际 ${miss.got.join(",") || "（空）"}`);
}

store.close();
try { rmSync(dir, { recursive: true, force: true }); } catch {}
