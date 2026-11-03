import { createServer } from "node:http";
import { Mem0Engine, mem0ConfigFromEnv } from "../src/mem0-engine.ts";

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

const DIM = 64;

/** Deterministic bag-of-bigrams embedding: enough to prove the plumbing end to end. */
function embed(text) {
  const vector = new Array(DIM).fill(0);
  const body = String(text).toLowerCase();
  for (let i = 0; i < body.length - 1; i += 1) {
    const code = (body.charCodeAt(i) * 31 + body.charCodeAt(i + 1)) % DIM;
    vector[code] += 1;
  }
  const norm = Math.hypot(...vector) || 1;
  return vector.map((value) => value / norm);
}

// Fake OpenAI-compatible embeddings endpoint, so the test does not depend on a provider.
const server = createServer((request, response) => {
  let body = "";
  request.on("data", (chunk) => { body += chunk; });
  request.on("end", () => {
    const payload = JSON.parse(body || "{}");
    const inputs = Array.isArray(payload.input) ? payload.input : [payload.input];
    const data = inputs.map((text, index) => ({ object: "embedding", index, embedding: embed(text) }));
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ object: "list", data, model: payload.model ?? "fake", usage: { total_tokens: 1 } }));
  });
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const port = server.address().port;

// 1) environment parsing
{
  check("no endpoint means no engine", mem0ConfigFromEnv({}) === null);
  const parsed = mem0ConfigFromEnv({
    MEM0_EMBED_BASE_URL: "http://x/v1",
    MEM0_EMBED_MODEL: "m",
    MEM0_EMBED_DIM: "256",
  });
  check("config parsed", parsed?.model === "m" && parsed?.dimension === 256, JSON.stringify(parsed));
  check("api key optional", parsed?.apiKey === "", JSON.stringify(parsed?.apiKey));
}

// 2) add + recall through Mem0, metadata round-trips
{
  const engine = new Mem0Engine({
    baseURL: `http://127.0.0.1:${port}/v1`,
    apiKey: "test",
    model: "fake-embed",
    dimension: DIM,
    collection: "test-memories",
  });

  const rows = [
    { key: "user.city", content: "住在成都已经五年", subject: "Rick", evidenceEventId: 12, updatedAt: "1" },
    { key: "project.db", content: "runtime 用 SQLite 单机部署", subject: "Rick", evidenceEventId: 13, updatedAt: "2" },
    { key: "pref.reply", content: "回复要短，群里别超过两句", subject: "Rick", evidenceEventId: 14, updatedAt: "3" },
  ];
  const added = await engine.sync(rows);
  check("sync adds every row", added === 3, String(added));
  check("sync is idempotent", (await engine.sync(rows)) === 0);
  check("describe mentions model", engine.describe().includes("fake-embed"), engine.describe());

  const hits = await engine.recall("数据库用的什么", 3);
  check("recall returns results", hits.length > 0, JSON.stringify(hits.map((h) => h.key)));
  check("metadata key survives the round trip", hits.every((hit) => typeof hit.key === "string" && hit.key.length > 0));
  const dbHit = hits.find((hit) => hit.key === "project.db");
  check("the relevant memory is returned", Boolean(dbHit), JSON.stringify(hits.map((h) => h.key)));
  check("evidence id survives", dbHit ? dbHit.eventId === 13 : false, JSON.stringify(dbHit));

  const top = hits[0];
  check("scores are numbers in range", typeof top.score === "number" && top.score >= 0, String(top.score));

  // 3) recall respects the limit
  const limited = await engine.recall("成都 部署", 1);
  check("limit is respected", limited.length === 1, String(limited.length));
}

await new Promise((resolve) => server.close(resolve));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
