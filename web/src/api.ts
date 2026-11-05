import type {
  ChatMessage,
  Health,
  KnowledgeDoc,
  McpItem,
  MemoryItem,
  PersonaFile,
  PublicConfig,
  ReminderItem,
  ServerEvent,
  ServerMessage,
  SessionDetail,
  SessionSummary,
  SkillItem,
  StateItem,
} from "./types";

const TOKEN_KEY = "pi-rt-web-token";

export class ApiError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

export function getToken(): string {
  const injected = (globalThis as { __PI_RT_TOKEN__?: string }).__PI_RT_TOKEN__;
  if (typeof injected === "string" && injected.trim()) return injected.trim();
  return localStorage.getItem(TOKEN_KEY) ?? "";
}

export function setToken(value: string): void {
  if (value.trim()) localStorage.setItem(TOKEN_KEY, value.trim());
  else localStorage.removeItem(TOKEN_KEY);
}

function authHeaders(json = false): HeadersInit {
  const token = getToken();
  return {
    ...(json ? { "content-type": "application/json" } : {}),
    ...(token ? { authorization: `Bearer ${token}` } : {}),
  };
}

async function readError(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as { error?: string };
    return body.error || `HTTP ${response.status}`;
  } catch {
    return `HTTP ${response.status}`;
  }
}

async function getJson<T>(pathname: string): Promise<T> {
  const response = await fetch(pathname, { headers: authHeaders() });
  if (!response.ok) throw new ApiError(await readError(response), response.status);
  return (await response.json()) as T;
}

export const api = {
  health: () => getJson<Health>("/api/health"),
  sessions: async () => (await getJson<{ sessions: SessionSummary[] }>("/api/sessions")).sessions,
  createSession: async () => (await fetch("/api/sessions", { method: "POST", headers: authHeaders() }).then(async (response) => {
    if (!response.ok) throw new ApiError(await readError(response), response.status);
    return (await response.json()) as { id: string };
  })),
  session: (id: string) => getJson<SessionDetail>(`/api/sessions/${encodeURIComponent(id)}`),
  stop: async (id: string) => {
    const response = await fetch(`/api/sessions/${encodeURIComponent(id)}/stop`, { method: "POST", headers: authHeaders() });
    if (!response.ok && response.status !== 404) throw new ApiError(await readError(response), response.status);
  },
  memory: (all: boolean) => getJson<{ items: MemoryItem[]; stats: Record<string, number> }>(`/api/memory${all ? "?all=1" : ""}`),
  skills: () => getJson<{ skills: SkillItem[] }>("/api/skills"),
  mcp: () => getJson<{ servers: McpItem[] }>("/api/mcp"),
  knowledge: () => getJson<{ documents: KnowledgeDoc[]; stats: { documents: number; chunks: number; models: string[] } }>("/api/knowledge"),
  persona: () => getJson<{ soul: PersonaFile; contracts: PersonaFile }>("/api/persona"),
  reminders: () => getJson<{ pending: ReminderItem[] }>("/api/reminders"),
  state: (chatId: string | null) => getJson<{ scope: string; items: StateItem[] }>(`/api/state${chatId ? `?chat=${encodeURIComponent(chatId)}` : ""}`),
  config: () => getJson<PublicConfig>("/api/config"),
};

export function fileUrl(relativePath: string): string {
  const token = getToken();
  const url = `/api/files?path=${encodeURIComponent(relativePath)}`;
  return token ? `${url}&access_token=${encodeURIComponent(token)}` : url;
}

export async function streamMessage(
  chatId: string,
  text: string,
  messageId: string,
  onEvent: (event: ServerEvent) => void,
): Promise<void> {
  const response = await fetch(`/api/sessions/${encodeURIComponent(chatId)}/messages`, {
    method: "POST",
    headers: authHeaders(true),
    body: JSON.stringify({ text, messageId }),
  });
  if (!response.ok || !response.body) throw new ApiError(await readError(response), response.status);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let split = buffer.indexOf("\n\n");
    while (split >= 0) {
      const raw = buffer.slice(0, split);
      buffer = buffer.slice(split + 2);
      const data = raw
        .split("\n")
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trim())
        .join("\n");
      if (data) onEvent(JSON.parse(data) as ServerEvent);
      split = buffer.indexOf("\n\n");
    }
  }
}

export function fromServerMessage(message: ServerMessage): ChatMessage {
  return {
    key: `e${message.id}`,
    role: message.role,
    text: message.text,
    tools: message.tools.map((tool) => ({
      callId: tool.callId,
      name: tool.name,
      phase: "end",
      isError: tool.isError,
      preview: tool.preview,
    })),
    steps: message.steps,
    notices: [],
    attachments: message.attachments,
  };
}

export function applyEvent(messages: ChatMessage[], event: ServerEvent): ChatMessage[] {
  const next = messages.slice();
  const ensure = (): ChatMessage => {
    const last = next[next.length - 1];
    if (last?.role === "assistant" && last.pending) return last;
    const created: ChatMessage = {
      key: `live-${Date.now()}`,
      role: "assistant",
      text: "",
      thinking: "",
      tools: [],
      steps: [],
      notices: [],
      attachments: [],
      pending: true,
    };
    next.push(created);
    return created;
  };

  if (event.type === "text" || event.type === "thinking" || event.type === "tool" || event.type === "status" || event.type === "notice" || event.type === "attachment") {
    const current = { ...ensure() };
    if (event.type === "text") current.text += event.delta;
    if (event.type === "thinking") current.thinking = `${current.thinking ?? ""}${event.delta}`;
    if (event.type === "status" && !event.message.startsWith("pi pid=")) current.steps = [...current.steps, event.message];
    if (event.type === "notice") current.notices = [...current.notices, event.text];
    if (event.type === "attachment") current.attachments = [...current.attachments, { name: event.name, path: event.path, bytes: event.bytes }];
    if (event.type === "tool") {
      const callId = event.callId || `${event.name}-${current.tools.length}`;
      const tools = current.tools.slice();
      const index = tools.findIndex((tool) => tool.callId === callId);
      const tool = {
        callId,
        name: event.name,
        phase: event.phase,
        isError: event.isError,
        preview: event.preview ?? (index >= 0 ? tools[index].preview : undefined),
        argsPreview: event.argsPreview ?? (index >= 0 ? tools[index].argsPreview : undefined),
      };
      if (index >= 0) tools[index] = { ...tools[index], ...tool };
      else tools.push(tool);
      current.tools = tools;
    }
    next[next.length - 1] = current;
    return next;
  }

  if (event.type === "done") {
    const current = { ...ensure(), pending: false, stopped: event.stopped };
    if (event.text) current.text = event.text;
    next[next.length - 1] = current;
    return next;
  }

  const current = { ...ensure(), pending: false, error: event.message };
  next[next.length - 1] = current;
  return next;
}
