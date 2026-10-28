export type OneBotMessage = {
  kind: "private" | "group";
  /** Stable chat key for the runtime's thread scoping. */
  chatId: string;
  userId: string;
  groupId?: string;
  messageId: string;
  nickname?: string;
  text: string;
  /** Group messages count only when the bot was @-mentioned; private ones always do. */
  addressed: boolean;
  /** QQ ids of everyone @-mentioned, for diagnosing "it ignored my mention". */
  mentions: string[];
};

type Segment = { type?: string; data?: Record<string, unknown> };

/** OneBot may send `message` as segments or as a CQ-code string; both are normalised here. */
function toSegments(message: unknown): Segment[] {
  if (Array.isArray(message)) return message as Segment[];
  if (typeof message === "string") {
    const segments: Segment[] = [];
    const pattern = /\[CQ:(\w+)((?:,[^\]]*)?)\]/g;
    let lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(message)) !== null) {
      if (match.index > lastIndex) segments.push({ type: "text", data: { text: message.slice(lastIndex, match.index) } });
      const params: Record<string, string> = {};
      for (const pair of match[2].split(",").filter(Boolean)) {
        const [key, value] = pair.split("=");
        if (key) params[key] = decodeURIComponent(value ?? "");
      }
      segments.push({ type: match[1], data: params });
      lastIndex = pattern.lastIndex;
    }
    if (lastIndex < message.length) segments.push({ type: "text", data: { text: message.slice(lastIndex) } });
    return segments;
  }
  return [];
}

/**
 * Parse a OneBot v11 event into the runtime's incoming shape.
 *
 * Returns null for anything that is not a message worth answering: heartbeats, notices,
 * the bot's own messages and empty text (images, faces, cards).
 */
export function parseOneBotEvent(payload: any, options: { botUin?: string } = {}): OneBotMessage | null {
  if (!payload || payload.post_type !== "message") return null;

  const selfId = String(payload.self_id ?? "");
  const userId = String(payload.user_id ?? "");
  if (options.botUin && userId === options.botUin) return null;
  if (selfId && userId === selfId) return null;

  const segments = toSegments(payload.message);
  const text = segments
    .filter((segment) => segment.type === "text")
    .map((segment) => String(segment.data?.text ?? ""))
    .join("")
    .replace(/\s+/g, " ")
    .trim();
  if (!text) return null;

  const mentioned = segments.some(
    (segment) => segment.type === "at" && (options.botUin ? String(segment.data?.qq) === options.botUin : true),
  );
  // Kept for diagnostics: "did the user really @ us, or type the name as plain text?" is the
  // first question whenever a group mention gets ignored.
  const mentions = segments
    .filter((segment) => segment.type === "at")
    .map((segment) => String(segment.data?.qq ?? ""))
    .filter(Boolean);
  const isGroup = payload.message_type === "group";
  if (!isGroup && payload.message_type !== "private") return null;

  const groupId = isGroup ? String(payload.group_id ?? "") : undefined;
  if (isGroup && !groupId) return null;

  return {
    kind: isGroup ? "group" : "private",
    chatId: isGroup ? `group:${groupId}` : `user:${userId}`,
    userId,
    groupId,
    messageId: String(payload.message_id ?? ""),
    nickname: payload.sender?.card || payload.sender?.nickname || undefined,
    text,
    addressed: isGroup ? mentioned : true,
    mentions,
  };
}

/**
 * Map a parsed QQ message onto the runtime's channel-agnostic shape.
 *
 * Structural typing keeps this file independent of the gateway module; the shape is checked at
 * the call site, where it is handed to `ingest`.
 */
export function oneBotToIncoming(message: OneBotMessage) {
  return {
    channel: "qq",
    chatId: message.chatId,
    chatType: message.kind === "group" ? ("group" as const) : ("dm" as const),
    externalId: message.userId,
    displayName: message.nickname ?? message.userId,
    text: message.text,
    messageId: message.messageId,
    addressed: message.addressed,
    mentions: message.mentions,
  };
}

/** `qq:group:555` / `qq:user:999` back into a send target. */
export function sendTargetFromChatId(chatId: string): SendTarget {
  const [scope, id] = chatId.replace(/^qq:/, "").split(":");
  return { kind: scope === "group" ? "group" : "private", id };
}

/**
 * QQ messages are plain text: `**bold**` and `# heading` show up as literal characters.
 * Strip the markers but keep the content, so the reply reads the same on both sides.
 */
