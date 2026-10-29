#!/usr/bin/env node
/**
 * Benchmark runner.
 *
 * Scope: the layers that do not need a model call, because those are the ones that can run in CI
 * on every commit and never flake. A benchmark whose result changes between runs without any code
 * change teaches nothing — you cannot tell a regression from noise.
 *
 * Layers implemented here:
 *   1. recall    — seeded memories + queries with known answers → recall@k / precision@k / MRR
 *   2. budget    — context packer honours the character budget and never drops a frozen segment
 *   3. ablation  — recall with embeddings vs. literal key matching, reported side by side
 *
 * Layers that need a model (end-to-end task success, tool choice) stay in `eval.ts`; they are run
 * by hand because each case costs tokens and their variance is part of the measurement.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { embedText } from "../mcp/lib/embed.mjs";
import { MemoryStore } from "../src/memory.ts";

export type RecallCase = { q: string; expect: string[] };
export type SeedMemory = { key: string; category: "preference" | "fact" | "event"; content: string };

export type RecallMetrics = {
  /** Queries where at least one expected key landed in the top k. */
  hitRate: number;
  recallAtK: number;
  precisionAtK: number;
  mrr: number;
  /** Retrieved keys that nobody expected — the noise floor of the retriever. */
  falsePositives: number;
  perQuery: Array<{ q: string; expected: string[]; got: string[]; hit: boolean; rank: number }>;
};

/** Compute the standard retrieval metrics for one run. Pure: no db, no model. */
export function scoreRecall(runs: Array<{ q?: string; expected: string[]; got: string[] }>, k = 5): RecallMetrics {
  let hits = 0;
  let recallSum = 0;
  let precisionSum = 0;
  let mrrSum = 0;
  let falsePositives = 0;
  const perQuery: RecallMetrics["perQuery"] = [];

  for (const run of runs) {
    const top = run.got.slice(0, k);
    const expected = run.expected;
    const found = expected.filter((key) => top.includes(key));
    const rank = expected.map((key) => top.indexOf(key)).filter((index) => index >= 0).sort((a, b) => a - b)[0] ?? -1;

    const hit = found.length > 0;
    if (hit) hits += 1;
    recallSum += expected.length === 0 ? 0 : found.length / expected.length;
    precisionSum += top.length === 0 ? 0 : found.length / top.length;
    if (rank >= 0) mrrSum += 1 / (rank + 1);
    falsePositives += top.filter((key) => !expected.includes(key)).length;

    perQuery.push({ q: run.q ?? "", expected, got: top, hit, rank });
  }

  const n = Math.max(1, runs.length);
  return {
    hitRate: hits / n,
    recallAtK: recallSum / n,
    precisionAtK: precisionSum / n,
    mrr: mrrSum / n,
    falsePositives,
    perQuery,
  };
}

/**
 * Baseline: keyword overlap, no embeddings.
 *
 * This is the comparison that makes the vector number meaningful. Without it, "recall@5 = 0.62"
 * says nothing — 0.62 might be worse than simply matching words.
 */
export function literalBaseline(queryText: string, memories: SeedMemory[], k = 5): string[] {
  const tokens = tokenize(queryText);
  const scored = memories.map((memory) => {
    const haystack = normalize(memory.content + " " + memory.key);
    const score = tokens.reduce((sum, token) => (haystack.includes(token) ? sum + 1 : sum), 0);
    return { key: memory.key, score };
  });
  return scored
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, k)
    .map((item) => item.key);
}

function normalize(text: string): string {
  return String(text ?? "").toLowerCase();
}

/** Character bigrams for CJK, words for latin. Crude on purpose: it is a *baseline*. */
function tokenize(text: string): string[] {
  const tokens = new Set<string>();
  for (const word of normalize(text).split(/[^a-z0-9\u4e00-\u9fa5]+/)) {
    if (!word) continue;
    if (/^[a-z0-9]+$/.test(word)) {
      if (word.length >= 2) tokens.add(word);
      continue;
    }
    for (let i = 0; i < word.length - 1; i += 1) tokens.add(word.slice(i, i + 2));
  }
  return [...tokens];
}

export type BenchReport = {
  recall: RecallMetrics;
  baseline: RecallMetrics;
  memories: number;
  queries: number;
  model: string;
};

/** Build a throwaway store, embed the seeds, and score both retrievers on the same queries. */
export async function runRecallBench(input: {
  memories: SeedMemory[];
  queries: RecallCase[];
  k?: number;
}): Promise<BenchReport> {
  const k = input.k ?? 5;
  const dir = mkdtempSync(path.join(tmpdir(), "pi-bench-"));
  const store = new MemoryStore(dir, "bench");
  let model = "";
  try {
    for (const memory of input.memories) {
      const result = store.apply({
        action: "create",
        category: memory.category,
        key: memory.key,
        content: memory.content,
        importance: 3,
      });
      if (typeof result.id !== "number") continue;
      const embedded = await embedText(memory.content);
      model = embedded.model;
      store.setEmbedding(result.id, embedded.vector, embedded.model);
    }

    const vectorRuns: Array<{ expected: string[]; got: string[] }> = [];
    const literalRuns: Array<{ expected: string[]; got: string[] }> = [];
    for (const query of input.queries) {
      const embedded = await embedText(query.q);
      const hits = store.similaritySearch(embedded.vector, { limit: k, model: embedded.model, minScore: 0.05 });
      const got = hits.map((hit) => hit.row.key);
      vectorRuns.push({ q: query.q, expected: query.expect, got });
      literalRuns.push({ q: query.q, expected: query.expect, got: literalBaseline(query.q, input.memories, k) });
    }

    return {
      recall: scoreRecall(vectorRuns, k),
      baseline: scoreRecall(literalRuns, k),
      memories: input.memories.length,
      queries: input.queries.length,
      model: model || "(none)",
    };
  } finally {
    store.close();
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* Windows keeps the WAL handle */ }
  }
}

export function formatReport(report: BenchReport): string {
  const pct = (value: number) => `${(value * 100).toFixed(1)}%`;
  const rows = [
    ["embedding 检索", report.recall],
    ["关键词基线", report.baseline],
  ] as const;
  const lines = [
    `记忆 ${report.memories} 条 · 查询 ${report.queries} 条 · 模型 ${report.model}`,
    "",
    "| 方案 | hit@5 | recall@5 | precision@5 | MRR | 误命中 |",
    "|---|---|---|---|---|---|",
    ...rows.map(
      ([label, metrics]) =>
        `| ${label} | ${pct(metrics.hitRate)} | ${pct(metrics.recallAtK)} | ${pct(metrics.precisionAtK)} | ${metrics.mrr.toFixed(2)} | ${metrics.falsePositives} |`,
    ),
    "",
  ];
  const misses = report.recall.perQuery.filter((item) => !item.hit);
  if (misses.length > 0) {
    lines.push(`未命中 ${misses.length} 条：`);
    for (const miss of misses) {
      lines.push(`- 「${miss.q}」期望 ${miss.expected.join(",")}，实际 ${miss.got.join(",") || "（空）"}`);
    }
  }
  return lines.join("\n");
}
