import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";
import { toReadableText, parseDuckDuckGo, runSearch } from "../mcp/fetch-server.mjs";

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

const here = path.dirname(fileURLToPath(import.meta.url));
const serverPath = path.join(here, "..", "mcp", "fetch-server.mjs");

// 1) HTML → readable text
{
  const html = `<html><head><style>body{color:red}</style><script>alert(1)</script></head>
  <body><h1>标题</h1><p>正文第一段。</p><ul><li>条目一</li><li>条目二</li></ul>
  <a href="/x">链接</a>&nbsp;&amp;</body></html>`;
  const text = toReadableText(html);
  check("script removed", !text.includes("alert(1)"), text);
  check("style removed", !text.includes("color:red"), text);
  check("heading kept", text.includes("标题"), text);
  check("paragraph kept", text.includes("正文第一段"), text);
  check("list items kept", text.includes("条目一") && text.includes("条目二"));
  check("entities decoded", text.includes("&"), text);
  check("tags gone", !text.includes("<p>") && !text.includes("<li"));
}

// 2) stdio handshake + tools/list + tools/call against a local fixture
const fixture = createServer((req, res) => {
  if (req.url === "/page") {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end("<html><body><p>油桃测试页面</p></body></html>");
    return;
  }
  res.writeHead(404).end("nope");
});

await new Promise((resolve) => fixture.listen(0, "127.0.0.1", resolve));
const port = fixture.address().port;

const child = spawn(process.execPath, [serverPath], {
  env: { ...process.env, MCP_FETCH_ALLOW_LOCAL: "1" },
  stdio: ["pipe", "pipe", "pipe"],
});

let out = "";
const waiters = [];
child.stdout.setEncoding("utf8");
child.stdout.on("data", (chunk) => {
  out += chunk;
  let index;
  while ((index = out.indexOf("\n")) >= 0) {
    const line = out.slice(0, index).trim();
    out = out.slice(index + 1);
    if (!line) continue;
    try {
      const message = JSON.parse(line);
      const waiter = waiters.shift();
      if (waiter) waiter(message);
    } catch {
      /* ignore */
    }
  }
});

function rpc(payload) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout waiting for ${payload.method}`)), 5000);
    waiters.push((message) => {
      clearTimeout(timer);
      resolve(message);
    });
    child.stdin.write(`${JSON.stringify(payload)}\n`);
  });
}

const init = await rpc({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
check("initialize returns protocolVersion", typeof init.result?.protocolVersion === "string", JSON.stringify(init).slice(0, 120));
check("serverInfo names the server", init.result?.serverInfo?.name === "fetch");

const list = await rpc({ jsonrpc: "2.0", id: 2, method: "tools/list" });
check("two tools exposed", list.result?.tools?.length === 2, String(list.result?.tools?.length));
check("fetch is listed", list.result?.tools?.some((t) => t.name === "fetch"));
check("search is listed", list.result?.tools?.some((t) => t.name === "search"));
check("tool requires url", JSON.stringify(list.result?.tools?.[0]?.inputSchema?.required) === '["url"]');

const ok = await rpc({
  jsonrpc: "2.0",
  id: 3,
  method: "tools/call",
  params: { name: "fetch", arguments: { url: `http://127.0.0.1:${port}/page` } },
});
check("fetch returns content", ok.result?.isError === false, JSON.stringify(ok).slice(0, 160));
check("fetch body readable", (ok.result?.content?.[0]?.text ?? "").includes("油桃测试页面"), ok.result?.content?.[0]?.text);

// 3) SSRF guards (run without the local escape hatch)
const blocked = await rpc({
  jsonrpc: "2.0",
  id: 4,
  method: "tools/call",
  params: { name: "fetch", arguments: { url: "file:///etc/passwd" } },
});
check("file:// rejected", blocked.result?.isError === true, JSON.stringify(blocked).slice(0, 120));

child.kill();
await new Promise((resolve) => fixture.close(resolve));

// 4) guard unit checks via a second process without the escape hatch
async function tryFetch(url) {
  const runs = await import("node:child_process");
  return new Promise((resolve) => {
    const proc = runs.spawn(process.execPath, ["--input-type=module", "-e", `
      const { runFetch } = await import(${JSON.stringify(pathToFileURL(serverPath).href)});
      try { await runFetch(${JSON.stringify(url)}); console.log("ALLOWED"); }
      catch (e) { console.log("BLOCKED: " + e.message); }
    `], { env: { ...process.env, MCP_FETCH_ALLOW_LOCAL: "0" }, stdio: ["ignore", "pipe", "pipe"] });
    let text = "";
    proc.stdout.on("data", (d) => { text += d; });
    proc.stderr.on("data", (d) => { text += d; });
    proc.on("close", () => resolve(text.trim()));
  });
}

for (const url of ["http://localhost/x", "http://169.254.169.254/latest/meta-data", "http://10.1.2.3/x", "http://192.168.1.1/"]) {
  const result = await tryFetch(url);
  check(`blocked ${url}`, result.startsWith("BLOCKED"), result);
}

// 5) DuckDuckGo result parsing (fixture, no network)
{
  const fixture = `
    <div class="result__body">
      <a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fdoc&amp;rut=x">示例文档</a>
      <a class="result__snippet" href="#">这是示例文档的摘要。</a>
    </div>
    <div class="result__body">
      <a rel="nofollow" class="result__a" href="https://plain.example.org/page">Plain <b>title</b></a>
      <a class="result__snippet" href="#">第二条摘要</a>
    </div>
  `;
  const results = parseDuckDuckGo(fixture, 5);
  check("parses two results", results.length === 2, String(results.length));
  check("decodes redirect url", results[0]?.url === "https://example.com/doc", results[0]?.url);
  check("keeps plain url", results[1]?.url === "https://plain.example.org/page", results[1]?.url);
  check("title text readable", results[1]?.title === "Plain title", results[1]?.title);
  check("snippet captured", results[0]?.snippet.includes("示例文档的摘要"), results[0]?.snippet);
  check("respects limit", parseDuckDuckGo(fixture, 1).length === 1);
  check("empty html yields none", parseDuckDuckGo("<html></html>", 5).length === 0);
}

// 6) search input validation happens before any network call
{
  let blocked = false;
  try { await runSearch(""); } catch (e) { blocked = /为空/.test(e.message); }
  check("empty query rejected", blocked);
  let tooLong = false;
  try { await runSearch("长".repeat(201)); } catch (e) { tooLong = /过长/.test(e.message); }
  check("overlong query rejected", tooLong);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
