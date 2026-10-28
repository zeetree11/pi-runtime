import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import { CONTRACTS_FILE, DEFAULT_CONTRACTS_LIMIT, DEFAULT_SOUL_LIMIT, PERSONA_DIR, SOUL_FILE } from "./persona.ts";
import { detectSecret } from "./secrets.ts";

/**
 * Controlled self-modification, scoped to the *capability surface*.
 *
 * What the agent may change: its own persona files (`persona/SOUL.md`, `persona/CONTRACTS.md`).
 * What it may never change: `src/**`. That line is the whole design — a runtime that can rewrite
 * its own scheduler is one bad patch away from being unusable, while a runtime that can rewrite
 * its tone is one approval away from being better.
 *
 * The loop mirrors what a production self-evolution system needs, minus the parts this project
 * cannot honestly support:
 *
 *   propose → validate (allowlist, size, secrets) → park for human approval → apply → backup
 *             → revert on demand
 *
 * Missing, deliberately: an independent reviewer model (we have one model budget, so the reviewer
 * would be the same model that wrote the patch — worse than a human and more expensive), and an
 * automated gate suite (persona files have no tests; the runtime's tests do not cover them).
 * The human *is* the gate. Saying that out loud is more useful than pretending otherwise.
 */
export const ALLOWED_PATHS: Record<string, number> = {
  [`${PERSONA_DIR}/${SOUL_FILE}`]: DEFAULT_SOUL_LIMIT,
  [`${PERSONA_DIR}/${CONTRACTS_FILE}`]: DEFAULT_CONTRACTS_LIMIT,
};

export type ProposalStatus = "pending" | "applied" | "rejected" | "expired" | "reverted";

export type ProposalRow = {
  id: number;
  thread: string;
  path: string;
  before: string;
  after: string;
  rationale: string;
  status: ProposalStatus;
  createdAt: string;
  decidedAt: string | null;
  appliedAt: string | null;
  revertedAt: string | null;
};

export type ValidationIssue = { ok: false; reason: string };
export type ValidationOk = { ok: true; path: string; chars: number; limit: number };

export function validateProposal(input: { path: string; content: string }): ValidationOk | ValidationIssue {
  const key = String(input.path ?? "").trim().replace(/\\/g, "/").replace(/^\/+/, "");
  const limit = ALLOWED_PATHS[key];
  if (limit === undefined) {
    return {
      ok: false,
      reason: `不允许修改 ${key || "(空路径)"}：自改范围仅限 ${Object.keys(ALLOWED_PATHS).join(" / ")}。运行时代码必须由人改。`,
    };
  }
  const content = String(input.content ?? "");
  if (!content.trim()) return { ok: false, reason: "内容为空" };

  const chars = [...content].length;
  if (chars > limit) return { ok: false, reason: `超过 ${limit} 字符上限（当前 ${chars}）` };

  const secret = detectSecret(content);
  if (secret.sensitive) {
    return { ok: false, reason: `内容里疑似有凭据（${secret.reasons.join(",")}），人格文件不允许写入密钥` };
  }

  return { ok: true, path: key, chars, limit };
}

export const MCP_PREFIX = "mcp:";
export const MCP_CONFIG = ".pi/agent/mcp.json";
const ALLOWED_COMMANDS = ["node", "npx", "uvx", "python3", "deno", "bun"];
const MAX_SERVERS = 8;

/** Shape + safety checks for a proposed MCP server. Exported for tests. */
export function validateMcpServer(
  server: { name?: string; command?: string; args?: string[]; env?: Record<string, string>; exposure?: string },
  config: Record<string, unknown>,
): ValidationOk | ValidationIssue {
  const name = String(server.name ?? "").trim();
  if (!/^[a-z][a-z0-9_-]{1,31}$/.test(name)) {
    return { ok: false, reason: `名字不合法：${name || "(空)"}（小写字母开头，只含 a-z0-9_-，2–32 位）` };
  }

  const command = String(server.command ?? "").trim();
  if (!ALLOWED_COMMANDS.includes(command)) {
    return { ok: false, reason: `命令 ${command || "(空)"} 不在允许列表内（${ALLOWED_COMMANDS.join(", ")}）` };
  }

  const args = server.args ?? [];
  if (!Array.isArray(args) || args.some((arg) => typeof arg !== "string")) {
    return { ok: false, reason: "args 必须是字符串数组" };
  }
  if (args.join(" ").length > 1_000) return { ok: false, reason: "args 过长（上限 1000 字符）" };
  for (const arg of args) {
    // Absolute paths outside the workspace would let a server read the whole container.
    if (arg.startsWith("/") && !arg.startsWith("/workspace")) {
      return { ok: false, reason: `参数里出现工作区外的绝对路径：${arg}` };
    }
  }

  for (const [key, value] of Object.entries(server.env ?? {})) {
    if (typeof value !== "string") return { ok: false, reason: `env.${key} 必须是字符串` };
    if (detectSecret(value).sensitive) {
      return { ok: false, reason: `env.${key} 看起来是凭据；密钥请由人写进配置，不要让模型产生` };
    }
  }

  if (server.exposure && !["direct", "codemode", "deferred"].includes(server.exposure)) {
    return { ok: false, reason: `exposure 只能是 direct / codemode / deferred` };
  }

  const servers = (config.mcpServers ?? {}) as Record<string, unknown>;
  if (!servers[name] && Object.keys(servers).length >= MAX_SERVERS) {
    return { ok: false, reason: `MCP server 数量已达上限 ${MAX_SERVERS}，先删一个再增` };
  }

  return { ok: true, path: `${MCP_PREFIX}${name}`, chars: 0, limit: 0 };
}
export class ProposalStore {
  private readonly db: DatabaseSync;
  private readonly dataDir: string;
  private readonly ttlMinutes: number;

