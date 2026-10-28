import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { MCP_CONFIG, ProposalStore, validateMcpServer, validateProposal } from "../src/proposal.ts";

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

const dir = mkdtempSync(path.join(tmpdir(), "pi-proposal-"));
mkdirSync(path.join(dir, "persona"), { recursive: true });
writeFileSync(path.join(dir, "persona", "SOUL.md"), "# 是谁\n\n旧的你。\n", "utf8");
writeFileSync(path.join(dir, "persona", "CONTRACTS.md"), "# 纪律\n\n旧的纪律。\n", "utf8");

// 1) allowlist: capability surface only
{
  check("soul allowed", validateProposal({ path: "persona/SOUL.md", content: "x" }).ok === true);
  check("contracts allowed", validateProposal({ path: "persona/CONTRACTS.md", content: "x" }).ok === true);
  // Build the path with a real backslash so the escape sequence cannot swallow it.\n  check("backslashes normalised", validateProposal({ path: `persona${String.fromCharCode(92)}SOUL.md`, content: "x" }).ok === true);

  const src = validateProposal({ path: "src/worker.ts", content: "process.exit(0)" });
  check("runtime code refused", src.ok === false, JSON.stringify(src));
  check("refusal explains the boundary", src.ok === false && /运行时代码/.test(src.reason), src.ok === false ? src.reason : "");

  check("absolute path refused", validateProposal({ path: "/etc/passwd", content: "x" }).ok === false);
  check("empty path refused", validateProposal({ path: "", content: "x" }).ok === false);
  check("empty content refused", validateProposal({ path: "persona/SOUL.md", content: "  " }).ok === false);
}

// 2) size limit
{
  const tooLong = validateProposal({ path: "persona/SOUL.md", content: "x".repeat(4_001) });
  check("over budget refused", tooLong.ok === false && /上限/.test(tooLong.reason), tooLong.ok === false ? tooLong.reason : "");
}

// 3) secret guard
{
  const withKey = validateProposal({ path: "persona/SOUL.md", content: "我的 key 是 sk-abcdefghijklmnopqrstuvwx" });
  check("secret refused", withKey.ok === false, JSON.stringify(withKey));
}

// 4) propose → approve → apply → revert
{
  const store = new ProposalStore(dir, 30);
  const same = store.request({ thread: "t1", path: "persona/SOUL.md", content: "# 是谁\n\n旧的你。\n", rationale: "no-op" });
  check("identical content rejected", same.ok === false, JSON.stringify(same).slice(0, 120));

  const proposed = store.request({
    thread: "t1",
    path: "persona/SOUL.md",
    content: "# 是谁\n\n新的你，说话更短。\n",
    rationale: "用户说回复太长",
  });
  check("proposal created", proposed.ok === true, JSON.stringify(proposed).slice(0, 120));
  if (proposed.ok === false) process.exit(1);

  const id = proposed.proposal.id;
  check("pending is findable by thread", store.pendingFor("t1")?.id === id);
  check("other thread does not see it", store.pendingFor("t2") === null);
  check("file untouched before approval", readFileSync(path.join(dir, "persona", "SOUL.md"), "utf8").includes("旧的你"));

  const applied = store.apply(id);
  check("apply writes the file", readFileSync(path.join(dir, "persona", "SOUL.md"), "utf8").includes("新的你"), applied?.status);
  check("status is applied", applied?.status === "applied", applied?.status);
  check("before content kept for revert", (applied?.before ?? "").includes("旧的你"));

  const reverted = store.revert(id);
  check("revert restores the file", readFileSync(path.join(dir, "persona", "SOUL.md"), "utf8").includes("旧的你"), reverted?.status);
  check("status is reverted", reverted?.status === "reverted", reverted?.status);
  check("revert twice is a no-op", store.revert(id) === null);
}

// 5) reject and expiry
{
  const store = new ProposalStore(dir, 30);
  const p = store.request({ thread: "t3", path: "persona/CONTRACTS.md", content: "新的纪律", rationale: "x" });
  if (p.ok === false) { check("setup proposal", false, p.reason); }
  else {
    check("reject works", store.reject(p.proposal.id)?.status === "rejected");
    check("rejected is not pending", store.pendingFor("t3") === null);
    check("rejected file not written", !readFileSync(path.join(dir, "persona", "CONTRACTS.md"), "utf8").includes("新的纪律"));
  }

  const stale = store.request({ thread: "t4", path: "persona/CONTRACTS.md", content: "更旧的纪律", rationale: "y" });
  if (stale.ok === true) {
    check("expire closes stale proposals", store.expire(new Date(Date.now() + 31 * 60_000)) >= 1);
    check("stale marked expired", store.byId(stale.proposal.id)?.status === "expired", store.byId(stale.proposal.id)?.status);
  }
}

