import * as Lark from "@larksuiteoapi/node-sdk";
import { createDecipheriv, createHash, timingSafeEqual } from "node:crypto";
import type { Incoming } from "../gateway.ts";

export type FeishuOptions = {
  appId: string;
  appSecret: string;
  /** Set when event encryption is enabled in the console. */
  encryptKey?: string;
  verificationToken?: string;
  /** Accept only these chat ids. Empty = accept all. */
  allowedChats?: string[];
};

/**
 * Feishu (Lark) adapter over the long-connection transport.
 *
 * Long connection instead of a webhook: the agent runs on a laptop without a public
 * address, and Feishu's WS mode is the only setup that needs nothing but outbound TLS.
 * The trade-off is that the console must select "使用长连接接收事件" — a webhook deployment
 * would need this file's `serve` to become an HTTP handler instead.
 */
export class FeishuChannel {
  private readonly options: FeishuOptions;
  private readonly client: Lark.Client;
  private ws?: Lark.WSClient;
  private readonly names = new Map<string, string>();
  private botOpenId: string | undefined;

  constructor(options: FeishuOptions) {
    this.options = options;
    this.client = new Lark.Client({ appId: options.appId, appSecret: options.appSecret });
  }

  async send(chatId: string, text: string): Promise<void> {
    await this.client.im.v1.message.create({
      params: { receive_id_type: "chat_id" },
      data: {
        receive_id: chatId,
        msg_type: "text",
        content: JSON.stringify({ text: text.slice(0, 4_000) }),
      },
    });
  }

  /**
   * Send an image. Feishu requires an upload first: the message references an `image_key`, it does
   * not carry bytes. Uploading on every send is wasteful but keeps no cache invalidation logic —
   * correct beats clever for a handful of images a day.
   */
  async sendImage(chatId: string, buffer: Buffer, caption?: string): Promise<void> {
    const uploaded: any = await this.client.im.v1.image.create({
      data: { image_type: "message", image: buffer as any },
    });
    const imageKey = uploaded?.image_key ?? uploaded?.data?.image_key;
    if (!imageKey) throw new Error("飞书图片上传没有返回 image_key");
    await this.client.im.v1.message.create({
      params: { receive_id_type: "chat_id" },
      data: { receive_id: chatId, msg_type: "image", content: JSON.stringify({ image_key: imageKey }) },
    });
    if (caption?.trim()) await this.send(chatId, caption);
  }

  /** Send a non-image file as a Feishu file message. */
  async sendFile(chatId: string, buffer: Buffer, fileName: string, caption?: string): Promise<void> {
    const uploaded: any = await this.client.im.v1.file.create({
      data: { file_type: "stream", file_name: fileName, file: buffer as any },
    });
    const fileKey = uploaded?.file_key ?? uploaded?.data?.file_key;
    if (!fileKey) throw new Error("飞书文件上传没有返回 file_key");
    await this.client.im.v1.message.create({
      params: { receive_id_type: "chat_id" },
      data: { receive_id: chatId, msg_type: "file", content: JSON.stringify({ file_key: fileKey }) },
    });
    if (caption?.trim()) await this.send(chatId, caption);
  }

  /**
   * Feishu events carry an open_id, not a display name. Resolving the name needs the
   * contact scope; when the app lacks it we fall back to the id rather than failing the
   * message — a mislabelled speaker is recoverable, a dropped message is not.
   */
  private async displayName(openId: string): Promise<string> {
    const cached = this.names.get(openId);
    if (cached) return cached;
    let name = openId;
    try {
      const response: any = await this.client.contact.v3.user.get({
        params: { user_id_type: "open_id" },
        path: { user_id: openId },
      });
      const resolved = response?.data?.user?.name;
      if (typeof resolved === "string" && resolved.trim()) name = resolved.trim();
    } catch {
      /* no contact scope — keep the id */
    }
    this.names.set(openId, name);
    return name;
  }

  /** The bot's own open_id, needed to tell "mentioned me" from "mentioned someone else". */
  async resolveBotOpenId(): Promise<string | undefined> {
    if (this.botOpenId !== undefined) return this.botOpenId;
    // Explicit config wins: it removes a startup dependency on the bot-info API, so group
    // mention detection keeps working even if that call is rate limited or scoped out.
    const configured = (process.env.FEISHU_BOT_OPEN_ID ?? "").trim();
    if (configured) {
      this.botOpenId = configured;
      return this.botOpenId;
    }
    try {
      const response: any = await this.client.request({ method: "POST", url: "/open-apis/bot/v3/info" });
      this.botOpenId = response?.bot?.open_id ?? response?.data?.bot?.open_id;
    } catch {
      this.botOpenId = undefined;
    }
    return this.botOpenId;
  }

