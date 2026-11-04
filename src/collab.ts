import { FileLockStore } from "./file-lock.ts";

/**
 * Several agents editing one repository, without letting them fight over `main`.
 *
 * The rules here are the ones that make concurrent edits survivable in practice:
 *
 * 1. **Isolation** — every task works on its own branch. Nobody writes the target branch except
 *    the integrator, so "who broke main" has exactly one answer.
 * 2. **Baseline check** — an agent records the commit it started from. If `main` moved under it, the
 *    merge is refused instead of silently overwriting the newer change.
 * 3. **Hot-file lease** — a small set of files (lockfiles, generated indexes) cannot be merged
 *    concurrently; a short lease serialises them while ordinary files stay parallel.
 * 4. **Ordered integration** — the integrator merges in dependency order and reports conflicts
 *    back to the owning agent, instead of resolving them itself. A conflict is information about
 *    the task, not a merge problem to be papered over.
 *
 * Not included: actually running git. These are the decisions; the commands are `git worktree add`
 * and `git merge --no-ff`, wrapped by whoever owns the repository.
 */
export type Change = {
  taskId: string;
  branch: string;
  /** Commit the agent started from. Used to detect that the target moved. */
  baseline: string;
  deps: string[];
  /** Files the change touches; used for overlap warnings and hot-file serialisation. */
  files: string[];
};

export type MergeDecision =
  | { ok: true; order: string[] }
  | { ok: false; reason: string; conflicts: string[] };

/** Dependency order, with stable tie-breaking so two runs integrate identically. */
export function mergeOrder(changes: Change[]): string[] {
  const byId = new Map(changes.map((change) => [change.taskId, change]));
  const done = new Set<string>();
  const order: string[] = [];
  let guard = 0;

  while (order.length < changes.length && guard < changes.length * changes.length + 10) {
    guard += 1;
    const ready = changes
      .filter((change) => !done.has(change.taskId))
      .filter((change) => change.deps.every((dep) => done.has(dep) || !byId.has(dep)))
      .map((change) => change.taskId)
      .sort();
    if (ready.length === 0) break; // a cycle, or a dependency that never resolved
    for (const id of ready) {
      done.add(id);
      order.push(id);
    }
  }
  return order;
}

/** Files touched by more than one change: worth surfacing before anyone merges. */
export function overlaps(changes: Change[]): string[] {
  const owners = new Map<string, Set<string>>();
  for (const change of changes) {
    for (const file of change.files) {
      const set = owners.get(file) ?? new Set();
      set.add(change.taskId);
      owners.set(file, set);
    }
  }
  return [...owners.entries()].filter(([, set]) => set.size > 1).map(([file]) => file).sort();
}

export type IntegratorOptions = {
  target: string;
  /** Branch tip of the target at integration time. */
  head: string;
  /** Paths that must be merged one at a time. */
  hotFiles?: string[];
  locks?: FileLockStore;
};

/**
 * The only component allowed to write the target branch.
 *
 * `plan()` is pure and can be reviewed before anything runs; `acquireHot()` returns the lock
 * holder for a hot file, so the caller can serialise merges around those paths.
 */
export class Integrator {
  private readonly options: IntegratorOptions;

  constructor(options: IntegratorOptions) {
    this.options = options;
  }

  /** Decide whether this batch can be merged, and in what order. */
  plan(changes: Change[]): MergeDecision {
    if (changes.length === 0) return { ok: true, order: [] };

    const stale = changes.filter((change) => change.baseline !== this.options.head);
    if (stale.length > 0) {
      return {
        ok: false,
        reason: `目标分支已从 ${this.options.head.slice(0, 7)} 前进，${stale.map((c) => c.taskId).join(",")} 的基线过期`,
        conflicts: stale.map((change) => change.taskId),
      };
    }

    const order = mergeOrder(changes);
    if (order.length !== changes.length) {
      const missing = changes.filter((change) => !order.includes(change.taskId)).map((change) => change.taskId);
      return { ok: false, reason: `依赖无法排序（有环或缺失）：${missing.join(",")}`, conflicts: missing };
    }

    return { ok: true, order };
  }

  /** Which hot files this batch would touch, and therefore which merges must serialise. */
  hotConflicts(changes: Change[]): string[] {
    const hot = new Set(this.options.hotFiles ?? []);
    const touched = new Set(changes.flatMap((change) => change.files));
    return [...touched].filter((file) => hot.has(file)).sort();
  }

  /** Acquire the integrator lock for a hot file; used to keep merges one-at-a-time. */
  acquireHot(file: string, ttlMinutes = 2): boolean {
    if (!this.options.locks) return true;
    const result = this.options.locks.acquire({ path: file, owner: `integrator:${this.options.target}`, ttlMinutes });
    return result.ok;
  }
}

/**
 * Route a failed merge back to the change that owns the conflict.
 *
 * The point is that the integrator does not fix content: it names the task, hands back the current
 * baseline, the conflicting file and the failing check, and lets the owning agent redo the work
 * against the new base.
 */
export function conflictReport(input: {
  taskId: string;
  file: string;
  head: string;
  failingCheck?: string;
}): { taskId: string; instructions: string } {
  const lines = [
    `合并冲突：${input.file} 与目标分支 ${input.head.slice(0, 7)} 冲突。`,
    "请在最新基线上重做这个文件，不要直接覆盖对方的改动。",
  ];
  if (input.failingCheck) lines.push(`相关检查失败：${input.failingCheck}`);
  return { taskId: input.taskId, instructions: lines.join("\n") };
}
