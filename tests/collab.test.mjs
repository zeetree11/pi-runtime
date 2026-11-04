import { Integrator, conflictReport, mergeOrder, overlaps } from "../src/collab.ts";
import { FileLockStore } from "../src/file-lock.ts";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

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

const change = (taskId, extra = {}) => ({ taskId, branch: `agent/${taskId}`, baseline: "abc123", deps: [], files: [], ...extra });

// 1) 依赖顺序，且同层稳定排序
{
  const order = mergeOrder([change("b", { deps: ["a"] }), change("a"), change("c", { deps: ["b"] })]);
  check("dependency order respected", order.join(",") === "a,b,c", order.join(","));

  const stable = mergeOrder([change("z"), change("a"), change("m")]);
  check("same layer sorts deterministically", stable.join(",") === "a,m,z", stable.join(","));
}

// 2) 环会被识别为无法排序
{
  const cyclic = mergeOrder([change("a", { deps: ["b"] }), change("b", { deps: ["a"] })]);
  check("cycle is not silently ordered", cyclic.length === 0, JSON.stringify(cyclic));
}

// 3) 文件重叠可被提前发现
{
  const shared = overlaps([
    change("a", { files: ["src/x.ts", "README.md"] }),
    change("b", { files: ["src/x.ts"] }),
    change("c", { files: ["src/y.ts"] }),
  ]);
  check("shared file reported", shared.join(",") === "src/x.ts", JSON.stringify(shared));
  check("unique files are not reported", !shared.includes("src/y.ts"));
}

// 4) 基线不匹配时拒绝合并（目标分支在背后前进了）
{
  const integrator = new Integrator({ target: "main", head: "abc123" });
  const ok = integrator.plan([change("a"), change("b")]);
  check("matching baseline merges", ok.ok === true && ok.order.join(",") === "a,b", JSON.stringify(ok));

  const stale = integrator.plan([change("a"), change("b", { baseline: "old999" })]);
  check("stale baseline refused", stale.ok === false, JSON.stringify(stale));
  check("refusal names the stale task", stale.ok === false && stale.conflicts.join(",") === "b", JSON.stringify(stale));
  check("refusal explains why", stale.ok === false && /基线过期/.test(stale.reason), stale.ok === false ? stale.reason : "");
}

// 5) 有环时也拒绝
{
  const integrator = new Integrator({ target: "main", head: "abc123" });
  const decision = integrator.plan([change("a", { deps: ["b"] }), change("b", { deps: ["a"] })]);
  check("cycle refused by integrator", decision.ok === false && /依赖无法排序/.test(decision.reason), JSON.stringify(decision));
}

// 6) 热点文件：识别 + 租约串行
{
  const dir = mkdtempSync(path.join(tmpdir(), "pi-collab-"));
  const locks = new FileLockStore(dir, 1);
  const integrator = new Integrator({ target: "main", head: "abc123", hotFiles: ["pnpm-lock.yaml"], locks });

  const hot = integrator.hotConflicts([change("a", { files: ["pnpm-lock.yaml"] }), change("b", { files: ["src/a.ts"] })]);
  check("hot file detected", hot.join(",") === "pnpm-lock.yaml", JSON.stringify(hot));

  check("integrator takes the lease", integrator.acquireHot("pnpm-lock.yaml") === true);
  // 同一个 integrator 重入是续租；真正要防的是另一个 integrator 同时抢
  const other = new Integrator({ target: "release", head: "abc123", hotFiles: ["pnpm-lock.yaml"], locks });
  check("another integrator is refused while held", other.acquireHot("pnpm-lock.yaml") === false);

  try { rmSync(dir, { recursive: true, force: true }); } catch { /* Windows handle */ }
}

// 7) 冲突交回给对应 agent，而不是自己修
{
  const report = conflictReport({ taskId: "b", file: "src/x.ts", head: "def4567", failingCheck: "pnpm test" });
  check("report targets the owning task", report.taskId === "b");
  check("instructions mention the file", report.instructions.includes("src/x.ts"));
  check("instructions say to redo on the new base", report.instructions.includes("最新基线"));
  check("failing check is carried", report.instructions.includes("pnpm test"));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
