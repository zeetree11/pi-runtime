import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { ApprovalStore, extractAskDirectives, parseDecision } from "../src/approval.ts";

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

// 1) the control token
{
  const raw = "我需要先删掉旧构建产物。\n<!--ask: rm -rf /workspace/build-->";
  const { asks, cleaned } = extractAskDirectives(raw);
  check("one ask parsed", asks.length === 1, JSON.stringify(asks));
  check("action captured", asks[0]?.action === "rm -rf /workspace/build", asks[0]?.action);
  check("token stripped", !cleaned.includes("<!--"), cleaned);
  check("prose kept", cleaned.includes("删掉旧构建产物"), cleaned);
  check("malformed token ignored", extractAskDirectives("<!--ask:-->").asks.length === 0);
}

// 2) decision phrases are narrow on purpose
{
  check("同意 approves", parseDecision("同意") === "approved");
  check("批准 approves", parseDecision("批准") === "approved");
  check("yes approves", parseDecision("yes") === "approved");
  check("拒绝 denies", parseDecision("拒绝") === "denied");
  check("no denies", parseDecision("no") === "denied");
  check("punctuation tolerated", parseDecision("同意！") === "approved");
  check("unrelated text is not a decision", parseDecision("这个方案怎么样") === null);
  check("partial word is not a decision", parseDecision("同意但是……") === null);
}

// 3) store: request → pending → decide
{
  const dir = mkdtempSync(path.join(tmpdir(), "pi-approval-"));
  const store = new ApprovalStore(dir, 5);

  const ask = store.request({ thread: "feishu:oc_1", taskId: "t1", action: "rm -rf build", request: "清理构建目录" });
  check("request is pending", ask.status === "pending", ask.status);
  check("prompt tells the user how to answer", ask.prompt.includes("同意") && ask.prompt.includes("拒绝"), ask.prompt);
  check("pending found by thread", store.pendingFor("feishu:oc_1")?.id === ask.id);
  check("other thread sees nothing", store.pendingFor("feishu:oc_2") === null);

  const decided = store.decide(ask.id, "approved");
  check("approve records decided_at", decided?.status === "approved" && decided?.decidedAt !== null, JSON.stringify(decided?.status));
  check("second decide is a no-op", store.decide(ask.id, "denied") === null);
  check("no longer pending", store.pendingFor("feishu:oc_1") === null);

  // 4) approval grants elevated capability to that thread only, and expires
  check("grant issued on approve", store.hasGrant("feishu:oc_1") === true);
  check("grant is thread scoped", store.hasGrant("feishu:oc_2") === false);
  store.grant("feishu:oc_1", 1, "user");
  check("grant still valid inside the window", store.hasGrant("feishu:oc_1") === true);
  check("grant expires", store.hasGrant("feishu:oc_1", Date.now() + 2 * 60_000) === false);

  // 5) deny does not grant
  const denied = store.request({ thread: "qq:group:9", action: "curl", request: "查一下" });
  store.decide(denied.id, "denied");
  check("deny leaves no grant", store.hasGrant("qq:group:9") === false);
  check("deny is recorded", store.byId(denied.id)?.status === "denied", store.byId(denied.id)?.status);

  // 6) expiry closes stale requests instead of leaving them hanging
  const stale = store.request({ thread: "feishu:oc_3", action: "git push", request: "推送", ttlMinutes: 1 });
  check("expire closes stale pendings", store.expire(new Date(Date.now() + 2 * 60_000)) >= 1);
  check("stale request marked expired", store.byId(stale.id)?.status === "expired", store.byId(stale.id)?.status);
  check("expired request is not pending", store.pendingFor("feishu:oc_3", new Date(Date.now() + 2 * 60_000)) === null);

  // 7) listPending only surfaces live ones
  store.request({ thread: "feishu:oc_4", action: "x", request: "y" });
  check("listPending returns live rows", store.listPending().length === 1, String(store.listPending().length));

  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* Windows keeps the WAL handle briefly */
  }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
