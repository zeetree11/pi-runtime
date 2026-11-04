import { CheckpointStore } from "../src/checkpoint.ts";

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

let now = 1_000;
const store = new CheckpointStore({ now: () => now });

// 1) 新任务：所有步骤都要跑
{
  check("fresh task runs the first step", store.begin("t1", "fetch").action === "run");
  check("remaining lists everything", store.remaining("t1", ["fetch", "write", "verify"]).join(",") === "fetch,write,verify");
}

// 2) 完成步骤后跳过（这就是"接管不重跑"）
{
  store.complete("t1", "fetch", 1);
  const decision = store.begin("t1", "fetch");
  check("completed step is skipped", decision.action === "skip", JSON.stringify(decision));
  check("remaining shrinks", store.remaining("t1", ["fetch", "write", "verify"]).join(",") === "write,verify");
}

// 3) 换代后仍然跳过（步骤名稳定，epoch 只是归属信息）
{
  store.complete("t1", "write", 2);
  check("skip survives a new epoch", store.begin("t1", "write").action === "skip");
  check("checkpoint records the writing epoch", store.load("t1").epoch === 2, String(store.load("t1").epoch));
}

// 4) 未确认的副作用阻塞重跑
{
  store.effect("t1", "publish", "http:POST /tickets", "unknown");
  const decision = store.begin("t1", "publish");
  check("unknown effect demands verification", decision.action === "verify", JSON.stringify(decision));
  check("verification names the target", decision.action === "verify" && decision.effects[0].target.includes("/tickets"), JSON.stringify(decision));
  check("unresolved lists it", store.unresolved("t1").length === 1);

  store.effect("t1", "publish", "http:POST /tickets", "applied");
  check("after verification the step may run", store.begin("t1", "publish").action === "run");
  check("nothing unresolved anymore", store.unresolved("t1").length === 0);
}

// 5) verify 优先于 skip：一条既完成过又状态未知的步骤，必须先核实
{
  store.complete("t2", "deploy", 1);
  store.effect("t2", "deploy", "k8s:apply", "unknown");
  const decision = store.begin("t2", "deploy");
  check("verify wins over skip", decision.action === "verify", JSON.stringify(decision));
}

// 6) 产物版本：接管后能比对基线
{
  const first = store.artifact("t3", "/workspace/out.md", "hash-a");
  check("artifact starts at version 1", first.artifacts["/workspace/out.md"].version === 1);
  const second = store.artifact("t3", "/workspace/out.md", "hash-b");
  check("artifact version increments", second.artifacts["/workspace/out.md"].version === 2);
  check("latest hash wins", second.artifacts["/workspace/out.md"].hash === "hash-b");
}

// 7) 补偿会被记录下来，但不再阻塞
{
  store.effect("t4", "refund", "pay:order-9", "unknown");
  store.effect("t4", "refund", "pay:order-9", "compensated");
  const effects = store.load("t4").effects;
  check("effect updated in place, not duplicated", effects.length === 1, String(effects.length));
  check("compensated does not block", store.begin("t4", "refund").action === "run");
}

// 8) restore 从持久层恢复，行为一致
{
  const restored = new CheckpointStore({ now: () => now });
  restored.restore({
    taskId: "t5",
    epoch: 3,
    completed: ["a"],
    artifacts: {},
    effects: [{ step: "b", target: "file:/x", status: "unknown", at: now }],
    updatedAt: now,
  });
  check("restored progress is honoured", restored.begin("t5", "a").action === "skip");
  check("restored unknown effect still blocks", restored.begin("t5", "b").action === "verify");
  check("restored remaining is correct", restored.remaining("t5", ["a", "b", "c"]).join(",") === "b,c");
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
