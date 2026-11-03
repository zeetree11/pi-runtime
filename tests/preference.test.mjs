import { precedenceNote, resolvePreferences, slotOf, valuesIn, violations } from "../src/preference.ts";

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

const row = (key, content, updatedAt, extra = {}) => ({
  id: 1,
  key,
  content,
  category: "preference",
  subject: "Rick",
  updatedAt,
  evidenceEventId: 1,
  ...extra,
});

// 1) slot detection routes related statements together
{
  check("language slot", slotOf("我喜欢用 python") === "language");
  check("c++ also language", slotOf("以后用 C++ 写") === "language");
  check("editor slot", slotOf("我用 vscode") === "editor");
  check("unrelated stays other", slotOf("住在成都") === "other");
}

// 2) value extraction knows the synonyms a reply might use
{
  check("cpp detected", valuesIn("用 cpp 写").includes("c++"), JSON.stringify(valuesIn("用 cpp 写")));
  check("python detected", valuesIn("Python 更好").includes("python"));
  check("both detected", valuesIn("python 还是 c++").length === 2);
}

// 3) THE case: newer preference wins, older is marked outdated
{
  const rows = [
    row("pref.language", "我喜欢用 python", "2026-10-01T00:00:00Z", { id: 1, evidenceEventId: 11 }),
    row("pref.lang2", "以后都用 C++ 写代码", "2026-11-02T00:00:00Z", { id: 2, evidenceEventId: 42 }),
  ];
  const resolved = resolvePreferences(rows);
  check("one current preference", resolved.current.length === 1, String(resolved.current.length));
  check("newest is current", resolved.current[0].content.includes("C++"), resolved.current[0].content);
  check("older is outdated", resolved.outdated.length === 1 && resolved.outdated[0].content.includes("python"));

  // 4) a reply using the stale value is flagged, with the correct target attached
  const bad = violations("好的，我会用 Python 写这个脚本。", resolved);
  check("stale usage flagged", bad.length === 1, JSON.stringify(bad));
  check("points at the current value", bad[0]?.currentValue === "c++", bad[0]?.currentValue);
  check("carries the evidence event", bad[0]?.currentEventId === 42, String(bad[0]?.currentEventId));

  const good = violations("好的，我用 C++ 写。", resolved);
  check("using the current value is fine", good.length === 0, JSON.stringify(good));

  const neutral = violations("这个需求我可以做。", resolved);
  check("no value mentioned, no flag", neutral.length === 0, JSON.stringify(neutral));
}

// 5) same value repeated is not a contradiction
{
  const rows = [
    row("pref.lang", "喜欢 python", "2026-10-01T00:00:00Z"),
    row("pref.lang", "还是喜欢 python", "2026-11-01T00:00:00Z"),
  ];
  const resolved = resolvePreferences(rows);
  check("same value repeated is not flagged", violations("用 Python 吧", resolved).length === 0);
}

// 6) different slots never compete
{
  const rows = [
    row("pref.language", "用 python", "2026-10-01T00:00:00Z"),
    row("pref.editor", "用 vscode", "2026-11-01T00:00:00Z"),
  ];
  const resolved = resolvePreferences(rows);
  check("two slots both current", resolved.current.length === 2, String(resolved.current.length));
  check("nothing outdated across slots", resolved.outdated.length === 0);
}

// 7) the prompt note names the slot and the date
{
  const resolved = resolvePreferences([
    row("pref.language", "以后用 C++", "2026-11-02T00:00:00Z", { evidenceEventId: 42 }),
  ]);
  const note = precedenceNote(resolved);
  check("note mentions the slot", note.includes("language"), note);
  check("note mentions the date", note.includes("2026-11-02"), note);
  check("note mentions the value", note.includes("C++"), note);
  check("empty resolution yields empty note", precedenceNote({ current: [], outdated: [] }) === "");
}

// 8) non-preference rows are ignored entirely
{
  const resolved = resolvePreferences([
    { ...row("project.db", "用 sqlite", "2026-11-01T00:00:00Z"), category: "fact" },
  ]);
  check("facts do not enter preference resolution", resolved.current.length === 0);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
