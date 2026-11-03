import { LeaseRegistry } from "../src/lease.ts";

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

let now = 1_000_000;
const clock = () => now;
const registry = new LeaseRegistry({ ttlMs: 10_000, now: clock });

// 1) 认领 / 续租 / 提交
{
  const lease = registry.claim("task-1", "agent-a");
  check("claim returns epoch 1", lease.epoch === 1, String(lease.epoch));
  check("heartbeat extends", registry.heartbeat("task-1", lease.epoch) === true);

  const submitted = registry.submit("task-1", lease.epoch);
  check("submit succeeds under own epoch", submitted.ok === true, JSON.stringify(submitted));
  check("task released after submit", registry.snapshot().every((item) => item.taskId !== "task-1"));
}

// 2) 未过期不能抢占（把"沉默"和"停止"分开）
{
  const lease = registry.claim("task-2", "agent-a");
  let threw = false;
  try {
    registry.claim("task-2", "agent-b");
  } catch {
    threw = true;
  }
  check("cannot steal a live lease", threw);
  check("original owner still holds it", registry.snapshot().find((item) => item.taskId === "task-2")?.owner === "agent-a");

  // 心跳让它一直活着，即使时间过去了很久
  now += 9_000;
  registry.heartbeat("task-2", lease.epoch);
  now += 9_000;
  check("heartbeat keeps a lease alive past the original ttl", registry.expired().every((item) => item.taskId !== "task-2"));
}

// 3) 租约过期才能接管，且 epoch 递增
{
  now += 20_000; // 停止心跳，超过 ttl
  const expired = registry.expired();
  check("expired lease visible to scheduler", expired.some((item) => item.taskId === "task-2"));

  const takeover = registry.claim("task-2", "agent-b");
  check("takeover increments epoch", takeover.epoch === 2, String(takeover.epoch));
  check("new owner recorded", takeover.owner === "agent-b");
}

// 4) fencing：旧执行者恢复后提交必须被拒
{
  const stale = registry.submit("task-2", 1);
  check("stale epoch rejected", stale.ok === false, JSON.stringify(stale));
  if (!stale.ok) check("rejection names the current epoch", stale.current === 2, String(stale.current));
  check("reason is stale, not owner error", !stale.ok && stale.reason === "stale", JSON.stringify(stale));

  const fresh = registry.submit("task-2", 2);
  check("current epoch accepted", fresh.ok === true);
}

// 5) 过期 epoch 的心跳也无效（它不能续命）
{
  const lease = registry.claim("task-3", "agent-a");
  now += 20_000;
  check("expired heartbeat refused", registry.heartbeat("task-3", lease.epoch) === false);
  now += 20_000;
  let takeover = null;
  try {
    takeover = registry.claim("task-3", "agent-b");
  } catch (error) {
    console.log("  claim 报错:", error.message);
  }
  check("takeover still possible afterwards", takeover?.epoch === 2, String(takeover?.epoch));
  check("old heartbeat still refused after takeover", registry.heartbeat("task-3", 1) === false);
}

// 6) 未知任务与幂等键
{
  check("unknown task submit rejected", registry.submit("nope", 1).ok === false);
  const a = LeaseRegistry.idemKey("task-1", "write-report", 1);
  const b = LeaseRegistry.idemKey("task-1", "write-report", 1);
  const c = LeaseRegistry.idemKey("task-1", "write-report", 2);
  check("idem key is stable for the same attempt", a === b);
  check("idem key changes on takeover", a !== c, `${a} vs ${c}`);
  check("idem key names the step", a.includes("write-report"));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
