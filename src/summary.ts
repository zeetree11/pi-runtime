import { PI_CLI, piArgs, piEnv } from "./config.ts";
import type { RuntimeConfig } from "./config.ts";
import type { ConversationEventRow } from "./db.ts";
import { PiRpc } from "./rpc.ts";

const SUMMARY_PROMPT = `你是对话压缩器。输入是「上一版摘要」和「一批较早的对话」，请输出合并后的新摘要。

必须保留：
- 已确认的事实：数字、名称、型号、日期、结论
- 用户明确下达的指令与偏好
- 未解决的问题
- 当前任务进展
- 关键实体：人名、项目、地点、文件

可以丢弃：
- 寒暄客套、重复解释、助手的推理过程（只留结论）
- 已被后续对话推翻的旧结论（直接去掉，或标注「已更正」）

要求：
- 中文，≤ 600 字，纯文本，不要 JSON、不要代码块
- 用下面的结构，没有内容的段落可以省略：

## 已确认事实
- ...

## 用户指令与偏好
- ...

## 未决问题
- ...

## 关键实体
- ...

只输出摘要正文，不要任何解释。`;

/**
 * Compress the cold part of a thread into a rolling summary.
 *
 * The summary is a derived view: every source event stays in `conversation_events`, so a bad
 * compression can be recomputed instead of being permanent data loss. The caller advances the
 * cursor only after this resolves, which makes a failed run retryable.
 */
export async function summarizeThread(
  cfg: RuntimeConfig,
  previousSummary: string,
  events: ConversationEventRow[],
  maxChars: number,
  signal?: AbortSignal,
): Promise<string> {
  if (signal?.aborted) throw new Error("aborted");
  const transcript = events
    .map((event) => `[${event.role === "assistant" ? "助手" : event.speaker}] ${event.text}`)
    .join("\n");

  const prompt = [
    SUMMARY_PROMPT,
    "",
    "# 上一版摘要",
    previousSummary.trim() || "（无）",
    "",
    "# 需要合并的较早对话",
    transcript,
  ].join("\n");

  const rpc = new PiRpc({
    cliPath: PI_CLI,
    cwd: cfg.workspace,
    args: piArgs(cfg),
    env: piEnv(cfg),
    commandTimeoutMs: 120_000,
  });

  let output = "";
  rpc.on("record", (record) => {
    if (record.type === "message_update") {
      const event = record.assistantMessageEvent;
      if (event?.type === "text_delta" && typeof event.delta === "string") output += event.delta;
    }
  });

  const onAbort = () => {
    void rpc.dispose();
  };
  signal?.addEventListener("abort", onAbort);
  try {
    rpc.start();
    if (signal?.aborted) throw new Error("aborted");
    await rpc.prompt(prompt, 180_000, signal);
  } finally {
    signal?.removeEventListener("abort", onAbort);
    await rpc.dispose();
  }

  return output.trim().slice(0, maxChars);
}
