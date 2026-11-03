import { Orchestrator, route, type Task } from "./orchestrator.ts";

/**
 * Wire the scheduler to real execution.
 *
 * The scheduler knows *what* to run next; this module knows *how* to run it — one child per task,
 * on its own thread, with the existing task/event plumbing so every dispatch is auditable after
 * the fact. Keeping the two apart is why the scheduler is testable without a model: `runChild` is
 * injected here and mocked in tests.
 *
 * Thread naming matters: children get `<parent>#o<taskId>`, so their events cannot be mistaken for
 * the parent's, and their memory scope stays separate — the same isolation rule `fanout` uses.
 */
export type OrchestrateDeps = {
  /** Run one child and return its text. Reject to trigger the scheduler's retry path. */
  runChild: (input: { prompt: string; thread: string; task: Task }) => Promise<string>;
  log?: (message: string) => void;
  /** Records one event per scheduler decision, so a run can be replayed from the event log. */
  record?: (type: string, payload: Record<string, unknown>) => void;
};

export type OrchestrateResult = {
  tasks: Task[];
  summary: ReturnType<Orchestrator["summary"]>;
  /** Concatenated results of finished tasks, keyed by id, for the final synthesis step. */
  results: Array<{ id: string; title: string; output: string; ok: boolean }>;
};

export type OrchestrateOptions = {
  parentThread: string;
  maxSteps?: number;
  maxTasks?: number;
  concurrency?: number;
  deadlineMs?: number;
  maxAttempts?: number;
};

/** Run the loop to completion. Every wave is recorded; the loop always terminates by a bound. */
export async function orchestrate(
  seeds: Array<{ id: string; title: string; prompt: string }>,
  deps: OrchestrateDeps,
  options: OrchestrateOptions,
): Promise<OrchestrateResult> {
  const log = deps.log ?? (() => {});
  const record = deps.record ?? (() => {});

  const orchestrator = new Orchestrator(
    seeds.map((seed) => ({
      id: seed.id,
      title: seed.title,
      prompt: seed.prompt,
      role: route(seed),
      deps: [],
    })),
    {
      maxSteps: options.maxSteps,
      maxTasks: options.maxTasks,
      concurrency: options.concurrency,
      deadlineMs: options.deadlineMs,
      maxAttempts: options.maxAttempts,
    },
  );

  record("orchestrate_start", {
    seeds: seeds.map((seed) => seed.id),
    bounds: { maxSteps: options.maxSteps ?? 24, maxTasks: options.maxTasks ?? 12 },
  });

  while (!orchestrator.finished()) {
    const wave = await orchestrator.wave(async (task) => {
      const thread = `${options.parentThread}#o${task.id}`;
      log(`→ ${task.id}（${task.role}，第 ${task.attempts + 1} 次）`);
      record("orchestrate_dispatch", { id: task.id, role: task.role, thread, attempt: task.attempts + 1 });
      const output = await deps.runChild({ prompt: task.prompt, thread, task });
      return { output };
    });

    if (wave.length === 0) break;

    for (const { task } of wave) {
      if (task.status === "done") {
        record("orchestrate_result", { id: task.id, chars: (task.result ?? "").length });
        log(`✓ ${task.id}（${(task.result ?? "").length} 字符）`);
      } else {
        record("orchestrate_error", { id: task.id, error: (task.error ?? "").slice(0, 300), attempts: task.attempts });
        log(`✗ ${task.id}：${task.error ?? "未知"}`);
      }
    }
  }

  const summary = orchestrator.summary();
  record("orchestrate_stop", { ...summary });

  return {
    tasks: orchestrator.all,
    summary,
    results: orchestrator.all
      .filter((task) => task.status === "done")
      .map((task) => ({ id: task.id, title: task.title, output: task.result ?? "", ok: true })),
  };
}

/**
 * Split one goal into seed tasks.
 *
 * Kept as a prompt instead of a heuristic: the shape of a good decomposition depends on the goal,
 * and a keyword split would produce plausible-looking tasks that do not cover it. The orchestrator
 * revises the plan later; this only needs to be a reasonable start.
 */
export function buildSeedPrompt(goal: string, count: number): string {
  return [
    `把下面这个目标拆成 ${count} 个可以独立开始的初始任务。`,
    "要求：",
    "1. 每个任务自己就能产出有用的中间结果；",
    "2. 不要写「等前面完成」这类依赖描述，依赖由调度器负责；",
    "3. 输出严格 JSON：",
    `{"tasks":[{"id":"短英文标识","title":"短标题","prompt":"自足的任务描述"}]}`,
    "",
    "目标：",
    goal,
  ].join("\n");
}

/** Recover seed tasks from a model reply. Duplicate ids are suffixed rather than dropped. */
export function parseSeeds(text: string, count: number): Array<{ id: string; title: string; prompt: string }> {
  const cleaned = String(text ?? "").replace(/```(?:json)?/gi, "").trim();
  const firstObject = cleaned.indexOf("{");
  const firstArray = cleaned.indexOf("[");
  const asArray = firstArray !== -1 && (firstObject === -1 || firstArray < firstObject);
  const start = asArray ? firstArray : firstObject;
  const end = asArray ? cleaned.lastIndexOf("]") : cleaned.lastIndexOf("}");
  if (start === -1 || end <= start) return [];

  let parsed: any;
  try {
    parsed = JSON.parse(cleaned.slice(start, end + 1));
  } catch {
    return [];
  }
  const list = Array.isArray(parsed?.tasks) ? parsed.tasks : Array.isArray(parsed) ? parsed : [];
  const seen = new Set<string>();
  const seeds: Array<{ id: string; title: string; prompt: string }> = [];
  for (const item of list.slice(0, count)) {
    const prompt = String(item?.prompt ?? "").trim();
    if (!prompt) continue;
    let id = String(item?.id ?? `t${seeds.length + 1}`).trim().replace(/[^\w-]/g, "-").slice(0, 32) || `t${seeds.length + 1}`;
    while (seen.has(id)) id = `${id}-2`;
    seen.add(id);
    seeds.push({ id, title: String(item?.title ?? id).trim().slice(0, 40), prompt });
  }
  return seeds;
}
