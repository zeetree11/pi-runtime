export type ChildSpec = { index: number; title: string; prompt: string };

export type ChildResult = {
  index: number;
  title: string;
  status: "ok" | "failed";
  output: string;
  taskId?: string;
  error?: string;
  ms?: number;
};

/** Depth guard: a child may not spawn grandchildren unless the config allows it. */
export function canSpawn(depth: number, maxDepth: number): boolean {
  return depth < maxDepth;
}

/**
 * Ask the parent model to split its own task.
 *
 * Splitting with the model, rather than by punctuation, is what makes this an orchestrator and
 * not a batch runner: the boundaries follow the work, not the formatting.
 */
export function buildSplitPrompt(userPrompt: string, count: number): string {
  return [
    `把下面这个任务拆成 ${count} 个可以并行执行的子任务。`,
    "要求：",
    "1. 子任务之间不要有前置依赖，能同时开始。",
    "2. 每个子任务自己就能给出有用的结论，不需要等别人。",
    "3. 输出严格 JSON：",
    `{"tasks":[{"title":"短标题","prompt":"完整、自足的子任务描述"}]}`,
    "",
    "任务：",
    userPrompt,
  ].join("\n");
}

/** Recover the task list from a model reply that may be wrapped in prose or fences. */
export function parseSubtasks(text: string, count: number): ChildSpec[] {
  const cleaned = text.replace(/```(?:json)?/gi, "").trim();
  // Accept both `{"tasks":[...]}` and a bare `[...]`: the prompt asks for the object form, but
  // models return the array often enough that rejecting it turns a usable split into a failure.
  const firstObject = cleaned.indexOf("{");
  const firstArray = cleaned.indexOf("[");
  const asArray = firstArray !== -1 && (firstObject === -1 || firstArray < firstObject);
  const start = asArray ? firstArray : firstObject;
  const end = asArray ? cleaned.lastIndexOf("]") : cleaned.lastIndexOf("}");
  if (start === -1 || end <= start) return [];

  let parsed: any;
  try {
    parsed = JSON.parse(cleaned.slice(start, end + 1));
  } catch {
    return [];
  }

  const list = Array.isArray(parsed?.tasks) ? parsed.tasks : Array.isArray(parsed) ? parsed : [];
  const specs: ChildSpec[] = [];
  for (const item of list.slice(0, count)) {
    const prompt = String(item?.prompt ?? "").trim();
    if (!prompt) continue;
    specs.push({
      index: specs.length + 1,
      title: String(item?.title ?? `子任务 ${specs.length + 1}`).trim().slice(0, 40),
      prompt,
    });
  }
  return specs;
}

/**
 * Build the digest handed back to the parent.
 *
 * Each child's output is capped: an aggregator that receives three full essays spends more
 * tokens than doing the work itself. Failures are included, with their reason — a partial
 * report is more useful than silence, and the parent must know what is missing.
 */
export function buildDigest(results: ChildResult[], maxCharsPerChild = 1200): string {
  const lines: string[] = ["## 子任务结果（由子 Agent 并行完成）", ""];
  for (const result of results) {
    lines.push(`### ${result.index}. ${result.title} — ${result.status === "ok" ? "完成" : "失败"}`);
    if (result.status === "ok") {
      const body = result.output.trim();
      lines.push(body.length > maxCharsPerChild ? `${body.slice(0, maxCharsPerChild)}…（已截断，原文 ${body.length} 字符）` : body);
    } else {
      lines.push(`该子任务失败：${result.error ?? "未知错误"}。请在其他子任务结果的基础上作答，并明确说明这部分缺失。`);
    }
    lines.push("");
  }
  lines.push("请综合以上结果给出最终答复，不要逐条复述。");
  return lines.join("\n");
}

/** Run `runs` with at most `limit` in flight, preserving result order. */
export async function runWithLimit<T, R>(
  items: T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  const size = Math.max(1, Math.min(limit, items.length));

  const runners = Array.from({ length: size }, async () => {
    while (true) {
      const index = cursor++;
      if (index >= items.length) return;
      results[index] = await worker(items[index], index);
    }
  });

  await Promise.all(runners);
  return results;
}
