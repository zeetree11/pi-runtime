import { Orchestrator, route } from "../src/orchestrator.ts";

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

const task = (id, deps = [], extra = {}) => ({ id, title: id, prompt: id, role: "worker", deps, ...extra });

// 1) routing is explainable, not magic
{
  check("verify goes to verifier", route({ title: "复核结论", prompt: "" }) === "verifier");
  check("research goes to researcher", route({ title: "", prompt: "帮我检索资料" }) === "researcher");
  check("code goes to coder", route({ title: "实现这个函数", prompt: "" }) === "coder");
  check("default is worker", route({ title: "随便", prompt: "随便" }) === "worker");
}

// 2) dependency order: a task does not start before its deps are done
{
  const orchestrator = new Orchestrator([task("a"), task("b", ["a"]), task("c", ["b"])], { concurrency: 3 });
  check("only roots are ready", orchestrator.ready().map((t) => t.id).join(",") === "a", JSON.stringify(orchestrator.ready().map((t) => t.id)));

  await orchestrator.wave(async (t) => ({ output: `${t.id}-done` }));
  check("b becomes ready after a", orchestrator.ready().map((t) => t.id).join(",") === "b", JSON.stringify(orchestrator.ready().map((t) => t.id)));
  await orchestrator.wave(async (t) => ({ output: "x" }));
  await orchestrator.wave(async (t) => ({ output: "x" }));
  check("everything finishes", orchestrator.finished() && orchestrator.summary().done === 3, JSON.stringify(orchestrator.summary()));
}

// 3) concurrency cap per wave
{
  const orchestrator = new Orchestrator(["a", "b", "c", "d", "e"].map((id) => task(id)), { concurrency: 2 });
  let running = 0;
  let peak = 0;
  const dispatched = await orchestrator.wave(async (t) => {
    running += 1;
    peak = Math.max(peak, running);
    await new Promise((resolve) => setTimeout(resolve, 5));
    running -= 1;
    return { output: t.id };
  });
  check("one wave holds at most `concurrency`", dispatched.length === 2, String(dispatched.length));
  check("peak concurrency respected", peak <= 2, String(peak));
}

// 4) dynamic dispatch: a result can enqueue follow-up work
{
  const orchestrator = new Orchestrator([task("research")], { concurrency: 2, maxTasks: 5 });
  const first = await orchestrator.wave(async () => ({
    output: "found a gap",
    followUps: [{ id: "fill-gap", title: "fill gap", prompt: "fill", role: "worker", deps: [] }],
  }));
  check("follow-up accepted", first[0].followUps.length === 1, JSON.stringify(first[0].followUps));
  check("follow-up is pending", orchestrator.all.some((t) => t.id === "fill-gap" && t.status === "pending"));
  check("follow-up runs next", orchestrator.ready().map((t) => t.id).join(",") === "fill-gap");

  const second = await orchestrator.wave(async () => ({ output: "filled" }));
  check("follow-up executed", second[0].task.status === "done");
}

// 5) task budget caps unbounded expansion
{
  const orchestrator = new Orchestrator([task("seed")], { maxTasks: 3, concurrency: 1, maxSteps: 10 });
  await orchestrator.wave(async () => ({
    output: "x",
    followUps: ["f1", "f2", "f3", "f4"].map((id) => ({ id, title: id, prompt: id, role: "worker", deps: [] })),
  }));
  check("task budget enforced", orchestrator.all.length === 3, String(orchestrator.all.length));
}

// 6) retry once, then mark failed
{
  let calls = 0;
  const orchestrator = new Orchestrator([task("flaky")], { maxAttempts: 2, concurrency: 1 });
  await orchestrator.wave(async () => {
    calls += 1;
    throw new Error("boom");
  });
  check("first failure requeues", orchestrator.all[0].status === "pending" && calls === 1, orchestrator.all[0].status);
  await orchestrator.wave(async () => {
    calls += 1;
    throw new Error("boom");
  });
  check("second failure is final", orchestrator.all[0].status === "failed", orchestrator.all[0].status);
  check("attempts counted", orchestrator.all[0].attempts === 2, String(orchestrator.all[0].attempts));
}

// 7) step budget stops the loop and says why
{
  const orchestrator = new Orchestrator([task("a"), task("b")], { maxSteps: 1, concurrency: 1 });
  await orchestrator.wave(async () => ({ output: "x" }));
  check("step budget reached", orchestrator.finished() === true);
  check("stop reason names the budget", /步数上限/.test(orchestrator.stopReason()), orchestrator.stopReason());
}

// 8) empty queue is done, and says so
{
  const orchestrator = new Orchestrator([], {});
  check("empty is finished", orchestrator.finished() === true);
  check("empty reason is queue drained", orchestrator.stopReason() === "队列清空", orchestrator.stopReason());
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
