import { similarity } from "./memory.ts";

export type ComposeSegment = {
  /** Stable identifier, used in the manifest and the policy table. */
  kind: "instructions" | "memory" | "short_state" | "summary" | "window" | "retrieved" | "current" | string;
  /** Section header, rendered above the body. */
  title?: string;
  body: string;
  /** Anything worth recording: selected ids, counts, reasons. Never rendered. */
  meta?: Record<string, unknown>;
  /**
   * How often this segment changes, which decides where it goes in the prompt.
   *
   * Providers cache the longest common prefix, so anything volatile near the front throws
   * away the cache for the whole tail. Frozen first, volatile last is therefore worth real
   * money on long conversations, not just tidiness.
   */
  stability?: "frozen" | "stable" | "volatile";
};

export type DropOrder =
  /** Drop from the beginning, keep the newest lines (conversation window). */
  | "oldest"
  /** Drop from the end, keep the highest-priority lines (ranked memory). */
  | "lowest"
  /** Drop from the end, keep the leading sections (structured summary). */
  | "tail"
  | "none";

export type SegmentPolicy = {
  /** Guaranteed characters, granted before any proportional distribution. */
  floor: number;
  /** Hard cap, applied even when there is budget to spare. */
  cap: number;
  drop: DropOrder;
  /** Never truncated (instructions, the current message). */
  protected?: boolean;
};

export type ComposeOptions = {
  budgetChars?: number;
  charsPerToken?: number;
  policies?: Record<string, SegmentPolicy>;
  /** Similarity above which a lower-priority line is considered a duplicate. */
  dedupeThreshold?: number;
};

export type SegmentReport = {
  kind: string;
  chars: number;
  floor: number;
  cap: number;
  truncated: boolean;
  droppedChars: number;
  meta?: Record<string, unknown>;
};

export type ComposeManifest = {
  budgetChars: number;
  usedChars: number;
  estimatedTokens: number;
  charsPerToken: number;
  overBudget: boolean;
  /** Characters in the leading run that does not change between turns (cache-friendly). */
  cacheableChars: number;
  segments: SegmentReport[];
  skipped: string[];
  dedup: Array<{ kind: string; dropped: string; keptIn: string; similarity: number }>;
  /** Memory lines that look like they disagree with the recent conversation. */
  conflicts: Array<{ memory: string; window: string; similarity: number }>;
  evictions: Array<{ kind: string; droppedChars: number }>;
};

const MAX = Number.MAX_SAFE_INTEGER;

export const DEFAULT_POLICIES: Record<string, SegmentPolicy> = {
  instructions: { floor: 0, cap: MAX, drop: "none", protected: true },
  memory: { floor: 150, cap: 900, drop: "lowest" },
  short_state: { floor: 0, cap: 300, drop: "lowest" },
  summary: { floor: 0, cap: 1000, drop: "tail" },
  window: { floor: 1200, cap: 2800, drop: "oldest" },
  retrieved: { floor: 0, cap: 800, drop: "lowest" },
  conflicts: { floor: 0, cap: 300, drop: "tail" },
  // Preference precedence is short but must survive trimming: it overrides the memory block.
  precedence: { floor: 0, cap: 400, drop: "lowest" },
  current: { floor: 0, cap: MAX, drop: "none", protected: true },
};

const FALLBACK_POLICY: SegmentPolicy = { floor: 0, cap: MAX, drop: "none" };

/** Cheapest to lose first. `current` and `instructions` are never in this list. */
export const EVICTION_ORDER = ["retrieved", "short_state", "memory", "conflicts", "summary", "window"];

const DIVIDER = "\n\n---\n\n";

/**
 * Strip the presentation prefixes before comparing lines: a memory line is rendered as
 * `- [事实·4] …` and a window line as `[Rick] …`. Leaving them in makes dedupe depend on
 * formatting noise instead of content.
 */
const PREFIX = /^(?:[-*]\s*)?(?:\[[^\]]{1,24}\]\s*)+/;

export function stripPrefix(line: string): string {
  return line.replace(PREFIX, "").trim();
}

/** Which segments are allowed to shadow which: a later segment wins. */
const DEDUPE_PRIORITY = ["window", "short_state", "memory", "summary"];

/**
 * Bands for conflict detection.
 *
 * Below `min` the lines are unrelated; at or above `exact` they are duplicates and dedupe
 * already handled them. In between: same topic, different content — worth flagging, because
 * the user probably just changed their mind.
 */
export const CONFLICT_MIN = 0.5;
export const CONFLICT_EXACT = 0.95;

