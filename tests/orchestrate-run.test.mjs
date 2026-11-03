import { buildSeedPrompt, orchestrate, parseSeeds } from "../src/orchestrate-run.ts";

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

const seeds = [
  { id: "a", title: "调研", prompt: "调研这个方向" },
  { id: "b", title: "实现", prompt: "实现一个函数" },
];

// 1) end-to-end loop with an injected executor
{
  const events = [];
  const run = await orchestrate(
    seeds,
    {
      runChild: async ({ prompt, thread }) => {
        await new Promise((resolve) => setTimeout(resolve, 2));
        return `${prompt} 的结果（${thread}）`;
      },
      record: (type, payload) => events.push({ type, payload }),
    },
    { parentThread: "qq:group:1", concurrency: 2 },
  );

  check("both tasks done", run.summary.done === 2, JSON.stringify(run.summary));
  check("results carry output", run.results.length === 2 && run.results.every((r) => r.output.length > 0));
  check("child threads are namespaced", run.results.every((r) => r.output.includes("#oa") || r.output.includes("#ob")), JSON.stringify(run.results));
  check("start recorded", events.some((e) => e.type === "orchestrate_start"));
  check("each dispatch recorded", events.filter((e) => e.type === "orchestrate_dispatch").length === 2);
  check("results recorded", events.filter((e) => e.type === "orchestrate_result").length === 2);
  check("stop recorded with reason", events.some((e) => e.type === "orchestrate_stop" && e.payload.stop));
}

// 2) a failing child is retried, then reported as failed
{
  let calls = 0;
  const run = await orchestrate(
    [{ id: "bad", title: "会失败", prompt: "失败吧" }],
    {
      runChild: async () => {
        calls += 1;
        throw new Error("boom");
      },
    },
    { parentThread: "t", maxAttempts: 2, maxSteps: 5 },
  );
  check("retried once", calls === 2, String(calls));
  check("reported failed", run.summary.failed === 1, JSON.stringify(run.summary));
  check("no results from failures", run.results.length === 0);
}

// 3) bounds are enforced even when children always succeed
{
  const run = await orchestrate(
    Array.from({ length: 6 }, (_, i) => ({ id: `s${i}`, title: `任务${i}`, prompt: `做${i}` })),
    { runChild: async ({ prompt }) => prompt },
    { parentThread: "t", maxTasks: 6, maxSteps: 2, concurrency: 2 },
  );
  check("step budget stops early", run.summary.steps === 2, String(run.summary.steps));
  check("not everything ran", run.summary.done < 6, JSON.stringify(run.summary));
  check("stop reason names the bound", /步数上限/.test(run.summary.stop), run.summary.stop);
}

// 4) seed prompt mentions the goal and the count
{
  const prompt = buildSeedPrompt("把 README 的部署章节写清楚", 3);
  check("goal included", prompt.includes("部署章节"));
  check("count included", prompt.includes("3 个"));
  check("asks for JSON", prompt.includes('"tasks"'));
}

// 5) seed parsing tolerates fences, arrays and duplicate ids
{
  const fenced = parseSeeds('```json\n{"tasks":[{"id":"a","title":"一","prompt":"做一"},{"id":"b","title":"二","prompt":"做二"}]}\n```', 2);
  check("fenced json parsed", fenced.length === 2, JSON.stringify(fenced));

  const array = parseSeeds('[{"id":"x","title":"X","prompt":"做X"}]', 3);
  check("bare array parsed", array.length === 1 && array[0].id === "x");

  const dupes = parseSeeds('{"tasks":[{"id":"a","prompt":"1"},{"id":"a","prompt":"2"}]}', 2);
  check("duplicate ids are suffixed", dupes.length === 2 && dupes[0].id !== dupes[1].id, JSON.stringify(dupes.map((s) => s.id)));

  check("garbage yields nothing", parseSeeds("模型没给 JSON", 2).length === 0);
  check("empty prompt skipped", parseSeeds('{"tasks":[{"id":"a","prompt":"  "}]}', 2).length === 0);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
