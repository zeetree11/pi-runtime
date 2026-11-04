/**
 * Checkpoints: make a takeover resume instead of restart.
 *
 * A lease (see `lease.ts`) answers *who* owns a task. This answers *where it got to*. Both are
 * needed: taking a task from a stalled worker is only useful if the new owner does not repeat the
 * work — and repeating it is not merely slow, it can double-apply an external side effect.
 *
 * Three rules carry the design:
 *
 * 1. **Steps are named, not numbered.** A step id like `write-report` survives a takeover; a
 *    counter does not, because the new owner has no idea how far the old one got.
 * 2. **A completed step is skipped across epochs.** Same task + same step id = same work, so the
 *    resume path never redoes it. Steps that are not idempotent must record an effect (next rule)
 *    instead of relying on being re-run.
 * 3. **An "unknown" effect blocks retry.** If a write may or may not have landed, retrying is a
 *    guess. The checkpoint records it as unknown, and the caller must verify against the external
 *    system (or hand it to a human) before the step can run again.
 *
 * Deliberately out of scope: compensation logic itself. This module records what happened and
 * refuses unsafe progress; deciding "roll back vs continue" is policy and belongs to the caller.
 */
export type EffectStatus = "applied" | "unknown" | "compensated";

export type SideEffect = {
  step: string;
  /** What the effect touches, e.g. `file:/workspace/report.md` or `http:POST /tickets`. */
  target: string;
  status: EffectStatus;
  at: number;
};

export type Checkpoint = {
  taskId: string;
  /** Epoch that last wrote this checkpoint; informational, never used to reject a resume. */
  epoch: number;
  completed: string[];
  artifacts: Record<string, { version: number; hash: string }>;
  effects: SideEffect[];
  updatedAt: number;
};

export type StepDecision =
  | { action: "run" }
  | { action: "skip"; reason: string }
  | { action: "verify"; reason: string; effects: SideEffect[] };

const empty = (taskId: string, epoch: number): Checkpoint => ({
  taskId,
  epoch,
  completed: [],
  artifacts: {},
  effects: [],
  updatedAt: 0,
});

export class CheckpointStore {
  private readonly checkpoints = new Map<string, Checkpoint>();
  private readonly clock: () => number;

  constructor(options: { now?: () => number } = {}) {
    this.clock = options.now ?? (() => Date.now());
  }

  load(taskId: string): Checkpoint {
    return this.checkpoints.get(taskId) ?? empty(taskId, 0);
  }

  /** Seed or replace from persisted state (e.g. a row loaded from SQLite at boot). */
  restore(checkpoint: Checkpoint): void {
    this.checkpoints.set(checkpoint.taskId, { ...checkpoint, effects: [...checkpoint.effects] });
  }

  /**
   * Decide what to do with a step before running it.
   *
   * The ordering matters: a dangling unknown effect is checked *before* the completed list, because
   * a step can be both "completed earlier" and "unknown now" after a failed retry — and the safe
   * answer is to verify, not to trust either record.
   */
  begin(taskId: string, step: string): StepDecision {
    const checkpoint = this.load(taskId);
    const dangling = checkpoint.effects.filter((effect) => effect.step === step && effect.status === "unknown");
    if (dangling.length > 0) {
      return { action: "verify", reason: `步骤 ${step} 有未确认的副作用，先核实再重跑`, effects: dangling };
    }
    if (checkpoint.completed.includes(step)) {
      return { action: "skip", reason: `步骤 ${step} 已在第 ${checkpoint.epoch} 次执行中完成` };
    }
    return { action: "run" };
  }

  complete(taskId: string, step: string, epoch: number): Checkpoint {
    const checkpoint = this.load(taskId);
    if (!checkpoint.completed.includes(step)) checkpoint.completed.push(step);
    checkpoint.epoch = epoch;
    checkpoint.updatedAt = this.clock();
    this.checkpoints.set(taskId, checkpoint);
    return checkpoint;
  }

  /** Record an external write. `unknown` means "we asked, we did not hear back". */
  effect(taskId: string, step: string, target: string, status: EffectStatus): Checkpoint {
    const checkpoint = this.load(taskId);
    const existing = checkpoint.effects.find((item) => item.step === step && item.target === target);
    if (existing) {
      existing.status = status;
      existing.at = this.clock();
    } else {
      checkpoint.effects.push({ step, target, status, at: this.clock() });
    }
    checkpoint.updatedAt = this.clock();
    this.checkpoints.set(taskId, checkpoint);
    return checkpoint;
  }

  /** Mark an artifact produced by a step; the version increments so a resume can compare baselines. */
  artifact(taskId: string, path: string, hash: string): Checkpoint {
    const checkpoint = this.load(taskId);
    const previous = checkpoint.artifacts[path];
    checkpoint.artifacts[path] = { version: (previous?.version ?? 0) + 1, hash };
    checkpoint.updatedAt = this.clock();
    this.checkpoints.set(taskId, checkpoint);
    return checkpoint;
  }

  /** Steps still to do, in the caller's order. */
  remaining(taskId: string, steps: string[]): string[] {
    const checkpoint = this.load(taskId);
    return steps.filter((step) => !checkpoint.completed.includes(step));
  }

  /** Effects that must be verified before the task can continue. */
  unresolved(taskId: string): SideEffect[] {
    return this.load(taskId).effects.filter((effect) => effect.status === "unknown");
  }
}