export function toPlainText(text: string): string {
  return text
    .replace(/```[a-zA-Z]*\n?([\s\S]*?)```/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/^\s*[-*]\s+/gm, "· ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export type SendTarget = { kind: "private" | "group"; id: string };

/** The HTTP body OneBot expects for a text reply. */
export function buildSendBody(target: SendTarget, text: string): { endpoint: string; body: Record<string, unknown> } {
  return target.kind === "group"
    ? { endpoint: "send_group_msg", body: { group_id: Number(target.id), message: text } }
    : { endpoint: "send_private_msg", body: { user_id: Number(target.id), message: text } };
}

export type OneBotOptions = {
  wsUrl: string;
  httpUrl: string;
  /** Fallback token, used when the side-specific token is absent. */
  accessToken?: string;
  /** Some implementations (SnowLuma) issue a different token per adapter. */
  wsToken?: string;
  httpToken?: string;
  botUin?: string;
  allowedUsers?: string[];
  allowedGroups?: string[];
};

/**
 * Minimal OneBot v11 client: one WebSocket in, HTTP out.
 *
 * Deliberately dependency-free — Node's global `fetch` and `WebSocket` cover both halves, and a
 * third-party protocol bridge is already the risky part of this path; adding libraries would only
 * add failure modes.
 */
export class OneBotClient {
  private readonly options: OneBotOptions;

  constructor(options: OneBotOptions) {
    this.options = options;
  }

  private headers(): Record<string, string> {
    const headers: Record<string, string> = { "content-type": "application/json" };
    const token = this.options.httpToken ?? this.options.accessToken;
    if (token) headers.authorization = `Bearer ${token}`;
    return headers;
  }

  private async post(endpoint: string, body: Record<string, unknown>): Promise<void> {
    const response = await fetch(`${this.options.httpUrl.replace(/\/$/, "")}/${endpoint}`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify(body),
    });
    if (!response.ok) throw new Error(`onebot ${endpoint} ${response.status}`);
    const payload: any = await response.json().catch(() => null);
    if (payload && payload.status === "failed") throw new Error(`onebot ${endpoint}: ${payload.wording ?? payload.retcode}`);
  }

  async send(target: SendTarget, text: string): Promise<void> {
    const { endpoint, body } = buildSendBody(target, toPlainText(text));
    await this.post(endpoint, body);
  }

  /**
   * Send an image as a base64 segment.
   *
   * Base64 rather than a file path on purpose: the protocol implementation runs in a different
   * container, so a path from our workspace does not exist on its side. Base64 travels with the
   * message and needs no shared mount.
   */
  async sendImage(target: SendTarget, base64: string, caption?: string): Promise<void> {
    const message: Array<Record<string, unknown>> = [{ type: "image", data: { file: `base64://${base64}` } }];
    if (caption?.trim()) message.push({ type: "text", data: { text: toPlainText(caption) } });
    const endpoint = target.kind === "group" ? "send_group_msg" : "send_private_msg";
    const body = target.kind === "group"
      ? { group_id: Number(target.id), message }
      : { user_id: Number(target.id), message };
    await this.post(endpoint, body);
  }

  /** Upload a non-image file. Support varies by implementation; callers should handle failure. */
  async sendFile(target: SendTarget, base64: string, name: string): Promise<void> {
    const endpoint = target.kind === "group" ? "upload_group_file" : "upload_private_file";
    const body = target.kind === "group"
      ? { group_id: Number(target.id), file: `base64://${base64}`, name }
      : { user_id: Number(target.id), file: `base64://${base64}`, name };
    await this.post(endpoint, body);
  }

  /** Connect, dispatch messages, reconnect with backoff. Resolves only on an AbortSignal. */
  async run(onMessage: (message: OneBotMessage) => Promise<void>, signal?: AbortSignal): Promise<void> {
    let delay = 1_000;
    while (!signal?.aborted) {
      try {
        await this.session(onMessage, signal);
        delay = 1_000;
      } catch (error) {
        console.error(`onebot: ${error instanceof Error ? error.message : String(error)}`);
      }
      if (signal?.aborted) break;
      await new Promise((resolve) => setTimeout(resolve, delay));
      delay = Math.min(delay * 2, 30_000);
    }
  }

  private session(onMessage: (message: OneBotMessage) => Promise<void>, signal?: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      const token = this.options.wsToken ?? this.options.accessToken;
      const url = token
        ? `${this.options.wsUrl}${this.options.wsUrl.includes("?") ? "&" : "?"}access_token=${encodeURIComponent(token)}`
        : this.options.wsUrl;
      const socket = new WebSocket(url);

      socket.addEventListener("open", () => console.error("onebot: connected"));
      socket.addEventListener("error", () => reject(new Error("websocket error")));
      socket.addEventListener("close", () => resolve());
      socket.addEventListener("message", (event) => {
        let payload: any;
        try {
          payload = JSON.parse(String((event as MessageEvent).data));
        } catch {
          return;
        }
        const message = parseOneBotEvent(payload, { botUin: this.options.botUin });
        if (!message) return;
        if (message.kind === "group" && this.options.allowedGroups?.length && !this.options.allowedGroups.includes(message.groupId!)) return;
        if (message.kind === "private" && this.options.allowedUsers?.length && !this.options.allowedUsers.includes(message.userId)) return;
        void onMessage(message).catch((error) => console.error(`onebot handler: ${error instanceof Error ? error.message : String(error)}`));
      });

      signal?.addEventListener("abort", () => {
        try {
          socket.close();
        } catch {
          /* already closed */
        }
        resolve();
      });
    });
  }
}
/**
 * Decide whether an incoming message deserves an answer.
 *
 * Three ways a group message counts as addressed: a real `at` segment, an explicit
 * per-group exemption, or the bot's name appearing in the text. The third is what people
 * actually expect — "@-ing is a UI, saying the name is a habit" — but it has to stay
 * opt-in, because a bot that answers every mention of its name becomes noise.
 */
export function shouldAnswer(
  message: { chatType: string; addressed?: boolean; chatId: string; text: string },
  options: { noMentionGroups?: Set<string>; wakeWords?: string[] } = {},
): boolean {
  if (message.chatType !== "group") return true;
  if (message.addressed) return true;
  if (options.noMentionGroups?.has(message.chatId)) return true;
  const words = options.wakeWords ?? [];
  return words.some((word) => word.length > 0 && message.text.includes(word));
}