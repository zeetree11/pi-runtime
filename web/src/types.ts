export type UsageToday = { total: number; cost: number; runs: number };

export type Health = {
  ok: true;
  name: "Tree-Agent";
  channel: "web";
  ownerName: string;
  provider: string | null;
  model: string | null;
  workspace: string;
  sandbox: string;
  memoryEnabled: boolean;
  usageToday: UsageToday;
};

export type SessionSummary = {
  id: string;
  title: string;
  updatedAt: string;
  events: number;
};

export type ToolTrace = {
  callId: string;
  name: string;
  isError: boolean;
  preview: string;
  argsPreview?: string;
};

export type Attachment = { name: string; path: string; bytes: number };

export type ServerMessage = {
  id: number;
  role: "user" | "assistant";
  speaker: string;
  text: string;
  createdAt: string;
  taskId: string | null;
  tools: ToolTrace[];
  steps: string[];
  attachments: Attachment[];
};

export type PendingApproval = { id: number; action: string; prompt: string; expiresAt: string };
export type PendingProposal = { id: number; path: string; rationale: string };

export type SessionDetail = SessionSummary & {
  messages: ServerMessage[];
  pendingApproval: PendingApproval | null;
  pendingProposal: PendingProposal | null;
};

export type LiveTool = {
  callId: string;
  name: string;
  phase: "start" | "end";
  isError?: boolean;
  preview?: string;
  argsPreview?: string;
};

export type ChatMessage = {
  key: string;
  role: "user" | "assistant";
  text: string;
  thinking?: string;
  tools: LiveTool[];
  steps: string[];
  notices: string[];
  attachments: Attachment[];
  pending?: boolean;
  stopped?: boolean;
  error?: string;
};

export type ServerEvent =
  | { type: "status"; message: string }
  | { type: "text"; delta: string }
  | { type: "thinking"; delta: string }
  | { type: "tool"; phase: "start" | "end"; name: string; callId?: string; isError?: boolean; preview?: string; argsPreview?: string }
  | { type: "notice"; text: string }
  | { type: "attachment"; name: string; path: string; bytes: number }
  | { type: "done"; text: string; taskId: string; stopped?: boolean }
  | { type: "error"; message: string };

export type MemoryItem = {
  id: number;
  category: "preference" | "fact" | "event" | string;
  key: string;
  content: string;
  status: string;
  importance: number;
  subject: string;
  evidenceQuote: string | null;
  evidenceEventId: number | null;
  thread: string | null;
  updatedAt: string;
  useCount: number;
};

export type SkillItem = { name: string; description: string; scope: string; bytes: number; path: string };
export type McpItem = { name: string; command?: string; enabled: boolean };
export type KnowledgeDoc = { source: string; chunks: number; chars: number };
export type ReminderItem = { id: number; thread: string; channel: string; chatId: string; text: string; dueAt: string };
export type StateItem = { key: string; scope: string; value: string; expires_at: string; status: string; use_count: number };
export type PersonaFile = { path: string; role: string; chars: number; limit: number; percent: number; text: string } | null;

export type PublicConfig = {
  ownerName: string;
  provider: string | null;
  model: string | null;
  workspace: string;
  sandbox: string;
  maxMinutes: number;
  memory: { enabled: boolean; budgetChars: number; batchTurns: number; idleMinutes: number; autoExtract: boolean };
  context: { turns: number; budgetChars: number; summaryEnabled: boolean; summaryTriggerChars: number; summaryMaxChars: number };
  limits: { maxAttempts: number; maxConcurrent: number; dailyTokens: number; taskTokens: number };
  usageToday: UsageToday;
};