export type Conflict = { memory: string; window: string; similarity: number };

/** Digits, thousands separators removed, as comparable strings. */
function numbersIn(text: string): Set<string> {
  return new Set((text.match(/\d[\d.,]*/g) ?? []).map((value) => value.replace(/[.,]/g, "")));
}

/** Character bigrams of the non-numeric part: the "topic" of a line. */
function topicBigrams(text: string): Set<string> {
  const clean = text.toLowerCase().replace(/[^\p{L}]/gu, "");
  const grams = new Set<string>();
  for (let i = 0; i < clean.length - 1; i++) grams.add(clean.slice(i, i + 2));
  return grams;
}

/**
 * Share of the smaller line's bigrams present in the larger one.
 *
 * Jaccard punishes length: "用户对花生过敏，必须完全避开" vs a rephrasing of it scores 0.21,
 * below any usable threshold, while containment scores 0.42. Containment asks the question we
 * actually have — "is this the same sentence, edited?" — instead of "are these the same size?".
 */
function containment(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let shared = 0;
  for (const gram of a) if (b.has(gram)) shared++;
  return shared / Math.min(a.size, b.size);
}

/**
 * Find memory lines that disagree with a recent line.
 *
 * Two signals, because either alone is too weak:
 * - **same topic, disjoint numbers**: "部署端口是 3000" vs "部署端口改成 8080" — the case that
 *   matters most, and the one lexical similarity is worst at (0.23).
 * - **wording drift without numbers**: containment ≥ 0.35, e.g. "必须完全避开" → "偶尔吃一点没事".
 *   Requiring that neither side carries a number keeps "端口 8080 已确认" from looking like a
 *   contradiction of "端口是 8080".
 *
 * Read paths must not rewrite memory: a heuristic that is wrong once would corrupt a fact
 * permanently. Conflicts are surfaced as a hint ("the recent turn wins"); the rewrite is left
 * to distillation, where the four verdicts and the evidence check live.
 */
export function findConflicts(memoryBody: string, windowBody: string, limit = 3): Conflict[] {
  const windowLines = windowBody
    .split("\n")
    .map((line) => stripPrefix(line))
    .filter((line) => line.length >= 8);
  const found: Conflict[] = [];

  for (const raw of memoryBody.split("\n")) {
    if (raw.startsWith("#")) continue;
    const line = stripPrefix(raw);
    if (line.length < 8) continue;

    const lineNumbers = numbersIn(line);
    const lineTopic = topicBigrams(line);

    for (const candidate of windowLines) {
      const score = similarity(line, candidate);
      if (score >= CONFLICT_EXACT) continue; // a duplicate; dedupe owns that case

      const candidateNumbers = numbersIn(candidate);
      const shareNumber = [...lineNumbers].some((value) => candidateNumbers.has(value));
      const sharedTopic = [...lineTopic].filter((gram) => topicBigrams(candidate).has(gram)).length;

      const byValue = lineNumbers.size > 0 && candidateNumbers.size > 0 && !shareNumber && sharedTopic >= 2;
      const byWording =
        lineNumbers.size === 0 && candidateNumbers.size === 0 && containment(lineTopic, topicBigrams(candidate)) >= 0.35;

      if (byValue || byWording) {
        found.push({ memory: raw.trim(), window: candidate, similarity: Number(score.toFixed(2)) });
      }
    }
  }

  // One hint per memory line is enough; keep the strongest match for each.
  const best = new Map<string, Conflict>();
  for (const conflict of found) {
    const existing = best.get(conflict.memory);
    if (!existing || conflict.similarity > existing.similarity) best.set(conflict.memory, conflict);
  }
  return [...best.values()].sort((a, b) => b.similarity - a.similarity).slice(0, limit);
}

function policyFor(kind: string, overrides?: Record<string, SegmentPolicy>): SegmentPolicy {
  return overrides?.[kind] ?? DEFAULT_POLICIES[kind] ?? FALLBACK_POLICY;
}

/**
 * Trim a body to `maxChars` by dropping whole lines in the policy's order.
 * Lines are kept in their original order; only the selection changes.
 */
export function trimLines(text: string, maxChars: number, order: DropOrder): { text: string; dropped: number } {
  if (maxChars === MAX || text.length <= maxChars) return { text, dropped: 0 };
  const lines = text.split("\n");
  const keep: string[] = [];
  let used = 0;

  const sequence = order === "oldest" ? [...lines].reverse() : lines;
  for (const line of sequence) {
    const cost = line.length + 1;
    if (used + cost > maxChars && keep.length > 0) break;
    keep.push(line);
    used += cost;
  }

  const selected = order === "oldest" ? [...keep].reverse() : keep;
  const result = selected.join("\n");
  return { text: result, dropped: text.length - result.length };
}