  constructor(dataDir: string, ttlMinutes = 30) {
    this.dataDir = dataDir;
    this.ttlMinutes = Math.max(1, ttlMinutes);
    this.db = new DatabaseSync(path.join(dataDir, "runtime.db"));
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec("PRAGMA busy_timeout = 5000;");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS proposals (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        thread      TEXT NOT NULL,
        path        TEXT NOT NULL,
        before      TEXT NOT NULL,
        after       TEXT NOT NULL,
        rationale   TEXT NOT NULL,
        status      TEXT NOT NULL DEFAULT 'pending',
        created_at  TEXT NOT NULL,
        expires_at  TEXT NOT NULL,
        decided_at  TEXT,
        applied_at  TEXT,
        reverted_at TEXT
      );
    `);
    this.db.exec("CREATE INDEX IF NOT EXISTS idx_proposals_pending ON proposals(thread, status, expires_at);");
  }

  // `relative`, not `path`: naming the parameter `path` shadows the node:path import and turns
  // path.join into a call on a string.
  private target(relative: string): string {
    return path.join(this.dataDir, relative);
  }

  request(input: { thread: string; path: string; content: string; rationale: string }):
    | { ok: true; proposal: ProposalRow }
    | { ok: false; reason: string } {
    const validation = validateProposal({ path: input.path, content: input.content });
    if (!validation.ok) return validation;

    const file = this.target(validation.path);
    const before = existsSync(file) ? readFileSync(file, "utf8") : "";
    if (before.trim() === input.content.trim()) {
      return { ok: false, reason: "新内容和现有内容相同，没有必要修改" };
    }

    const now = new Date();
    const expires = new Date(now.getTime() + this.ttlMinutes * 60_000);
    const result = this.db
      .prepare(
        `INSERT INTO proposals (thread, path, before, after, rationale, status, created_at, expires_at)
         VALUES (?, ?, ?, ?, ?, 'pending', ?, ?)`,
      )
      .run(
        input.thread,
        validation.path,
        before,
        input.content,
        String(input.rationale ?? "").slice(0, 1_000),
        now.toISOString(),
        expires.toISOString(),
      );
    return { ok: true, proposal: this.byId(Number(result.lastInsertRowid))! };
  }

  byId(id: number): ProposalRow | null {
    const row = this.db.prepare("SELECT * FROM proposals WHERE id = ?").get(id) as Record<string, unknown> | undefined;
    return row ? toRow(row) : null;
  }

  pendingFor(thread: string, now = new Date()): ProposalRow | null {
    const row = this.db
      .prepare(
        `SELECT * FROM proposals WHERE thread = ? AND status = 'pending' AND expires_at > ?
          ORDER BY id DESC LIMIT 1`,
      )
      .get(thread, now.toISOString()) as Record<string, unknown> | undefined;
    return row ? toRow(row) : null;
  }

  listPending(now = new Date()): ProposalRow[] {
    const rows = this.db
      .prepare("SELECT * FROM proposals WHERE status = 'pending' AND expires_at > ? ORDER BY id DESC")
      .all(now.toISOString()) as Array<Record<string, unknown>>;
    return rows.map(toRow);
  }

  expire(now = new Date()): number {
    const result = this.db
      .prepare("UPDATE proposals SET status = 'expired', decided_at = ? WHERE status = 'pending' AND expires_at <= ?")
      .run(now.toISOString(), now.toISOString());
    return Number(result.changes);
  }

  /**
   * Apply a proposal.
   *
   * Two kinds share one table: a persona edit writes a file, an MCP proposal patches
   * `agent/mcp.json`. `path` carries the discriminator (`mcp:<name>`), and `before`/`after` hold
   * only the affected slice — so a revert restores exactly what changed instead of rewriting the
   * whole config from a stale snapshot.
   */
  apply(id: number): ProposalRow | null {
    const row = this.byId(id);
    if (!row || row.status !== "pending") return null;

    if (row.path.startsWith(MCP_PREFIX)) {
      const name = row.path.slice(MCP_PREFIX.length);
      const config = this.readMcpConfig();
      const servers = (config.mcpServers ?? {}) as Record<string, unknown>;
      servers[name] = JSON.parse(row.after);
      config.mcpServers = servers;
      this.writeMcpConfig(config);
    } else {
      const file = this.target(row.path);
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(file, row.after, "utf8");
    }

    const now = new Date().toISOString();
    this.db
      .prepare("UPDATE proposals SET status = 'applied', decided_at = ?, applied_at = ? WHERE id = ?")
      .run(now, now, id);
    return this.byId(id);
  }

  reject(id: number): ProposalRow | null {
    const row = this.byId(id);
    if (!row || row.status !== "pending") return null;
    this.db.prepare("UPDATE proposals SET status = 'rejected', decided_at = ? WHERE id = ?").run(new Date().toISOString(), id);
    return this.byId(id);
  }

  /** Put the previous slice back. Only an applied proposal can be reverted. */
  revert(id: number): ProposalRow | null {
    const row = this.byId(id);
    if (!row || row.status !== "applied") return null;

    if (row.path.startsWith(MCP_PREFIX)) {
      const name = row.path.slice(MCP_PREFIX.length);
      const config = this.readMcpConfig();
      const servers = (config.mcpServers ?? {}) as Record<string, unknown>;
      if (row.before) servers[name] = JSON.parse(row.before);
      else delete servers[name];
      config.mcpServers = servers;
      this.writeMcpConfig(config);
    } else {
      const file = this.target(row.path);
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(file, row.before, "utf8");
    }

    this.db.prepare("UPDATE proposals SET status = 'reverted', reverted_at = ? WHERE id = ?").run(new Date().toISOString(), id);
    return this.byId(id);
  }

  // ── MCP servers ────────────────────────────────────────────────────────────────────────────

  private readMcpConfig(): Record<string, unknown> {
    const file = path.join(this.dataDir, MCP_CONFIG);
    if (!existsSync(file)) return { mcpServers: {} };
    try {
      return JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
    } catch {
      return { mcpServers: {} };
    }
  }

  private writeMcpConfig(config: Record<string, unknown>): void {
    const file = path.join(this.dataDir, MCP_CONFIG);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`, "utf8");
  }

  /**
   * Propose adding (or replacing) one MCP server.
   *
   * This is the riskiest thing the agent is allowed to request, because an MCP server is a process
   * that runs on every turn from then on. The guards below are the difference between "the agent
   * extended its toolkit" and "the agent installed a backdoor":
   * - `command` is allow-listed (no `bash -c`);
   * - args may only point inside `/workspace`;
   * - env values that look like credentials are refused, so nothing secret lands in a config file
   *   that the model can read back;
   * - the total number of servers is capped.
   * Even with all of that, this needs the human's approval to be applied.
   */
  requestMcp(input: {
    thread: string;
    server: { name: string; command: string; args?: string[]; env?: Record<string, string>; exposure?: string; description?: string };
    rationale: string;
  }): { ok: true; proposal: ProposalRow } | { ok: false; reason: string } {
    const validation = validateMcpServer(input.server, this.readMcpConfig());
    if (!validation.ok) return validation;

    const entry = {
      command: input.server.command,
      args: (input.server.args ?? []).slice(0, 16),
      ...(input.server.env ? { env: input.server.env } : {}),
      exposure: input.server.exposure ?? "direct",
      ...(input.server.description ? { description: input.server.description.slice(0, 200) } : {}),
    };

    const config = this.readMcpConfig();
    const existing = (config.mcpServers ?? {})[input.server.name];
    if (existing && JSON.stringify(existing) === JSON.stringify(entry)) {
      return { ok: false, reason: `${input.server.name} 已经有一模一样的配置` };
    }

    const now = new Date();
    const expires = new Date(now.getTime() + this.ttlMinutes * 60_000);
    const result = this.db
      .prepare(
        `INSERT INTO proposals (thread, path, before, after, rationale, status, created_at, expires_at)
         VALUES (?, ?, ?, ?, ?, 'pending', ?, ?)`,
      )
      .run(
        input.thread,
        `${MCP_PREFIX}${input.server.name}`,
        existing ? JSON.stringify(existing) : "",
        JSON.stringify(entry),
        String(input.rationale ?? "").slice(0, 1_000),
        now.toISOString(),
        expires.toISOString(),
      );
    return { ok: true, proposal: this.byId(Number(result.lastInsertRowid))! };
  }

  history(limit = 20): ProposalRow[] {
    const rows = this.db.prepare("SELECT * FROM proposals ORDER BY id DESC LIMIT ?").all(limit) as Array<Record<string, unknown>>;
    return rows.map(toRow);
  }
}

function toRow(row: Record<string, unknown>): ProposalRow {
  return {
    id: Number(row.id),
    thread: String(row.thread),
    path: String(row.path),
    before: String(row.before),
    after: String(row.after),
    rationale: String(row.rationale),
    status: String(row.status) as ProposalStatus,
    createdAt: String(row.created_at),
    decidedAt: row.decided_at ? String(row.decided_at) : null,
    appliedAt: row.applied_at ? String(row.applied_at) : null,
    revertedAt: row.reverted_at ? String(row.reverted_at) : null,
  };
}
