/**
 * Central orchestrator: one decision point, many interchangeable workers.
 *
 * The story this replaces — `fanout` — splits a task up front and runs the pieces in parallel.
 * That is fan-out, not orchestration: the plan is fixed before anything is learned, and results
 * cannot change what happens next.
 *
 * This module is the other shape. A single orchestrator owns the queue and decides, task by task,
 * **who gets the next one**; workers are stateless executors that never see the whole picture.
 * Three properties follow from that and are the reason to build it:
 *
 * 1. **Dynamic dispatch** — a result can enqueue follow-up work (a verifier that finds a gap, a
 *    researcher that finds a new source). The plan is revised, not replayed.
 * 2. **One arbiter** — routing, retries and stopping all happen in one place, so they can be
 *    logged and reasoned about. Workers cannot silently expand scope.
 * 3. **Bounded** — every loop has a step budget, a wall-clock deadline and a hard concurrency cap.
 *    An orchestrator without bounds is a fork bomb with extra steps.
 *
 * What this deliberately does not do: workers do not talk to each other, and there is no
 * negotiation. Same trade-off as `fanout` — predictable failure modes beat emergent behaviour at
 * this size.
 */
export type Role = "researcher" | "coder" | "writer" | "verifier" | "worker";

export type Task = {
  id: string;
  title: string;
  prompt: string;
  role: Role;
  /** Ids that must be finished first. Empty means ready immediately. */
  deps: string[];
  status: "pending" | "running" | "done" | "failed" | "skipped";
  attempts: number;
  result?: string;
  error?: string;
};

export type Dispatch = {
  task: Task;
  /** Follow-up tasks the orchestrator decided to add after seeing this result. */
  followUps: Array<Omit<Task, "status" | "attempts">>;
};

export type OrchestratorOptions = {
  maxSteps?: number;
  maxTasks?: number;
  concurrency?: number;
  deadlineMs?: number;
  maxAttempts?: number;
};

/** Keyword routing: cheap, explainable, and good enough to be reviewed. */
export function route(task: { title: string; prompt: string }): Role {
  const text = `${task.title} ${task.prompt}`;
  if (/(验证|检查|复核|测试|assert|verify|bench)/i.test(text)) return "verifier";
  if (/(检索|调研|查|搜索|资料|search|research)/i.test(text)) return "researcher";
  if (/(代码|实现|脚本|函数|重构|code|implement)/i.test(text)) return "coder";
  if (/(写|文案|总结|报告|文档|draft|write|summary)/i.test(text)) return "writer";
  return "worker";
}

export class Orchestrator {
  private readonly tasks = new Map<string, Task>();
  private readonly options: Required<OrchestratorOptions>;
  private readonly startedAt = Date.now();
  private steps = 0;

  constructor(tasks: Array<Omit<Task, "status" | "attempts">>, options: OrchestratorOptions = {}) {
    this.options = {
      maxSteps: options.maxSteps ?? 24,
      maxTasks: options.maxTasks ?? 12,
      concurrency: options.concurrency ?? 3,
      deadlineMs: options.deadlineMs ?? 10 * 60_000,
      maxAttempts: options.maxAttempts ?? 2,
    };
    for (const task of tasks) this.add(task);
  }

  private add(task: Omit<Task, "status" | "attempts">): Task {
    const full: Task = { ...task, status: "pending", attempts: 0 };
    this.tasks.set(full.id, full);
    return full;
  }

  get all(): Task[] {
    return [...this.tasks.values()];
  }

  /** Tasks whose dependencies are satisfied, ordered deterministically. */
  ready(): Task[] {
    const done = new Set(this.all.filter((task) => task.status === "done").map((task) => task.id));
    return this.all
      .filter((task) => task.status === "pending" && task.deps.every((dep) => done.has(dep)))
      .sort((a, b) => a.id.localeCompare(b.id));
  }

  /** True when the loop must stop: nothing left, out of steps, over budget, or past the deadline. */
  finished(): boolean {
    if (this.steps >= this.options.maxSteps) return true;
    if (Date.now() - this.startedAt > this.options.deadlineMs) return true;
    const pending = this.all.some((task) => task.status === "pending" || task.status === "running");
    return !pending;
  }

  /** Why the loop stopped — worth logging, because "empty" and "out of budget" mean different things. */
  stopReason(): string {
    if (this.steps >= this.options.maxSteps) return `步数上限 ${this.options.maxSteps}`;
    if (Date.now() - this.startedAt > this.options.deadlineMs) return "超时";
    return "队列清空";
  }

  /**
   * Run one wave: dispatch up to `concurrency` ready tasks, then fold their results back.
   *
   * `execute` is injected so the scheduler itself stays testable without a model. It receives the
   * task and returns text plus optional follow-ups — the follow-ups are the dynamic part.
   */
  async wave(execute: (task: Task) => Promise<{ output: string; followUps?: Array<Omit<Task, "status" | "attempts">> }>): Promise<Dispatch[]> {
    const batch = this.ready().slice(0, this.options.concurrency);
    if (batch.length === 0) return [];
    this.steps += 1;

    for (const task of batch) task.status = "running";

    const settled = await Promise.all(
      batch.map(async (task) => {
        task.attempts += 1;
        try {
          const outcome = await execute(task);
          task.status = "done";
          task.result = outcome.output;
          const followUps = this.acceptFollowUps(outcome.followUps ?? []);
          return { task, followUps };
        } catch (error) {
          task.error = error instanceof Error ? error.message : String(error);
          task.status = task.attempts >= this.options.maxAttempts ? "failed" : "pending";
          return { task, followUps: [] };
        }
      }),
    );
    return settled;
  }

  /** Add follow-ups while respecting the task budget; the overflow is dropped, not queued. */
  private acceptFollowUps(items: Array<Omit<Task, "status" | "attempts">>): Array<Omit<Task, "status" | "attempts">> {
    const accepted: Array<Omit<Task, "status" | "attempts">> = [];
    for (const item of items) {
      if (this.tasks.size >= this.options.maxTasks) break;
      if (this.tasks.has(item.id)) continue;
      this.add(item);
      accepted.push(item);
    }
    return accepted;
  }

  summary(): { total: number; done: number; failed: number; pending: number; steps: number; stop: string } {
    const all = this.all;
    return {
      total: all.length,
      done: all.filter((task) => task.status === "done").length,
      failed: all.filter((task) => task.status === "failed").length,
      pending: all.filter((task) => task.status === "pending" || task.status === "running").length,
      steps: this.steps,
      stop: this.stopReason(),
    };
  }
}
