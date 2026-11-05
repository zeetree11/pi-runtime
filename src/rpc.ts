import { spawn } from "node:child_process";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";

/**
 * Record sent to / received from pi's RPC mode.
 * pi speaks strict JSONL over stdin/stdout: one JSON object per LF-terminated line.
 * Never use readline here: it also splits on U+2028/U+2029, which are legal inside JSON strings.
 */
export type RpcRecord = { type: string } & Record<string, any>;

type PendingEntry = {
  resolve: (value: any) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
};

export type PiRpcOptions = {
  cliPath: string;
  cwd: string;
  args: string[];
  env: Record<string, string | undefined>;
  /** Milliseconds to wait for a command response. */
  commandTimeoutMs?: number;
};

/**
 * A long-lived `pi --mode rpc` subprocess exposed as an async client.
 * Process boundary = isolation boundary: pi owns no port, no database; we own the state.
 */
export class PiRpc extends EventEmitter {
  private child: ChildProcessWithoutNullStreams | null = null;
  private buffer = "";
  private seq = 0;
  private readonly pending = new Map<string, PendingEntry>();
  private readonly stderrChunks: string[] = [];
  private readonly opts: PiRpcOptions;
  private stopped = false;
  private lastEventAt = Date.now();

  constructor(opts: PiRpcOptions) {
    super();
    this.opts = opts;
  }

  start(): void {
    this.child = spawn(process.execPath, [this.opts.cliPath, "--mode", "rpc", ...this.opts.args], {
      cwd: this.opts.cwd,
      // The caller builds the whole environment (see `piEnv`); inheriting `process.env` here
      // would undo the scrubbing that keeps credentials out of reach of a shell tool.
      env: { ...this.opts.env } as NodeJS.ProcessEnv,
      stdio: ["pipe", "pipe", "pipe"],
    });

    this.child.stdout.setEncoding("utf8");
    this.child.stdout.on("data", (chunk: string) => this.onStdout(chunk));

    this.child.stderr.setEncoding("utf8");
    this.child.stderr.on("data", (chunk: string) => {
      this.stderrChunks.push(chunk);
      if (this.stderrChunks.length > 60) this.stderrChunks.shift();
    });

    this.child.on("error", (error) => this.emit("fatal", error));

    this.child.on("exit", (code, signal) => {
      this.stopped = true;
      for (const entry of this.pending.values()) {
        clearTimeout(entry.timer);
        entry.reject(new Error(`pi exited (${code ?? signal})`));
      }
      this.pending.clear();
      this.emit("exit", { code, signal });
    });
  }

  get stderrTail(): string {
    return this.stderrChunks.join("");
  }

  /** Send a command and await its `response` record (correlated by id, not by order). */
  request(command: string, payload: Record<string, unknown> = {}, timeoutMs = this.opts.commandTimeoutMs ?? 60_000): Promise<any> {
    const id = `rt-${++this.seq}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`timeout after ${timeoutMs}ms: ${command}`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.write({ id, type: command, ...payload });
    });
  }

  getState(): Promise<any> {
    return this.request("get_state");
  }

  /**
   * Prompt the agent and resolve once it stops moving on its own.
   * `agent_end` is not the end: retries, compaction and queued work can follow.
   * `agent_settled` is the real "nothing more will happen" signal.
   *
   * The settle waiter is armed *before* the prompt is sent, and it is rejected if the child
   * exits or the caller aborts. Otherwise a dead process leaves the promise pending until the
   * wall clock, and a rejection nobody awaited becomes an unhandledRejection one timeout later.
   */
  async prompt(message: string, timeoutMs = 30 * 60_000, signal?: AbortSignal): Promise<void> {
    let timer: NodeJS.Timeout | undefined;
    let onRecord: ((record: RpcRecord) => void) | undefined;
    let onExit: ((info: { code: number | null; signal: NodeJS.Signals | null }) => void) | undefined;
    let onAbort: (() => void) | undefined;
    let done = false;
    let settle!: (error?: Error) => void;

    const settled = new Promise<void>((resolve, reject) => {
      const cleanup = () => {
        if (timer) clearTimeout(timer);
        if (onRecord) this.off("record", onRecord);
        if (onExit) this.off("exit", onExit);
        if (onAbort) signal?.removeEventListener("abort", onAbort);
      };
      settle = (error?: Error) => {
        if (done) return;
        done = true;
        cleanup();
        if (error) reject(error);
        else resolve();
      };
      timer = setTimeout(() => settle(new Error(`prompt did not settle within ${timeoutMs}ms`)), timeoutMs);
      onRecord = (record) => {
        if (record.type === "agent_settled") settle();
      };
      onExit = (info) => settle(new Error(`pi exited (${info?.code ?? info?.signal})`));
      onAbort = () => {
        settle(new Error("aborted"));
        void this.dispose();
      };
      this.on("record", onRecord);
      this.on("exit", onExit);
      if (signal?.aborted) settle(new Error("aborted"));
      else signal?.addEventListener("abort", onAbort);
    });

    // Attach the rejection handler before any await. If the prompt command fails, this promise
    // is still rejected by exit or by the timeout, and nothing else is awaiting it.
    let captured: Error | undefined;
    const observed = settled.then(
      () => undefined,
      (error: Error) => {
        captured = error;
      },
    );

    try {
      await this.request("prompt", { message });
      await observed;
      if (captured) throw captured;
    } finally {
      settle(new Error("prompt abandoned"));
    }
  }

  /** Graceful shutdown: close stdin, then kill if the process lingers. */
  async dispose(graceMs = 3_000): Promise<void> {
    if (!this.child || this.stopped) return;
    const exited = new Promise<void>((resolve) => this.once("exit", () => resolve()));
    try {
      this.child.stdin.end();
    } catch {
      /* already closed */
    }
    const timer = setTimeout(() => {
      try {
        this.child?.kill();
      } catch {
        /* ignore */
      }
    }, graceMs);
    await exited;
    clearTimeout(timer);
  }

  get idleMs(): number {
    return Date.now() - this.lastEventAt;
  }

  private write(record: unknown): void {
    if (!this.child || this.stopped) throw new Error("pi rpc is not running");
    this.child.stdin.write(JSON.stringify(record) + "\n");
  }

  private onStdout(chunk: string): void {
    this.buffer += chunk;
    let index: number;
    while ((index = this.buffer.indexOf("\n")) !== -1) {
      let line = this.buffer.slice(0, index);
      this.buffer = this.buffer.slice(index + 1);
      if (line.endsWith("\r")) line = line.slice(0, -1);
      if (!line.trim()) continue;
      this.handleLine(line);
    }
  }

  private handleLine(line: string): void {
    let record: RpcRecord;
    try {
      record = JSON.parse(line);
    } catch {
      this.emit("malformed", line);
      return;
    }
    this.lastEventAt = Date.now();

    if (record.type === "response" && typeof record.id === "string") {
      const entry = this.pending.get(record.id);
      if (entry) {
        clearTimeout(entry.timer);
        this.pending.delete(record.id);
        if (record.success) entry.resolve(record.data ?? {});
        else entry.reject(new Error(record.error ?? `command failed: ${record.command}`));
      }
    }

    this.emit("record", record);
  }
}
