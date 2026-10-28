import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { NoteStore, arbitrate, buildFanoutDigest, retryPrompt, shouldRetry } from "../src/fanout.ts";
import { startControlServer } from "../src/api.ts";

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

const note = (key, value, by, minutes = 0) => ({
  scope: "s",
  key,
  value,
  by,
  createdAt: new Date(Date.UTC(2026, 0, 1, 0, minutes)).toISOString(),
});

// 1) arbitration: agreement is silent, disagreement is surfaced
{
  const same = arbitrate([note("db", "SQLite", "a"), note("db", "SQLite", "b", 1)]);
  check("agreement yields one value", same.resolved.length === 1 && same.conflicts.length === 0, JSON.stringify(same.conflicts));

  const clash = arbitrate([note("db", "SQLite", "a"), note("db", "MySQL", "b", 1)]);
  check("disagreement is reported", clash.conflicts.length === 1, String(clash.conflicts.length));
  check("last write wins", clash.conflicts[0]?.winner === "MySQL", clash.conflicts[0]?.winner);
  check("both values kept", clash.conflicts[0]?.values.length === 2, JSON.stringify(clash.conflicts[0]?.values));

  const multi = arbitrate([note("a", "1", "x"), note("b", "2", "y"), note("a", "9", "z", 5)]);
  check("multiple keys resolved", multi.resolved.length === 2, String(multi.resolved.length));
}

// 2) digest: children summarised, notes and conflicts visible
{
  const digest = buildFanoutDigest({
    prompt: "调研三件事",
    results: [
      { title: "调研 A", ok: true, output: "A 的结论", attempts: 1 },
      { title: "调研 B", ok: false, output: "", attempts: 2, error: "超时" },
    ],
    notes: [note("限流", "每分钟 60 次", "1"), note("限流", "每分钟 100 次", "2", 3)],
  });
  check("digest names the original task", digest.includes("调研三件事"));
  check("digest lists children", digest.includes("调研 A") && digest.includes("调研 B"));
  check("failed child shows error", digest.includes("超时"), digest.slice(0, 200));
  check("retry count shown", digest.includes("重试 1 次"), digest);
  check("notes section present", digest.includes("共享的结论"));
  check("conflict section present", digest.includes("冲突"));
  check("child output truncated", buildFanoutDigest({
    prompt: "p",
    results: [{ title: "t", ok: true, output: "x".repeat(5000), attempts: 1 }],
    notes: [],
    maxCharsPerChild: 100,
  }).includes("x".repeat(100)) === true);
}

// 3) retry policy
{
  check("failed once retries", shouldRetry("failed", 1) === true);
  check("failed twice stops", shouldRetry("failed", 2) === false);
  check("success never retries", shouldRetry("ok", 1) === false);
  check("retry prompt carries the reason", retryPrompt("做 A", "文件不存在").includes("文件不存在"));
}

// 4) note store
{
  const dir = mkdtempSync(path.join(tmpdir(), "pi-fanout-"));
  const store = new NoteStore(dir);
  store.write("s1", "db", "SQLite", "1");
  store.write("s1", "db", "Postgres", "2");
  store.write("s2", "db", "MySQL", "3");
  check("writes are scoped", store.read("s1").length === 2 && store.read("s2").length === 1);
  check("reads are ordered", store.read("s1")[1].value === "Postgres");
  store.clear("s1");
  check("clear only affects its scope", store.read("s1").length === 0 && store.read("s2").length === 1);
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* Windows handle */ }
}

