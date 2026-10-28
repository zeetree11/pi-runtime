import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { MemoryStore } from "../src/memory.ts";
import { scoreConfidence, isInjectable, DISCARD_BELOW, ACTIVE_FROM } from "../src/confidence.ts";

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

// 1) scoring itself
{
  const strong = scoreConfidence({ category: "fact", fromUser: true, text: "用 SQLite 单机部署" });
  check("user quote scores active", strong.status === "active", `${strong.score} ${strong.status}`);

  const hedged = scoreConfidence({ category: "fact", fromUser: true, text: "可能会用 SQLite 吧" });
  check("hedged quote is tentative", hedged.status === "tentative", `${hedged.score} ${hedged.status}`);
  check("hedge is named in factors", hedged.factors.some((f) => f.includes("含糊")), JSON.stringify(hedged.factors));

  const paraphrase = scoreConfidence({ category: "fact", fromUser: false, text: "用 SQLite 单机部署" });
  check("assistant paraphrase is not active", isInjectable(paraphrase) === false, `${paraphrase.score} ${paraphrase.status}`);

  // Age decay is the one path that reaches discard — a stale, never-used fact.
  const stale = scoreConfidence({ category: "fact", fromUser: true, text: "用 SQLite", ageDays: 400 });
  check("stale fact decays toward discard", stale.score < DISCARD_BELOW, `${stale.score}`);
  check("decay is explained", stale.factors.some((f) => f.includes("衰减")), JSON.stringify(stale.factors));

  check("thresholds are ordered", DISCARD_BELOW < ACTIVE_FROM);
}

// 2) the gate inside apply(): only distilled claims are scored
{
  const dir = mkdtempSync(path.join(tmpdir(), "pi-conf-"));

  // Prepared per-store: the store rewrites the `user` subject to the owner name.
  const store = new MemoryStore(dir, "Rick");

  const hedged = store.apply({
    action: "create",
    category: "fact",
    key: "db.engine",
    content: "可能会用 SQLite 吧",
    importance: 3,
    evidenceEventId: 42,
    evidenceQuote: "可能会用 SQLite 吧",
  });
  const row = store.byId ? null : null;
  const all = store.list(undefined, true).find((item) => item.key === "db.engine");
  check("hedged claim stored as tentative", all?.status === "tentative", `${all?.status}`);
  check("tentative is not injected", store.active().some((item) => item.key === "db.engine") === false);
  check("apply still returns a row id", typeof hedged.id === "number", JSON.stringify(hedged).slice(0, 120));

  const strong = store.apply({
    action: "create",
    category: "fact",
    key: "db.note",
    content: "runtime 用 SQLite 单机部署",
    importance: 4,
    evidenceEventId: 43,
    evidenceQuote: "我们用 SQLite",
  });
  const strongRow = store.list(undefined, true).find((item) => item.key === "db.note");
  check("strong claim is active", strongRow?.status === "active", `${strongRow?.status}`);
  check("strong claim is injected", store.active().some((item) => item.key === "db.note") === true);
  check("confidence recorded in note", String(strongRow?.note ?? "").includes("置信度"), String(strongRow?.note));

  // Manual writes are the operator asserting a fact: they bypass the gate on purpose.
  store.apply({ action: "create", category: "preference", key: "manual.one", content: "可能会喜欢简短回答", importance: 3 });
  const manual = store.list(undefined, true).find((item) => item.key === "manual.one");
  check("manual write bypasses the gate", manual?.status === "active", `${manual?.status}`);

  try { rmSync(dir, { recursive: true, force: true }); } catch { /* Windows handle */ }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
