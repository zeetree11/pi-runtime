#!/usr/bin/env node
/**
 * Recall A/B: same fixture, two embedding spaces.
 *
 *   baseline  hash-256 (what production runs today)
 *   candidate bge-m3 via an OpenAI-compatible endpoint
 *
 * Same brute-force cosine and same top-k on both sides, so the only variable is the embedding.
 * That is the whole point — swapping the retriever and the embedder at once would leave us unable
 * to say which one moved the number.
 *
 * Usage: node scripts/ab-recall.mjs [--fixture bench/recall.json]
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { embedText } from "../mcp/lib/embed.mjs";
import { MemoryStore } from "../src/memory.ts";
import { literalBaseline, scoreRecall } from "../src/bench.ts";

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const index = args.indexOf(`--${name}`);
  return index === -1 ? fallback : args[index + 1];
};

const fixture = JSON.parse(readFileSync(flag("fixture", "bench/recall.json"), "utf8"));
const BASE = process.env.MEM0_EMBED_BASE_URL;
const KEY = process.env.MEM0_EMBED_API_KEY;
const MODEL = process.env.MEM0_EMBED_MODEL ?? "BAAI/bge-m3";
const K = 5;

async function remoteEmbed(texts) {
  const response = await fetch(`${BASE.replace(/\/$/, "")}/embeddings`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${KEY}` },
    body: JSON.stringify({ model: MODEL, input: texts }),
  });
  if (!response.ok) throw new Error(`embedding ${response.status}: ${(await response.text()).slice(0, 160)}`);
  const payload = await response.json();
  return payload.data.map((item) => new Float32Array(item.embedding));
}

async function run(engine) {
  const dir = mkdtempSync(path.join(tmpdir(), `ab-${engine}-`));
  const store = new MemoryStore(dir, "bench");
  try {
    const texts = fixture.memories.map((memory) => memory.content);
    let vectors;
    let model;
    if (engine === "bge") {
      const started = Date.now();
      vectors = await remoteEmbed(texts);
      model = MODEL;
      console.log(`  bge 建库 ${texts.length} 条，耗时 ${Date.now() - started}ms`);
    } else {
      vectors = [];
      for (const text of texts) {
        const embedded = await embedText(text);
        vectors.push(embedded.vector);
        model = embedded.model;
      }
    }

    for (const [index, memory] of fixture.memories.entries()) {
      const result = store.apply({ action: "create", category: memory.category, key: memory.key, content: memory.content, importance: 3 });
      if (typeof result.id === "number") store.setEmbedding(result.id, vectors[index], model);
    }

    const queryVectors = engine === "bge"
      ? await remoteEmbed(fixture.queries.map((query) => query.q))
      : await Promise.all(fixture.queries.map(async (query) => (await embedText(query.q)).vector));

    const runs = fixture.queries.map((query, index) => ({
      q: query.q,
      expected: query.expect,
      got: store
        .similaritySearch(queryVectors[index], { limit: K, model, minScore: engine === "bge" ? 0.3 : 0.05 })
        .map((hit) => hit.row.key),
    }));
    return { metrics: scoreRecall(runs, K), model, runs };
  } finally {
    store.close();
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* Windows handle */ }
  }
}

const pct = (value) => `${(value * 100).toFixed(1)}%`;
console.log(`fixture: ${fixture.memories.length} 条记忆 × ${fixture.queries.length} 个查询，top-${K}\n`);

console.log("hash-256（线上）:");
const hashResult = await run("hash");
console.log("关键词基线:");
const baseline = scoreRecall(
  fixture.queries.map((query) => ({ q: query.q, expected: query.expect, got: literalBaseline(query.q, fixture.memories, K) })),
  K,
);

let bgeResult = null;
if (BASE && KEY) {
  console.log(`bge-m3（${MODEL}）:`);
  bgeResult = await run("bge");
} else {
  console.log("跳过 bge：没有设置 MEM0_EMBED_BASE_URL / MEM0_EMBED_API_KEY");
}

const rows = [
  ["hash-256", hashResult.metrics],
  ["关键词基线", baseline],
  ...(bgeResult ? [[MODEL, bgeResult.metrics]] : []),
];
console.log("\n| 方案 | hit@5 | recall@5 | precision@5 | MRR | 误命中 |");
console.log("|---|---|---|---|---|---|");
for (const [label, metrics] of rows) {
  console.log(`| ${label} | ${pct(metrics.hitRate)} | ${pct(metrics.recallAtK)} | ${pct(metrics.precisionAtK)} | ${metrics.mrr.toFixed(2)} | ${metrics.falsePositives} |`);
}

if (bgeResult) {
  const delta = bgeResult.metrics.recallAtK - hashResult.metrics.recallAtK;
  console.log(`\nbge-m3 相对 hash：recall@5 ${delta >= 0 ? "+" : ""}${(delta * 100).toFixed(1)} 个百分点`);
  const misses = bgeResult.runs.filter((run) => !run.expected.some((key) => run.got.slice(0, K).includes(key)));
  if (misses.length) {
    console.log(`\nbge 未命中 ${misses.length} 条：`);
    for (const miss of misses.slice(0, 10)) console.log(`- 「${miss.q}」期望 ${miss.expected.join(",")}，实际 ${miss.got.join(",") || "（空）"}`);
  }
}
