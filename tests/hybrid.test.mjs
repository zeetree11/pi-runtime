import { bm25, rrf, tokenize } from "../src/hybrid.ts";

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

const docs = [
  { key: "project.db", text: "runtime 用 SQLite 单机部署" },
  { key: "event.deadline", text: "这季度末必须交 v2.0" },
  { key: "team.member", text: "王工负责安全评审" },
  { key: "pref.reply", text: "回复要短，群里别超过两句" },
  { key: "habit.coffee", text: "下午三点后不喝咖啡" },
];

// 1) tokenizer: latin words + CJK bigrams, no single hanzi noise
{
  const tokens = tokenize("SQLite 单机部署 v2.0");
  check("latin word kept", tokens.includes("sqlite"), JSON.stringify(tokens));
  check("version kept as token", tokens.some((t) => t.includes("v2")), JSON.stringify(tokens));
  check("cjk bigrams produced", tokens.includes("单机") || tokens.includes("部署"), JSON.stringify(tokens));
  check("punctuation dropped", !tokens.some((t) => /[，。]/.test(t)), JSON.stringify(tokens));
}

// 2) BM25 finds the exact-token match that dense retrieval missed
{
  const hits = bm25("SQLite", docs);
  check("exact token retrieved", hits[0]?.key === "project.db", JSON.stringify(hits));
  check("unrelated docs excluded", hits.length === 1, String(hits.length));

  const deadline = bm25("v2.0 交付", docs);
  check("version query hits deadline", deadline[0]?.key === "event.deadline", JSON.stringify(deadline));
}

// 3) rare tokens beat common ones (idf in action)
{
  const hits = bm25("咖啡", docs);
  check("rare token wins", hits[0]?.key === "habit.coffee", JSON.stringify(hits));
}

// 4) no match means empty, not everything
{
  check("no overlap yields nothing", bm25("完全无关的问题", docs).length === 0);
  check("empty query yields nothing", bm25("", docs).length === 0);
}

// 5) RRF fuses by rank and rewards agreement
{
  const fused = rrf([["a", "b", "c"], ["b", "a", "d"]]);
  check("agreement wins", fused[0].key === "a" || fused[0].key === "b", JSON.stringify(fused));
  check("both lists contribute", fused.some((item) => item.key === "d"), JSON.stringify(fused));
  check("only in one list ranks below agreement", fused.findIndex((i) => i.key === "d") > 0);
  check("empty fusion is empty", rrf([[], []]).length === 0);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