/**
 * Assemble the prompt: dedupe duplicates across segments, allocate the budget by policy,
 * trim what does not fit, then render.
 *
 * Pure and deterministic: same segments and budget always produce the same prompt, which is
 * what makes a prompt diffable between refactors.
 */
export function compose(
  segments: ComposeSegment[],
  options: ComposeOptions = {},
): { prompt: string; manifest: ComposeManifest } {
  const charsPerToken = options.charsPerToken ?? 3.5;
  const budgetChars = options.budgetChars ?? 0;
  const threshold = options.dedupeThreshold ?? 0.7;

  const prepared = segments.map((segment) => ({
    ...segment,
    body: (segment.body ?? "").trim(),
    policy: policyFor(segment.kind, options.policies),
  }));

  // ---- cross-segment dedupe -------------------------------------------------------------
  const dedup: ComposeManifest["dedup"] = [];
  const reference = new Map<string, string[]>(); // winning lines per priority level
  for (const kind of DEDUPE_PRIORITY) {
    const segment = prepared.find((item) => item.kind === kind && item.body);
    if (!segment) continue;
    const kept: string[] = [];
    for (const line of segment.body.split("\n")) {
      const bare = stripPrefix(line);
      if (bare.length < 8 || line.startsWith("#")) {
        kept.push(line);
        continue;
      }
      const shadow = DEDUPE_PRIORITY.slice(0, DEDUPE_PRIORITY.indexOf(kind))
        .flatMap((higher) => reference.get(higher) ?? [])
        .find((candidate) => similarity(stripPrefix(candidate), bare) >= threshold);
      if (shadow) {
        dedup.push({
          kind,
          dropped: bare.slice(0, 60),
          keptIn: "higher-priority segment",
          similarity: Number(similarity(stripPrefix(shadow), bare).toFixed(2)),
        });
        continue;
      }
      kept.push(line);
    }
    segment.body = kept.join("\n").trim();
    reference.set(kind, kept);
  }

  // ---- conflict hints -------------------------------------------------------------------
  // Computed after dedupe (an exact duplicate is not a conflict) and rendered as a hint, not
  // as a rewrite: dropping a memory on a fuzzy match would lose valid facts.
  const conflicts: Conflict[] = [];
  const memorySegment = prepared.find((item) => item.kind === "memory" && item.body);
  const windowSegment = prepared.find((item) => item.kind === "window" && item.body);
  if (memorySegment && windowSegment) {
    conflicts.push(...findConflicts(memorySegment.body, windowSegment.body));
  }
  if (conflicts.length > 0) {
    const body = conflicts
      .map((conflict) => `- 记忆「${conflict.memory.replace(/^[-*]\s*/, "").slice(0, 50)}」与最近对话不一致（相似度 ${conflict.similarity}），以最近对话为准`)
      .join("\n");
    const currentIndex = prepared.findIndex((item) => item.kind === "current");
    const hint = {
      kind: "conflicts",
      stability: "volatile",
      title: "## 上下文冲突提示",
      body,
      policy: policyFor("conflicts", options.policies),
    };
    prepared.splice(currentIndex === -1 ? prepared.length : currentIndex, 0, hint);
  }

  // ---- stability ordering ----------------------------------------------------------------
  // Providers bill cached and uncached prefixes differently, and the cache is a *prefix*:
  // putting a volatile segment early invalidates everything after it. Sorting is stable, so
  // segments that do not declare stability keep the order the caller gave them.
  const STABILITY_RANK: Record<string, number> = { frozen: 0, stable: 1, volatile: 2 };
  const rankOf = (segment: { kind?: string; stability?: string }): number => {
    // The current message changes every turn by definition, so it must never sit inside the
    // cacheable prefix. Treating it as volatile without asking keeps callers from breaking this.
    if (segment.kind === "current") return 2;
    return STABILITY_RANK[segment.stability ?? "stable"] ?? 1;
  };
  prepared.sort((a, b) => rankOf(a) - rankOf(b));

  const active = prepared.filter((segment) => segment.body.trim().length > 0);
  const skipped = prepared.filter((segment) => segment.body.trim().length === 0).map((segment) => segment.kind);

  // ---- budget allocation ----------------------------------------------------------------
  const renderedBase = (segment: (typeof active)[number]): string =>
    segment.title ? `${segment.title}\n${segment.body}` : segment.body;

  const dividerCost = DIVIDER.length * Math.max(0, active.length - 1);
  const protectedSegments = active.filter((segment) => segment.policy.protected);
  const flexible = active.filter((segment) => !segment.policy.protected);

  const protectedChars = protectedSegments.reduce((sum, segment) => sum + renderedBase(segment).length, 0);
  let available = budgetChars > 0 ? budgetChars - dividerCost - protectedChars : Number.MAX_SAFE_INTEGER;

  const target = new Map<string, number>();
  for (const segment of flexible) {
    const rendered = renderedBase(segment).length;
    target.set(segment.kind, Math.min(rendered, segment.policy.cap));
  }

  const demand = [...target.values()].reduce((sum, value) => sum + value, 0);
  const evictions: ComposeManifest["evictions"] = [];

  if (available < 0) available = 0;

  if (demand > available) {
    // 1) grant floors in eviction order (cheapest to lose first gets its floor last)
    let floorsTotal = 0;
    for (const kind of EVICTION_ORDER) {
      const segment = flexible.find((item) => item.kind === kind);
      if (!segment) continue;
      const floor = Math.min(segment.policy.floor, target.get(kind) ?? 0);
      floorsTotal += floor;
      target.set(kind, floor);
    }

    // 2) if floors already exceed the budget, shrink them in reverse eviction order
    while (floorsTotal > available) {
      let shrunk = false;
      for (const kind of [...EVICTION_ORDER].reverse()) {
        const current = target.get(kind) ?? 0;
        if (current > 0) {
          const cut = Math.min(current, floorsTotal - available);
          target.set(kind, current - cut);
          floorsTotal -= cut;
          shrunk = true;
          if (floorsTotal <= available) break;
        }
      }
      if (!shrunk) break;
    }

    // 3) distribute the remainder proportionally to each segment's unmet demand
    const remaining = Math.max(0, available - floorsTotal);
    const unmet = flexible.reduce((sum, segment) => sum + Math.max(0, Math.min(renderedBase(segment).length, segment.policy.cap) - (target.get(segment.kind) ?? 0)), 0);
    if (remaining > 0 && unmet > 0) {
      for (const segment of flexible) {
        const ceiling = Math.min(renderedBase(segment).length, segment.policy.cap);
        const current = target.get(segment.kind) ?? 0;
        const share = Math.floor((remaining * (ceiling - current)) / unmet);
        target.set(segment.kind, Math.min(ceiling, current + share));
      }
    }
  }

  // ---- trim + render ---------------------------------------------------------------------
  const rendered: string[] = [];
  const reports: SegmentReport[] = [];
  let usedChars = 0;

  for (const segment of active) {
    const full = renderedBase(segment);
    const limit = segment.policy.protected ? MAX : Math.min(full.length, target.get(segment.kind) ?? full.length);
    let text = full;

    if (limit < full.length) {
      const { text: trimmed } = trimLines(full, limit, segment.policy.drop);
      text = trimmed || full.slice(0, limit);
      const dropped = full.length - text.length;
      // Never truncate silently: a model that does not know something was cut will answer as
      // if it saw the whole record. One line costs a few tokens and removes that failure mode.
      text += `\n（本段因预算被截断 ${dropped} 字符，此处不完整）`;
      evictions.push({ kind: segment.kind, droppedChars: dropped });
    }

    // A trimmed memory block should keep its section header out of the way of counting.
    rendered.push(text);
    usedChars += text.length;
    reports.push({
      kind: segment.kind,
      chars: text.length,
      floor: segment.policy.floor,
      cap: segment.policy.cap,
      truncated: text.length < full.length,
      droppedChars: Math.max(0, full.length - text.length),
      meta: segment.meta,
    });
  }

  usedChars += dividerCost;

  // Everything before the first volatile segment is identical between consecutive turns, so
  // it is the part a provider can serve from cache.
  let cacheableChars = 0;
  for (let index = 0; index < active.length; index++) {
    if (active[index].stability === "volatile") break;
    cacheableChars += rendered[index].length + (index > 0 ? DIVIDER.length : 0);
  }

  return {
    prompt: rendered.join(DIVIDER),
    manifest: {
      budgetChars,
      usedChars,
      estimatedTokens: Math.ceil(usedChars / charsPerToken),
      charsPerToken,
      overBudget: budgetChars > 0 && usedChars > budgetChars,
      cacheableChars,
      segments: reports,
      skipped,
      dedup,
      conflicts,
      evictions,
    },
  };
}