// 5) control API: fan-out runs children, retries once, shares notes
{
  const dir = mkdtempSync(path.join(tmpdir(), "pi-api-"));
  const notes = new NoteStore(dir);
  const calls = [];
  let attempt = 0;

  const server = await startControlServer(
    {
      notes,
      maxChildren: 4,
      concurrency: 2,
      runChild: async ({ prompt, index }) => {
        calls.push({ prompt, index });
        if (index === 0) {
          return JSON.stringify([
            { title: "子 A", prompt: "做 A" },
            { title: "子 B", prompt: "做 B" },
          ]);
        }
        attempt += 1;
        if (index === 2 && attempt <= 2) throw new Error("第一次故意失败");
        notes.write("unknown", `结论${index}`, `值${index}`, String(index));
        return `子任务 ${index} 完成`;
      },
    },
    0,
  );

  const health = await fetch(`http://127.0.0.1:${server.port}/health`).then((r) => r.json());
  check("health answers", health.ok === true, JSON.stringify(health));

  const response = await fetch(`http://127.0.0.1:${server.port}/fanout`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ prompt: "调研", count: 2 }),
  }).then((r) => r.json());

  check("fanout returns digest", typeof response.digest === "string" && response.digest.length > 0, JSON.stringify(response).slice(0, 120));
  check("split called once", calls.filter((c) => c.index === 0).length === 1);
  check("both children ran", response.results?.length === 2, String(response.results?.length));
  check("failed child retried", response.results?.some((r) => r.attempts === 2), JSON.stringify(response.results));
  check("digest mentions retry", response.digest.includes("重试"), response.digest.slice(0, 160));

  const bad = await fetch(`http://127.0.0.1:${server.port}/fanout`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ prompt: "" }),
  });
  check("empty prompt rejected", bad.status === 400, String(bad.status));

  const noteWrite = await fetch(`http://127.0.0.1:${server.port}/notes`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ key: "k", value: "v", by: "child" }),
  }).then((r) => r.json());
  check("note write accepted", noteWrite.ok === true);

  const noteRead = await fetch(`http://127.0.0.1:${server.port}/notes/read`, { method: "POST" }).then((r) => r.json());
  check("note read returns text", typeof noteRead.text === "string" && noteRead.text.length > 0, noteRead.text);

  // 6) proactive send: bound session, quota, target guard
  {
    const sent = [];
    server.setSession("feishu:oc_9", async (text) => { sent.push(text); });

    const first = await fetch(`http://127.0.0.1:${server.port}/send`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "进度：正在查第一个来源" }),
    }).then((r) => r.json());
    check("send delivers", first.ok === true && first.remaining === 2, JSON.stringify(first));
    check("sender saw the text", sent.length === 1 && sent[0].includes("进度"), JSON.stringify(sent));

    const empty = await fetch(`http://127.0.0.1:${server.port}/send`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "   " }),
    });
    check("empty send rejected", empty.status === 400, String(empty.status));

    const cross = await fetch(`http://127.0.0.1:${server.port}/send`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "给别的群发", thread: "qq:group:1" }),
    });
    check("cross-session send refused", cross.status === 403, String(cross.status));

    await fetch(`http://127.0.0.1:${server.port}/send`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "第二条" }),
    });
    await fetch(`http://127.0.0.1:${server.port}/send`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "第三条" }),
    });
    const fourth = await fetch(`http://127.0.0.1:${server.port}/send`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "第四条" }),
    });
    check("quota stops the fourth send", fourth.status === 429, String(fourth.status));
    check("quota counts three", sent.length === 3, String(sent.length));

    // A new task resets the quota.
    server.setSession("feishu:oc_9", async (text) => { sent.push(text); });
    const afterReset = await fetch(`http://127.0.0.1:${server.port}/send`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "新任务第一条" }),
    }).then((r) => r.json());
    check("new session resets quota", afterReset.ok === true && afterReset.remaining === 2, JSON.stringify(afterReset));
  }

  // 7) sending a file: workspace-confined, type and size checked
  {
    const sentFiles = [];
    server.setSession("feishu:oc_9", async () => {}, async (filePath, caption) => {
      sentFiles.push({ filePath, caption });
    });

    const outside = await fetch(`http://127.0.0.1:${server.port}/send`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: "/etc/passwd" }),
    });
    check("outside workspace refused", outside.status === 403, String(outside.status));

    const missing = await fetch(`http://127.0.0.1:${server.port}/send`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: "/workspace/definitely-missing.png" }),
    });
    check("missing file reports 404", missing.status === 404, String(missing.status));

    mkdirSync("/workspace", { recursive: true });
    const png = path.join("/workspace", "unit-test-media.png");
    const bad = path.join("/workspace", "unit-test-media.exe");
    writeFileSync(png, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    writeFileSync(bad, Buffer.from([0x4d, 0x5a]));

    const badType = await fetch(`http://127.0.0.1:${server.port}/send`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: bad }),
    });
    check("disallowed extension refused", badType.status === 400, String(badType.status));

    const ok = await fetch(`http://127.0.0.1:${server.port}/send`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: png, caption: "图在这" }),
    }).then((r) => r.json());
    check("image send accepted", ok.ok === true && ok.kind === "file", JSON.stringify(ok));
    check("sender got resolved path", path.basename(sentFiles[0]?.filePath ?? "") === "unit-test-media.png", JSON.stringify(sentFiles));
    check("caption passed through", sentFiles[0]?.caption === "图在这", JSON.stringify(sentFiles));
  }

  await server.close();
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* Windows handle */ }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
