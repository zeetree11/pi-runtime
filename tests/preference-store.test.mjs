import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { MemoryStore } from "../src/memory.ts";
import { resolvePreferences, violations } from "../src/preference.ts";

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

const dir = mkdtempSync(path.join(tmpdir(), "pi-pref-store-"));
const store = new MemoryStore(dir, "Rick");

// 1) THE scenario: same preference slot, different keys, later statement wins
store.apply({ action: "create", category: "preference", key: "pref.language", content: "我喜欢用 python 写代码", importance: 4 });
const before = store.active().filter((row) => row.category === "preference");
check("first preference is active", before.length === 1 && before[0].content.includes("python"), JSON.stringify(before.map((r) => r.content)));

store.apply({ action: "create", category: "preference", key: "pref.lang2", content: "以后都用 C++ 写代码", importance: 4 });

const after = store.active().filter((row) => row.category === "preference");
check("only one active preference remains", after.length === 1, JSON.stringify(after.map((r) => `${r.key}:${r.content}`)));
check("the newer one is active", after[0]?.content.includes("C++"), after[0]?.content);
check("the older one is kept as history", store.history("pref.language").some((row) => row.status === "superseded"), JSON.stringify(store.history("pref.language").map((r) => r.status)));

// 2) a reply that still uses the old value is detectable
// The guard needs history too: after the store retires the old row it is no longer "active",
// so the contradiction can only be seen by resolving over active + superseded rows together.
const resolved = resolvePreferences([
  ...store.active(),
  ...store.history("pref.language"),
]);
const bad = violations("好，我用 Python 实现。", resolved);
check("stale python detected", bad.length === 1, JSON.stringify(bad));
check("points to the c++ row", bad[0]?.currentValue === "c++", JSON.stringify(bad[0]));
check("compliant reply is clean", violations("好，我用 C++ 实现。", resolved).length === 0);

// 3) unrelated preferences are untouched
store.apply({ action: "create", category: "preference", key: "pref.editor", content: "用 vscode", importance: 3 });
const withEditor = store.active().filter((row) => row.category === "preference");
check("editor added alongside language", withEditor.length === 2, JSON.stringify(withEditor.map((r) => r.key)));

// 4) other categories never trigger slot retirement
store.apply({ action: "create", category: "fact", key: "note.lang", content: "公司项目用 python", importance: 3 });
check("fact row does not retire the preference", store.active().filter((row) => row.category === "preference").length === 2);

try { rmSync(dir, { recursive: true, force: true }); } catch { /* Windows handle */ }

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
