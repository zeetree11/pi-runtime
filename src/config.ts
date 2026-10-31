import { copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, symlinkSync, unlinkSync } from "node:fs";
import path from "node:path";
import { DEFAULT_MODE, normalizeMode, scrubEnv, toolArgs } from "./sandbox.ts";
import type { SandboxMode } from "./sandbox.ts";
import { fileURLToPath } from "node:url";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const DATA_DIR = process.env.PI_RT_DATA_DIR ? path.resolve(process.env.PI_RT_DATA_DIR) : path.join(ROOT, "data");
/** Isolated pi config dir, so the runtime never touches ~/.pi/agent. */
export const PI_CONFIG_DIR = process.env.PI_RT_PI_DIR
  ? path.resolve(process.env.PI_RT_PI_DIR)
  : path.join(DATA_DIR, "pi");
export const DB_PATH = path.join(DATA_DIR, "runtime.db");
export const PI_CLI = path.join(
  ROOT,
  "node_modules",
  "@earendil-works",
  "pi-coding-agent",
  "dist",
  "bundle",
  "cli.js",
);

export type FeishuConfig = {
  appId?: string;
  appSecret?: string;
  encryptKey?: string;
  verificationToken?: string;
};

export type LimitConfig = {
  /** Total attempts per task, including the first. */
  maxAttempts: number;
  retryBaseMs: number;
  maxRetryMs: number;
  maxConcurrent: number;
  minIntervalMs: number;
  /** 0 disables the corresponding budget. */
  dailyTokens: number;
  taskTokens: number;
};

export type RuntimeConfig = {
  /** Absolute path of the data directory (database, memory files). */
  dataDir: string;
  provider?: string;
  model?: string;
  /** Working directory the agent operates in. */
  workspace: string;
  /** Hard wall-clock cap per task, in minutes. */
  maxMinutes: number;
  /** The person this agent belongs to. Becomes the canonical subject for the owner. */
  ownerName: string;
  /** Channel user ids that also count as the owner (names differ across channels). */
  ownerIds: string[];
  /** Character budget for the injected memory block. */
  memoryBudgetChars: number;
  /** Inject memories into every prompt. */
  memoryEnabled: boolean;
  /** Distil automatically once this many undistilled turns pile up in a thread. */
  batchTurns: number;
  /** Also distil when a thread has been idle this long, even below batchTurns. */
  idleMinutes: number;
  /** How many compressed database snapshots to keep. */
  backupKeep: number;
  /** Tool capability policy for the pi subprocess. */
  sandbox: SandboxMode;
  /** Archive conversation events older than this. */
  archiveDays: number;
  /** Set false to disable automatic distillation (manual `distill` only). */
  autoExtract: boolean;
  /** Feishu app credentials; env wins over config.json. */
  feishu: FeishuConfig;
  /** Recent-message window carried into every prompt. */
  contextTurns: number;
  contextBudgetChars: number;
  /** Rolling compression of the cold part of a thread. */
  summaryEnabled: boolean;
  summaryTriggerChars: number;
  summaryMaxChars: number;
  /** Retry, concurrency and spend limits. */
  limits: LimitConfig;
};

export function ensureDirs(): void {
  for (const dir of [DATA_DIR, PI_CONFIG_DIR]) mkdirSync(dir, { recursive: true });
  ensureAgentConfig();
}

