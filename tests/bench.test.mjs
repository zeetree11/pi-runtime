import { literalBaseline, scoreRecall, formatReport } from "../src/bench.ts";

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

// 1) metrics arithmetic
{
  const perfect = scoreRecall([
    { expected: ["a"], got: ["a", "b"] },
    { expected: ["c"], got: ["c", "d"] },
  ]);
  check("perfect hit rate", perfect.hitRate === 1);
  check("perfect recall", perfect.recallAtK === 1);
  check("perfect MRR", perfect.mrr === 1);
  check("precision penalised by extra hits", Math.abs(perfect.precisionAtK - 0.5) < 1e-9, String(perfect.precisionAtK));

  const miss = scoreRecall([{ expected: ["z"], got: ["a", "b"] }]);
  check("miss has zero hit rate", miss.hitRate === 0);
  check("miss counted as false positive", miss.falsePositives === 2, String(miss.falsePositives));
  check("miss has zero MRR", miss.mrr === 0);

  const partial = scoreRecall([{ expected: ["a", "b"], got: ["b"] }]);
  check("partial recall is fractional", partial.recallAtK === 0.5, String(partial.recallAtK));

  const ranked = scoreRecall([{ expected: ["a"], got: ["x", "a"] }]);
  check("rank 2 gives MRR 0.5", ranked.mrr === 0.5, String(ranked.mrr));

  const cut = scoreRecall([{ expected: ["a"], got: ["x", "y", "a"] }], 2);
  check("k truncates", cut.hitRate === 0, String(cut.hitRate));

  const empty = scoreRecall([]);
  check("empty run does not divide by zero", empty.hitRate === 0 && empty.mrr === 0);
}

// 2) literal baseline behaves like a baseline
{
  const memories = [
    { key: "project.db", category: "fact", content: "runtime 用 SQLite 单机部署" },
    { key: "user.city", category: "fact", content: "住在成都" },
    { key: "pref.reply", category: "preference", content: "回复要短" },
  ];
  check("matches on shared token", literalBaseline("SQLite 部署在哪", memories).includes("project.db"));
  check("unrelated query returns nothing", literalBaseline("天气怎么样", memories).length === 0);
  check("respects k", literalBaseline("SQLite 成都 短", memories, 1).length === 1);
}

// 3) report rendering
{
  const metrics = scoreRecall([{ q: "查询一", expected: ["a"], got: ["a"] }]);
  const rendered = formatReport({ recall: metrics, baseline: metrics, memories: 3, queries: 1, model: "hash-256" });
  check("report names the model", rendered.includes("hash-256"));
  check("report has a table", rendered.includes("| 方案 |"));
  check("report shows both rows", rendered.includes("embedding 检索") && rendered.includes("关键词基线"));
  check("no misses means no miss section", !rendered.includes("未命中"));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