  async serve(onMessage: (message: Incoming) => Promise<void>): Promise<void> {
    const botOpenId = await this.resolveBotOpenId();
    const dispatcher = new Lark.EventDispatcher({
      encryptKey: this.options.encryptKey,
      verificationToken: this.options.verificationToken,
    }).register({
      "im.message.receive_v1": async (payload: any) => {
        const base = parseFeishuMessage(payload, { botOpenId });
        if (!base) return;
        if (this.options.allowedChats?.length && !this.options.allowedChats.includes(base.chatId)) {
          console.error(`ignoring feishu chat ${base.chatId} (not in allow list)`);
          return;
        }
        const displayName = await this.displayName(base.externalId);
        await onMessage({ ...base, displayName });
      },
    });

    this.ws = new Lark.WSClient({
      appId: this.options.appId,
      appSecret: this.options.appSecret,
      loggerLevel: Lark.LoggerLevel.warn,
    });

    await this.ws.start({ eventDispatcher: dispatcher });
    console.log("feishu long connection established");
  }

  close(): void {
    this.ws?.close({ force: true });
  }

  /** Public wrapper so the webhook transport can reuse the same name cache. */
  nameFor(openId: string): Promise<string> {
    return this.displayName(openId);
  }
}

/**
 * Normalization is exported so it can be tested without credentials: the payload shape is
 * the part that breaks when Feishu changes schema or when a message is not plain text.
 */
export function parseFeishuMessage(payload: any, options: { botOpenId?: string } = {}): Incoming | null {  const event = payload?.event ?? payload;
  const message = event?.message;
  const sender = event?.sender;
  if (!message?.chat_id || typeof message.content !== "string") return null;
  if (message.message_type !== "text") return null;

  let text = "";
  try {
    text = String(JSON.parse(message.content)?.text ?? "");
  } catch {
    return null;
  }
  // Feishu inlines mentions as @_user_1 placeholders; they are noise for memory extraction.
  text = text.replace(/@_user_\d+/g, "").trim();
  if (!text) return null;

  const ids = sender?.sender_id ?? {};
  const externalId = String(ids.open_id ?? ids.user_id ?? ids.union_id ?? "unknown");
  if (externalId === "unknown") return null;

  const chatType = message.chat_type === "p2p" ? "dm" : "group";
  // Feishu puts mentioned users in `mentions`; the bot is addressed when its own open_id is
  // among them. Without the bot id we cannot tell, so a group message stays unanswered.
  const mentioned = Array.isArray(message.mentions)
    ? message.mentions.map((item: any) => String(item?.id?.open_id ?? "")).filter(Boolean)
    : [];
  const addressed = chatType === "dm" || (Boolean(options.botOpenId) && mentioned.includes(options.botOpenId!));

  return {
    channel: "feishu",
    chatId: String(message.chat_id),
    chatType,
    addressed,
    externalId,
    displayName: externalId,
    text,
    messageId: message.message_id ? String(message.message_id) : undefined,
    timestamp: message.create_time ? new Date(Number(message.create_time)).toISOString() : undefined,
  };
}

/** Feishu's URL-verification handshake: echo the challenge back, nothing else. */
export function isUrlVerification(payload: any): boolean {
  return payload?.type === "url_verification" && typeof payload?.challenge === "string";
}

/**
 * Feishu signs webhook deliveries with sha256(timestamp + nonce + encryptKey + body).
 * Without an encryptKey there is no signature to check, which is why the console should
 * set one for anything reachable from the internet.
 */
export function verifyFeishuSignature(
  headers: Record<string, string | undefined>,
  rawBody: string,
  encryptKey: string,
): boolean {
  const timestamp = headers["x-lark-request-timestamp"];
  const nonce = headers["x-lark-request-nonce"];
  const signature = headers["x-lark-signature"];
  if (!timestamp || !nonce || !signature) return false;

  const expected = createHash("sha256").update(timestamp + nonce + encryptKey + rawBody).digest("hex");
  const left = Buffer.from(expected, "utf8");
  const right = Buffer.from(signature, "utf8");
  return left.length === right.length && timingSafeEqual(left, right);
}

/**
 * Feishu encrypts the whole payload when an encrypt key is configured:
 * AES-256-CBC, key = sha256(encryptKey), IV = first 16 bytes of the ciphertext.
 */
export function decryptFeishuPayload(encrypted: string, encryptKey: string): any {
  const key = createHash("sha256").update(encryptKey).digest();
  const buffer = Buffer.from(encrypted, "base64");
  if (buffer.length <= 16) throw new Error("encrypted payload too short");
  const iv = buffer.subarray(0, 16);
  const decipher = createDecipheriv("aes-256-cbc", key, iv);
  const plain = Buffer.concat([decipher.update(buffer.subarray(16)), decipher.final()]).toString("utf8");
  return JSON.parse(plain);
}

/** Accepts either a plain record or an `{encrypt}` envelope. */
export function unwrapFeishuPayload(body: string, encryptKey?: string): any {
  const parsed = JSON.parse(body);
  if (parsed && typeof parsed.encrypt === "string") {
    if (!encryptKey) throw new Error("payload is encrypted but no encryptKey is configured");
    return decryptFeishuPayload(parsed.encrypt, encryptKey);
  }
  return parsed;
}