export function loadConfig(): RuntimeConfig {
  const file = path.join(ROOT, "config.json");
  const raw = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {};
  return {
    dataDir: DATA_DIR,
    provider: process.env.PI_RT_PROVIDER ?? raw.provider,
    model: process.env.PI_RT_MODEL ?? raw.model,
    workspace: path.resolve(process.env.PI_RT_WORKSPACE ?? raw.workspace ?? process.cwd()),
    maxMinutes: Number(process.env.PI_RT_MAX_MINUTES ?? raw.maxMinutes ?? 30),
    ownerName: String(process.env.PI_RT_OWNER ?? raw.ownerName ?? "Rick"),
    ownerIds: String(process.env.PI_RT_OWNER_IDS ?? (raw.ownerIds ?? []).join(","))
      .split(",")
      .map((id: string) => id.trim())
      .filter(Boolean),
    memoryBudgetChars: Number(process.env.PI_RT_MEMORY_BUDGET ?? raw.memory?.budgetChars ?? 1_800),
    memoryEnabled: (process.env.PI_RT_MEMORY ?? String(raw.memory?.enabled ?? true)) !== "false",
    batchTurns: Number(process.env.PI_RT_BATCH_TURNS ?? raw.memory?.batchTurns ?? 10),
    idleMinutes: Number(process.env.PI_RT_IDLE_MINUTES ?? raw.memory?.idleMinutes ?? 15),
    backupKeep: Number(process.env.PI_RT_BACKUP_KEEP ?? raw.limits?.backupKeep ?? 7),
    sandbox: normalizeMode(process.env.PI_RT_SANDBOX ?? raw.sandbox?.mode ?? DEFAULT_MODE),
    archiveDays: Number(process.env.PI_RT_ARCHIVE_DAYS ?? raw.limits?.archiveDays ?? 30),
    autoExtract: (process.env.PI_RT_AUTO_EXTRACT ?? String(raw.memory?.autoExtract ?? true)) !== "false",
    feishu: {
      appId: process.env.FEISHU_APP_ID ?? raw.feishu?.appId,
      appSecret: process.env.FEISHU_APP_SECRET ?? raw.feishu?.appSecret,
      encryptKey: process.env.FEISHU_ENCRYPT_KEY ?? raw.feishu?.encryptKey,
      verificationToken: process.env.FEISHU_VERIFICATION_TOKEN ?? raw.feishu?.verificationToken,
    },
    contextTurns: Number(process.env.PI_RT_CONTEXT_TURNS ?? raw.context?.turns ?? 6),
    contextBudgetChars: Number(process.env.PI_RT_CONTEXT_BUDGET ?? raw.context?.budgetChars ?? 4_000),
    summaryEnabled: (process.env.PI_RT_SUMMARY ?? String(raw.context?.summary ?? true)) !== "false",
    summaryTriggerChars: Number(process.env.PI_RT_SUMMARY_TRIGGER ?? raw.context?.summaryTriggerChars ?? 2_400),
    summaryMaxChars: Number(process.env.PI_RT_SUMMARY_MAX ?? raw.context?.summaryMaxChars ?? 1_200),
    limits: {
      maxAttempts: Number(process.env.PI_RT_MAX_ATTEMPTS ?? raw.limits?.maxAttempts ?? 3),
      retryBaseMs: Number(process.env.PI_RT_RETRY_BASE_MS ?? raw.limits?.retryBaseMs ?? 2_000),
      maxRetryMs: Number(process.env.PI_RT_MAX_RETRY_MS ?? raw.limits?.maxRetryMs ?? 30_000),
      maxConcurrent: Number(process.env.PI_RT_MAX_CONCURRENT ?? raw.limits?.maxConcurrent ?? 1),
      minIntervalMs: Number(process.env.PI_RT_MIN_INTERVAL_MS ?? raw.limits?.minIntervalMs ?? 0),
      dailyTokens: Number(process.env.PI_RT_DAILY_TOKENS ?? raw.limits?.dailyTokens ?? 2_000_000),
      taskTokens: Number(process.env.PI_RT_TASK_TOKENS ?? raw.limits?.taskTokens ?? 200_000),
    },
  };
}

/**
 * Environment handed to every pi subprocess.
 *
 * Built from an OS whitelist rather than `process.env`: the child gets a shell in `full` mode,
 * and inheriting the parent environment would let one `echo $FEISHU_APP_SECRET` exfiltrate a
 * credential. pi reads its own model credentials from its config directory, so nothing needed
 * is lost by dropping the rest.
 */
/**
 * Make sure the MCP config is where pi actually looks for it.
 *
 * `PI_CODING_AGENT_DIR` overrides pi's home, so pi reads `<PI_CODING_AGENT_DIR>/mcp.json`. We keep
 * the file in `<data>/.pi/agent/mcp.json` (same place the operator edits). When those two differ,
 * pi starts with **zero** MCP servers and the model truthfully reports "I only have read/write/exec"
 * — a failure that looks like a personality problem and is actually a path problem.
 *
 * Symlink rather than copy: one source of truth, and editing either path edits both.
 */
export function ensureAgentConfig(): void {
  const target = path.join(DATA_DIR, ".pi", "agent", "mcp.json");
  const link = path.join(PI_CONFIG_DIR, "mcp.json");
  if (!existsSync(target)) return;
  try {
    if (existsSync(link)) {
      const existing = realpathSync(link);
      if (existing === realpathSync(target)) return;
      if (lstatSync(link).isSymbolicLink()) unlinkSync(link);
      else return; // a real file the operator wrote on purpose: leave it alone
    }
    symlinkSync(target, link);
  } catch {
    try {
      copyFileSync(target, link);
    } catch {
      /* read-only home: pi will run without MCP, which doctor reports */
    }
  }
}

export function piConfigPath(): string {
  return path.join(PI_CONFIG_DIR, "mcp.json");
}

export function piEnv(cfg: RuntimeConfig, base: Record<string, string | undefined> = process.env): Record<string, string> {
  return scrubEnv(base, {
    PI_CODING_AGENT_DIR: PI_CONFIG_DIR,
    PI_SKIP_VERSION_CHECK: "1",
    PI_TELEMETRY: "0",
    PI_RT_PROVIDER: cfg.provider,
    PI_RT_MODEL: cfg.model,
  });
}

/** CLI flags for the pi subprocess. */
export function piArgs(cfg: RuntimeConfig): string[] {
  const args = ["--no-session", "--no-approve"];
  if (cfg.provider) args.push("--provider", cfg.provider);
  if (cfg.model) args.push("--model", cfg.model);
  // Enforced by pi, not requested in the prompt.
  args.push(...toolArgs(cfg.sandbox));
  return args;
}
