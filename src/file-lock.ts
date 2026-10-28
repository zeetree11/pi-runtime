import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import path from "node:path";

/**
 * File locks for fan-out children.
 *
 * The honest framing first: **this is advisory**. Children edit files with `bash`/`write`, which
 * the runtime cannot intercept — a child that never asks for a lock will still write. What this
 * module provides is:
 *
 * 1. a lease table so children *can* coordinate ("who is editing src/a.ts right now"), with TTL
 *    so a crashed child does not block the others forever;
 * 2. a post-run conflict check that does not depend on cooperation: hash the workspace before and
 *    after, and report files that changed under two different owners.
 *
 * Why path-level, not file-level writes with OS locks: a lock file per path breaks down when the
 * editor is `git checkout` or a directory move, and it leaves stale files behind on crash. A row
 * with an expiry is self-healing, and it is queryable ("who holds what") which OS locks are not.
 *
 * Granularity: the lock key is the path the child names, normalised relative to the workspace. The
 * runtime never tries to guess a coarser or finer key — guessing wrong is worse than not locking.
 */
export type LockRow = {
  path: string;
  owner: string;
  acquiredAt: string;
  expiresAt: string;
  reason: string | null;
};

export type AcquireResult =
  | { ok: true; lock: LockRow }
  | { ok: false; heldBy: LockRow };

export class FileLockStore {
  private readonly db: DatabaseSync;
  private readonly defaultTtlMs: number;

  constructor(dataDir: string, defaultTtlMinutes = 10) {
    this.defaultTtlMs = Math.max(1, defaultTtlMinutes) * 60_000;
    this.db = new DatabaseSync(path.join(dataDir, "runtime.db"));
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec("PRAGMA busy_timeout = 5000;");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS file_locks (
        path        TEXT PRIMARY KEY,
        owner       TEXT NOT NULL,
        acquired_at TEXT NOT NULL,
        expires_at  TEXT NOT NULL,
        reason      TEXT
      );
    `);
  }

  /** Normalise so `/workspace/src/a.ts`, `src/a.ts` and `./src/a.ts` are one key. */
  static normalize(input: string, workspace = "/workspace"): string {
    let value = String(input ?? "").trim().replace(/\\/g, "/");
    if (!value) return "";
    const root = workspace.replace(/\/$/, "");
    if (value.startsWith(`${root}/`)) value = value.slice(root.length + 1);
    value = value.replace(/^\.\//, "").replace(/\/+/g, "/").replace(/^\/+/, "");
    return value;
  }

  acquire(input: {
    path: string;
    owner: string;
    reason?: string | null;
    ttlMinutes?: number;
    /** Injectable clock: expiry is the one behaviour that cannot be tested in real time. */
    now?: Date;
  }): AcquireResult {
    const key = FileLockStore.normalize(input.path);
    if (!key) throw new Error("path 为空");
    const clock = input.now ?? new Date();
    this.sweep(clock);

    const existing = this.byPath(key);
    if (existing && existing.owner !== input.owner) return { ok: false, heldBy: existing };

    const ttl = Math.max(1, input.ttlMinutes ?? Math.round(this.defaultTtlMs / 60_000));
    const expiresAt = new Date(clock.getTime() + ttl * 60_000).toISOString();
    this.db
      .prepare(
        `INSERT INTO file_locks (path, owner, acquired_at, expires_at, reason)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(path) DO UPDATE SET owner = excluded.owner, acquired_at = excluded.acquired_at,
           expires_at = excluded.expires_at, reason = excluded.reason`,
      )
      .run(key, input.owner, clock.toISOString(), expiresAt, input.reason ?? null);

    return { ok: true, lock: this.byPath(key)! };
  }

  release(input: { path: string; owner: string }): boolean {
    const key = FileLockStore.normalize(input.path);
    const result = this.db
      .prepare("DELETE FROM file_locks WHERE path = ? AND owner = ?")
      .run(key, input.owner);
    return Number(result.changes) > 0;
  }

  byPath(key: string): LockRow | null {
    const row = this.db.prepare("SELECT * FROM file_locks WHERE path = ?").get(key) as
      | Record<string, unknown>
      | undefined;
    return row ? toRow(row) : null;
  }

  list(now = new Date()): LockRow[] {
    const rows = this.db
      .prepare("SELECT * FROM file_locks WHERE expires_at > ? ORDER BY acquired_at ASC")
      .all(now.toISOString()) as Array<Record<string, unknown>>;
    return rows.map(toRow);
  }

  /** Drop expired leases. Called on every acquire so a crash never blocks the next child. */
  sweep(now = new Date()): number {
    const result = this.db.prepare("DELETE FROM file_locks WHERE expires_at <= ?").run(now.toISOString());
    return Number(result.changes);
  }
}

/**
 * Snapshot of file hashes, used to find writes that happened *while someone held a lock*.
 *
 * This is the part that does not require cooperation: even a child that ignored the lock still
 * shows up as "this file changed", and if the lock row names a different owner we can say whose
 * edit was concurrent. It cannot tell us the content of the losing edit — git is the place to
 * recover that.
 */
export type Snapshot = Map<string, string>;

export function hashFiles(files: Array<{ path: string; content: string }>): Snapshot {
  const snapshot: Snapshot = new Map();
  for (const file of files) {
    snapshot.set(FileLockStore.normalize(file.path), createHash("sha1").update(file.content).digest("hex"));
  }
  return snapshot;
}

export type ConflictReport = { path: string; holders: string[]; changed: boolean };

export function detectConflicts(input: {
  before: Snapshot;
  after: Snapshot;
  locks: LockRow[];
}): ConflictReport[] {
  const byPath = new Map<string, string[]>();
  for (const lock of input.locks) {
    const owners = byPath.get(lock.path) ?? [];
    owners.push(lock.owner);
    byPath.set(lock.path, owners);
  }

  const reports: ConflictReport[] = [];
  const paths = new Set([...input.before.keys(), ...input.after.keys()]);
  for (const filePath of paths) {
    const changed = input.before.get(filePath) !== input.after.get(filePath);
    if (!changed) continue;
    const holders = byPath.get(filePath) ?? [];
    // A change with no lock is not a conflict, it is just an uncoordinated write. Report only
    // when a lock exists, because otherwise every edit looks suspicious.
    if (holders.length === 0) continue;
    reports.push({ path: filePath, holders, changed });
  }
  return reports;
}

function toRow(row: Record<string, unknown>): LockRow {
  return {
    path: String(row.path),
    owner: String(row.owner),
    acquiredAt: String(row.acquired_at),
    expiresAt: String(row.expires_at),
    reason: row.reason ? String(row.reason) : null,
  };
}
