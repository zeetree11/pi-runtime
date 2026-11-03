/**
 * Leases with fencing tokens, for multi-agent task assignment.
 *
 * The failure this replaces: treating "I stopped hearing from it" as "it stopped". A dropped
 * heartbeat only proves the orchestrator cannot see the worker — the worker may still be running,
 * still holding the task, and still about to write a result. Two consequences follow, and both
 * are handled here rather than by a timeout:
 *
 * 1. **Takeover needs a lease, not a silence.** A worker holds a task until `leaseUntil`. The
 *    orchestrator may reassign only after expiry, and it does so by incrementing `epoch`.
 * 2. **The old executor must be refused, not hoped away.** Every write carries the epoch it was
 *    working under. A result from an expired epoch is rejected (`stale`), so a worker that comes
 *    back from a pause cannot overwrite the new owner's work — the fencing token makes the
 *    duplicate write impossible instead of merely unlikely.
 *
 * What is deliberately not here: retrying the task from scratch. A takeover resumes from the
 * caller's checkpoint; that logic belongs to the task, this module only guarantees that exactly
 * one epoch is authoritative at a time.
 */
export type Lease = {
  taskId: string;
  /** Increments on every takeover; the fencing token. Older epochs can never submit. */
  epoch: number;
  owner: string;
  leaseUntil: number;
  /** Wall-clock of the last successful heartbeat, for diagnostics. */
  lastBeat: number;
};

export type SubmitResult =
  | { ok: true; epoch: number }
  | { ok: false; reason: "unknown-task" | "stale" | "not-owner"; current: number };

export class LeaseRegistry {
  private readonly leases = new Map<string, Lease>();
  private readonly ttlMs: number;
  private readonly clock: () => number;

  constructor(options: { ttlMs?: number; now?: () => number } = {}) {
    this.ttlMs = Math.max(1_000, options.ttlMs ?? 120_000);
    this.clock = options.now ?? (() => Date.now());
  }

  /** Create or take over a task. Only allowed when free or expired — never to steal a live lease. */
  claim(taskId: string, owner: string): Lease {
    const existing = this.leases.get(taskId);
    const now = this.clock();
    if (existing && existing.leaseUntil > now) {
      throw new Error(`任务 ${taskId} 仍由 ${existing.owner} 持有（epoch ${existing.epoch}），租约未过期`);
    }
    const lease: Lease = {
      taskId,
      epoch: (existing?.epoch ?? 0) + 1,
      owner,
      leaseUntil: now + this.ttlMs,
      lastBeat: now,
    };
    this.leases.set(taskId, lease);
    return lease;
  }

  /** Extend a lease. A heartbeat from an expired epoch is refused, because the task moved on. */
  heartbeat(taskId: string, epoch: number): boolean {
    const lease = this.leases.get(taskId);
    if (!lease || lease.epoch !== epoch) return false;
    // An expired lease cannot be revived: the orchestrator may already have handed the task to a
    // new owner, and letting the old worker resume would put two executors on one task.
    if (lease.leaseUntil <= this.clock()) return false;
    lease.leaseUntil = this.clock() + this.ttlMs;
    lease.lastBeat = this.clock();
    return true;
  }

  /** Submit a result under an epoch. Stale epochs are refused — this is the fence. */
  submit(taskId: string, epoch: number): SubmitResult {
    const lease = this.leases.get(taskId);
    if (!lease) return { ok: false, reason: "unknown-task", current: 0 };
    if (lease.epoch !== epoch) return { ok: false, reason: "stale", current: lease.epoch };
    this.leases.delete(taskId);
    return { ok: true, epoch };
  }

  /** Tasks whose lease has expired: the only ones a scheduler may reassign. */
  expired(): Lease[] {
    const now = this.clock();
    return [...this.leases.values()].filter((lease) => lease.leaseUntil <= now);
  }

  /** Snapshot for logs and for the health endpoint. */
  snapshot(): Lease[] {
    return [...this.leases.values()].sort((a, b) => a.taskId.localeCompare(b.taskId));
  }

  /** Stable idempotency key: task + step, so a retry of the same step cannot double-apply. */
  static idemKey(taskId: string, step: string, epoch: number): string {
    // Epoch is part of the key on purpose: a takeover is a new attempt at the same step, and the
    // external system must be able to tell "same step, new owner" from "same step, duplicate call".
    return `${taskId}:${step}:e${epoch}`;
  }
}
