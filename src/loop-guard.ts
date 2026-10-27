/**
 * Loop guard: detect an agent that keeps calling the same tool with the same arguments.
 *
 * Why this exists: `maxMinutes` bounds wall-clock, but a stuck agent burns the whole budget
 * making identical calls — it looks busy, produces nothing, and the failure surfaces as a
 * timeout rather than as "it got stuck on `read`". Time limits catch the symptom; this catches
 * the cause.
 *
 * The signal is a *state fingerprint*: tool name + a stable serialisation of its arguments.
 * Repeated fingerprints in a row mean no progress was made, because a call that changes none of
 * its inputs cannot change the world.
 *
 * Deliberately not included:
 * - tool results. Hashing results would make two legitimate calls (`ls` twice around a write)
 *   look identical only if the world did not change — which is exactly what we cannot know.
 * - time. A wall-clock component would make every fingerprint unique.
 */
export type LoopLevel = "ok" | "warn" | "abort";

export type LoopDecision = {
  fingerprint: string;
  /** How many times this exact fingerprint occurred consecutively. */
  count: number;
  level: LoopLevel;
  reason?: string;
};

export type LoopGuardOptions = {
  /** Consecutive identical calls that trigger a warning. */
  warnAfter?: number;
  /** Consecutive identical calls that trigger an abort. */
  abortAfter?: number;
  /** Rough cap on retained history for diagnostics. */
  historyLimit?: number;
};

/** Deterministic serialisation: key order must not change the fingerprint. */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`);
  return `{${entries.join(",")}}`;
}

/**
 * One-way hash so a long file body in `write` does not become a long fingerprint.
 * FNV-1a 32-bit: enough to distinguish calls, cheap, no dependency.
 */
function hash(text: string): string {
  let value = 2166136261;
  for (let i = 0; i < text.length; i += 1) {
    value ^= text.charCodeAt(i);
    value = Math.imul(value, 16777619);
  }
  return (value >>> 0).toString(16).padStart(8, "0");
}

/** Accepts the several argument names different event shapes use. */
export function extractArgs(record: Record<string, unknown>): unknown {
  return record.input ?? record.args ?? record.arguments ?? record.parameters ?? record.toolInput ?? undefined;
}

export function fingerprint(toolName: string, args?: unknown): string {
  const name = String(toolName ?? "").trim() || "unknown";
  if (args === undefined) return `${name}#noargs`;
  return `${name}#${hash(stableStringify(args))}`;
}

export class LoopGuard {
  private readonly warnAfter: number;
  private readonly abortAfter: number;
  private readonly historyLimit: number;
  private lastFingerprint = "";
  private streak = 0;
  private history: string[] = [];
  private warned = false;

  constructor(options: LoopGuardOptions = {}) {
    this.warnAfter = Math.max(2, options.warnAfter ?? 3);
    this.abortAfter = Math.max(this.warnAfter + 1, options.abortAfter ?? 6);
    this.historyLimit = Math.max(8, options.historyLimit ?? 50);
  }

  /** Record one tool call and decide whether the run should continue. */
  observe(toolName: string, args?: unknown): LoopDecision {
    const value = fingerprint(toolName, args);
    if (value === this.lastFingerprint) {
      this.streak += 1;
    } else {
      this.lastFingerprint = value;
      this.streak = 1;
      this.warned = false;
    }
    this.history.push(value);
    if (this.history.length > this.historyLimit) this.history.shift();

    if (this.streak >= this.abortAfter) {
      return {
        fingerprint: value,
        count: this.streak,
        level: "abort",
        reason: `工具 ${toolName} 用相同参数连续调用 ${this.streak} 次，判定卡在循环里`,
      };
    }
    if (this.streak >= this.warnAfter && !this.warned) {
      this.warned = true;
      return {
        fingerprint: value,
        count: this.streak,
        level: "warn",
        reason: `工具 ${toolName} 已用相同参数连续调用 ${this.streak} 次`,
      };
    }
    return { fingerprint: value, count: this.streak, level: "ok" };
  }

  /** Recent fingerprints, oldest first — what the abort message reports as "attempted path". */
  get seen(): string[] {
    return [...this.history];
  }

  reset(): void {
    this.lastFingerprint = "";
    this.streak = 0;
    this.history = [];
    this.warned = false;
  }
}
