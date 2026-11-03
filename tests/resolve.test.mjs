import { TIE_EPSILON, resolveCollision, scoreCandidate } from "../src/resolve.ts";

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

const NOW = new Date("2026-11-03T00:00:00Z");
const daysAgo = (days) => new Date(NOW.getTime() - days * 86_400_000).toISOString();

const row = (id, content, days, extra = {}) => ({
  id,
  key: `k${id}`,
  content,
  category: "fact",
  subject: "Rick",
  evidenceEventId: 100 + id,
  updatedAt: daysAgo(days),
  createdAt: daysAgo(days),
  ...extra,
});

// 1) the exact scenario: old-but-confident vs new-but-thin
{
  const rows = [
    row(1, "项目用 SQLite 单机部署", 400),
    row(2, "项目改用 Postgres 了", 3),
  ];
  const resolved = resolveCollision(rows, { now: NOW });
  check("newer fact wins", resolved.winner?.row.id === 2, JSON.stringify(resolved.winner?.row.id));
  check("older is a runner-up", resolved.runners.some((item) => item.row.id === 1));
  check("not contested", resolved.contested === false);
  check("reason mentions both factors", /可信度/.test(resolved.reason) && /时效/.test(resolved.reason), resolved.reason);
}

// 2) a confident claim can still beat a fresh vague one
{
  const rows = [
    row(3, "记住：部署在阿里云", 10, { category: "fact" }),
    row(4, "可能大概是部署在别的地方吧", 1, { category: "fact" }),
  ];
  const resolved = resolveCollision(rows, { now: NOW, confirmations: 3 });
  check("confidence matters too", resolved.winner?.row.id === 3, JSON.stringify({ id: resolved.winner?.row.id, score: resolved.winner?.score }));
  check("hedged text loses points", (resolved.runners[0]?.credibility ?? 1) < (resolved.winner?.credibility ?? 0), `${resolved.runners[0]?.credibility} vs ${resolved.winner?.credibility}`);
}

// 3) preferences: old ones decay too, but slower
{
  const rows = [
    row(5, "喜欢用 python", 200, { category: "preference" }),
    row(6, "以后用 C++", 5, { category: "preference" }),
  ];
  const resolved = resolveCollision(rows, { now: NOW });
  check("new preference wins", resolved.winner?.row.id === 6, String(resolved.winner?.row.id));
  // 200 天前说过的话，权重应明显高于 0.5 的一半衰期档（这里是约两年半衰期）→ 0.46 是预期值。
  check("preference decay is mild", (resolved.runners[0]?.recency ?? 0) > 0.4, String(resolved.runners[0]?.recency));
}

// 4) a near tie is reported, not silently decided
{
  const rows = [row(7, "预算是 45 万", 10), row(8, "预算是 45 万左右", 9)];
  const resolved = resolveCollision(rows, { now: NOW });
  check("near tie flagged", resolved.contested === true || Math.abs((resolved.winner?.score ?? 0) - (resolved.runners[0]?.score ?? 0)) > TIE_EPSILON, resolved.reason);
  if (resolved.contested) check("contested reason explains why", /有争议/.test(resolved.reason), resolved.reason);
}

// 5) empty input and single candidate
{
  check("empty yields null winner", resolveCollision([], { now: NOW }).winner === null);
  check("empty says so", /没有候选/.test(resolveCollision([], { now: NOW }).reason));
  const single = resolveCollision([row(9, "只有一条", 30)], { now: NOW });
  check("single is never contested", single.winner?.row.id === 9 && single.contested === false);
}

// 6) the score is decomposable (so it can be explained later)
{
  const candidate = scoreCandidate(row(10, "事实描述", 90), NOW);
  check("score = credibility × recency", Math.abs(candidate.score - candidate.credibility * candidate.recency) < 1e-9);
  check("age is measured in days", Math.round(candidate.ageDays) === 90, String(candidate.ageDays));
  check("factors are human readable", candidate.factors.some((f) => f.includes("时效")), JSON.stringify(candidate.factors));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
