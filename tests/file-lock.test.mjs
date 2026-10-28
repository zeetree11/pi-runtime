import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { FileLockStore, detectConflicts, hashFiles } from "../src/file-lock.ts";

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

// 1) path normalisation: one key per file, however it is written
{
  check("relative stays relative", FileLockStore.normalize("src/a.ts") === "src/a.ts");
  check("absolute becomes relative", FileLockStore.normalize("/workspace/src/a.ts") === "src/a.ts");
  check("dot slash removed", FileLockStore.normalize("./src/a.ts") === "src/a.ts");
  check("backslashes normalised", FileLockStore.normalize("src\\a.ts") === "src/a.ts");
  check("double slashes collapsed", FileLockStore.normalize("/workspace//src//a.ts") === "src/a.ts");
}

// 2) acquire / conflict / release
{
  const dir = mkdtempSync(path.join(tmpdir(), "pi-lock-"));
  const store = new FileLockStore(dir, 1);

  const first = store.acquire({ path: "src/a.ts", owner: "child1", reason: "编辑" });
  check("first acquire succeeds", first.ok === true, JSON.stringify(first).slice(0, 100));

  const second = store.acquire({ path: "/workspace/src/a.ts", owner: "child2" });
  check("second acquire blocked", second.ok === false, JSON.stringify(second).slice(0, 120));
  check("holder is reported", second.ok === false && second.heldBy.owner === "child1", JSON.stringify(second));

  const same = store.acquire({ path: "src/a.ts", owner: "child1" });
  check("re-acquire by same owner renews", same.ok === true);

  const other = store.acquire({ path: "src/b.ts", owner: "child2" });
  check("different path is independent", other.ok === true);

  check("release by owner works", store.release({ path: "src/a.ts", owner: "child1" }) === true);
  check("release by non-owner does nothing", store.release({ path: "src/b.ts", owner: "child1" }) === false);
  check("lock list shows remaining", store.list().length === 1, String(store.list().length));

  // 3) expiry: a crashed child must not block the others forever
  const expiring = store.acquire({ path: "src/c.ts", owner: "child1", ttlMinutes: 1 });
  check("short lease acquired", expiring.ok === true);
  check("lease expires", store.list(new Date(Date.now() + 2 * 60_000)).length === 0);
  const afterExpiry = store.acquire({ path: "src/c.ts", owner: "child2", now: new Date(Date.now() + 2 * 60_000) });
  check("expired lease can be taken", afterExpiry.ok === true, JSON.stringify(afterExpiry).slice(0, 100));

  try { rmSync(dir, { recursive: true, force: true }); } catch { /* Windows handle */ }
}

// 4) post-hoc conflict detection needs no cooperation
{
  const before = hashFiles([
    { path: "src/a.ts", content: "v1" },
    { path: "src/b.ts", content: "v1" },
    { path: "src/c.ts", content: "v1" },
  ]);
  const after = hashFiles([
    { path: "src/a.ts", content: "v2" }, // changed, locked by child1
    { path: "src/b.ts", content: "v1" }, // unchanged
    { path: "src/c.ts", content: "v2" }, // changed, no lock
  ]);
  const locks = [
    { path: "src/a.ts", owner: "child1", acquiredAt: "", expiresAt: "", reason: null },
  ];

  const conflicts = detectConflicts({ before, after, locks });
  check("locked changed file reported", conflicts.some((c) => c.path === "src/a.ts"), JSON.stringify(conflicts));
  check("unlocked change not reported as conflict", conflicts.every((c) => c.path !== "src/c.ts"));
  check("unchanged file never reported", conflicts.every((c) => c.path !== "src/b.ts"));
  check("new file appears as a change", detectConflicts({
    before: hashFiles([]),
    after: hashFiles([{ path: "src/new.ts", content: "x" }]),
    locks: [{ path: "src/new.ts", owner: "child2", acquiredAt: "", expiresAt: "", reason: null }],
  }).length === 1);
  check("deleted file appears as a change", detectConflicts({
    before: hashFiles([{ path: "src/gone.ts", content: "x" }]),
    after: hashFiles([]),
    locks: [{ path: "src/gone.ts", owner: "child3", acquiredAt: "", expiresAt: "", reason: null }],
  }).length === 1);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
