import { LoopGuard, extractArgs, fingerprint, stableStringify } from "../src/loop-guard.ts";

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

// 1) key order must not matter — otherwise the same call looks like progress
{
  const a = fingerprint("read", { path: "/x", limit: 10 });
  const b = fingerprint("read", { limit: 10, path: "/x" });
  check("fingerprint ignores key order", a === b, `${a} vs ${b}`);
  check("different args differ", fingerprint("read", { path: "/x" }) !== fingerprint("read", { path: "/y" }));
  check("different tools differ", fingerprint("read", {}) !== fingerprint("write", {}));
  check("missing args is explicit", fingerprint("ls").endsWith("#noargs"), fingerprint("ls"));
  check("long payload is hashed short", fingerprint("write", { body: "x".repeat(10_000) }).length < 40);
}

// 2) stableStringify basics
{
  check("nested arrays stable", stableStringify({ a: [1, { b: 2 }] }) === '{"a":[1,{"b":2}]}');
  check("undefined keys dropped", stableStringify({ a: 1, b: undefined }) === '{"a":1}');
  check("null stays null", stableStringify(null) === "null");
}

// 3) warn then abort on a stuck streak
{
  const guard = new LoopGuard({ warnAfter: 3, abortAfter: 5 });
  const levels = [];
  for (let i = 0; i < 5; i += 1) levels.push(guard.observe("read", { path: "/same" }).level);
  check("first call is ok", levels[0] === "ok", levels[0]);
  check("warns once at threshold", levels[1] === "ok" && levels[2] === "warn", levels.join(","));
  check("does not warn twice", levels[3] === "ok", levels[3]);
  check("aborts at abortAfter", levels[4] === "abort", levels[4]);
}

// 4) a different call resets the streak
{
  const guard = new LoopGuard({ warnAfter: 3, abortAfter: 5 });
  guard.observe("read", { path: "/same" });
  guard.observe("read", { path: "/same" });
  const reset = guard.observe("read", { path: "/other" });
  check("different args reset the streak", reset.count === 1 && reset.level === "ok", JSON.stringify(reset));
  const again = guard.observe("read", { path: "/same" });
  check("streak restarts from one", again.count === 1 && again.level === "ok", JSON.stringify(again));
}

// 5) abort carries a reason and keeps a history for diagnosis
{
  const guard = new LoopGuard({ warnAfter: 2, abortAfter: 3 });
  guard.observe("bash", { cmd: "curl x" });
  guard.observe("bash", { cmd: "curl x" });
  const decision = guard.observe("bash", { cmd: "curl x" });
  check("abort has a reason", decision.level === "abort" && /循环/.test(decision.reason ?? ""), decision.reason);
  check("history records attempts", guard.seen.length === 3, String(guard.seen.length));
  check("history is capped", guard.seen.length <= 50);
}

// 6) history limit actually trims
{
  const guard = new LoopGuard({ warnAfter: 100, abortAfter: 101, historyLimit: 8 });
  for (let i = 0; i < 20; i += 1) guard.observe("read", { i });
  check("history capped at limit", guard.seen.length === 8, String(guard.seen.length));
}

// 7) reset clears state
{
  const guard = new LoopGuard({ warnAfter: 2, abortAfter: 3 });
  guard.observe("read", {});
  guard.observe("read", {});
  guard.reset();
  check("reset clears streak", guard.seen.length === 0);
  check("after reset first call is ok", guard.observe("read", {}).level === "ok");
}

// 8) argument field names used by different event shapes
{
  check("reads input", extractArgs({ input: { a: 1 } }) !== undefined);
  check("reads arguments", extractArgs({ arguments: { a: 1 } }) !== undefined);
  check("reads toolInput", extractArgs({ toolInput: { a: 1 } }) !== undefined);
  check("missing args is undefined", extractArgs({ toolName: "read" }) === undefined);
}

// 9) realistic sequence: a healthy run must not trip the guard
{
  const guard = new LoopGuard();
  const sequence = [
    ["read", { path: "/a" }],
    ["grep", { pattern: "x" }],
    ["read", { path: "/b" }],
    ["edit", { path: "/b", old: "x", new: "y" }],
    ["bash", { cmd: "npm test" }],
    ["read", { path: "/b" }],
  ];
  const levels = sequence.map(([tool, args]) => guard.observe(tool, args).level);
  check("healthy run never warns", levels.every((level) => level === "ok"), levels.join(","));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