// 6) history is auditable
{
  const store = new ProposalStore(dir, 30);
  const rows = store.history();
  check("history has entries", rows.length >= 3, String(rows.length));
  check("history keeps rationale", rows.some((row) => row.rationale.length > 0));
}

// 7) MCP servers: allow-listed command, workspace-bounded args, no secrets, capped count
{
  check("node allowed", validateMcpServer({ name: "kv", command: "node" }, {}).ok === true);
  check("bash refused", validateMcpServer({ name: "sh", command: "bash" }, {}).ok === false);
  const badName = validateMcpServer({ name: "Bad Name!", command: "node" }, {});
  check("bad name refused", badName.ok === false, JSON.stringify(badName));

  const outside = validateMcpServer({ name: "x", command: "node", args: ["/etc/passwd"] }, {});
  check("outside absolute path refused", outside.ok === false, JSON.stringify(outside));
  check("workspace path allowed", validateMcpServer({ name: "ws", command: "node", args: ["/workspace/mcp/a.mjs"] }, {}).ok === true);

  const secretEnv = validateMcpServer({ name: "x", command: "node", env: { TOKEN: "sk-abcdefghijklmnopqrstuvwx" } }, {});
  check("secret env refused", secretEnv.ok === false, JSON.stringify(secretEnv));

  const full = { mcpServers: Object.fromEntries(Array.from({ length: 8 }, (_, i) => [`s${i}`, { command: "node" }])) };
  check("server cap enforced", validateMcpServer({ name: "newone", command: "node" }, full).ok === false);
  check("replacing existing is allowed at cap", validateMcpServer({ name: "s0", command: "node" }, full).ok === true);
}

// 8) MCP proposal: apply patches mcp.json, revert removes the entry
{
  const store = new ProposalStore(dir, 30);
  const proposed = store.requestMcp({
    thread: "t9",
    server: { name: "websearch", command: "node", args: ["/workspace/mcp/search.mjs"], description: "搜索" },
    rationale: "需要一个搜索工具",
  });
  check("mcp proposal created", proposed.ok === true, JSON.stringify(proposed).slice(0, 120));
  if (proposed.ok === true) {
    const id = proposed.proposal.id;
    check("mcp target uses prefix", proposed.proposal.path === "mcp:websearch", proposed.proposal.path);

    store.apply(id);
    const config = JSON.parse(readFileSync(path.join(dir, MCP_CONFIG), "utf8"));
    check("server written to mcp.json", config.mcpServers?.websearch?.command === "node", JSON.stringify(config).slice(0, 120));
    check("exposure defaults to direct", config.mcpServers?.websearch?.exposure === "direct");

    store.revert(id);
    const after = JSON.parse(readFileSync(path.join(dir, MCP_CONFIG), "utf8"));
    check("revert removes the new server", after.mcpServers?.websearch === undefined, JSON.stringify(after).slice(0, 120));
  }
}

// 9) MCP proposal replacing an existing server restores the old entry on revert
{
  mkdirSync(path.join(dir, ".pi", "agent"), { recursive: true });
  writeFileSync(
    path.join(dir, MCP_CONFIG),
    JSON.stringify({ mcpServers: { old: { command: "node", args: ["old.mjs"], exposure: "direct" } } }, null, 2),
    "utf8",
  );
  const store = new ProposalStore(dir, 30);
  const proposed = store.requestMcp({
    thread: "t10",
    server: { name: "old", command: "node", args: ["/workspace/new.mjs"] },
    rationale: "换实现",
  });
  if (proposed.ok === true) {
    store.apply(proposed.proposal.id);
    check("existing server replaced", JSON.parse(readFileSync(path.join(dir, MCP_CONFIG), "utf8")).mcpServers.old.args[0] === "/workspace/new.mjs");
    store.revert(proposed.proposal.id);
    check("revert restores old entry", JSON.parse(readFileSync(path.join(dir, MCP_CONFIG), "utf8")).mcpServers.old.args[0] === "old.mjs");
  } else {
    check("replace proposal created", false, proposed.reason);
  }
}

try { rmSync(dir, { recursive: true, force: true }); } catch { /* Windows handle */ }

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
