import type { MemoryRow } from "./memory.ts";

/**
 * Preference precedence: the latest statement wins, deterministically.
 *
 * The failure this prevents is subtle and common: a user says "I like Python" today and "use C++
 * from now on" next week. Both may end up as separate active rows (different `key`), and the
 * model then sees two preferences with no ordering information — it picks whichever reads nicer.
 *
 * Two mechanisms, in order of reliability:
 *
 * 1. **Slot resolution** (this file): give related preferences one canonical slot, so the newer
 *    row supersedes the older one in the store instead of coexisting.
 * 2. **Answer check** (`violations`): even with slots, a stale carry-over is possible, so the
 *    reply is scanned for the outdated value and flagged. Flagging, not rewriting — silently
 *    editing model output hides the bug instead of fixing it.
 */
export type Slot = "language" | "editor" | "framework" | "database" | "reply_length" | "other";

/** Signals strong enough to call a slot; anything else stays "other" and is never merged. */
const SLOT_RULES: Array<[Slot, RegExp]> = [
  ["language", /(语言|开发语言|写代码.{0,6}用|用什么写|python|c\+\+|golang|rust|java\b|typescript)/i],
  ["editor", /(编辑器|ide|vscode|vs code|jetbrains|neovim|vim)/i],
  ["framework", /(框架|react|vue|svelte|spring|django|fastapi)/i],
  ["database", /(数据库|sqlite|postgres|mysql|redis|mongo)/i],
  ["reply_length", /(回复.{0,4}(短|长)|字数|简洁|详细)/],
];

export function slotOf(text: string): Slot {
  for (const [slot, pattern] of SLOT_RULES) {
    if (pattern.test(text)) return slot;
  }
  return "other";
}

/** Values that identify a preference, so an old value can be recognised in a reply. */
const VALUE_WORDS: Array<[string, RegExp]> = [
  ["python", /python/i],
  ["c++", /c\+\+|cpp/i],
  ["rust", /rust/i],
  ["go", /\bgolang\b|\bgo\b/i],
  ["java", /\bjava\b/i],
  ["typescript", /typescript|\bts\b/i],
  ["vscode", /vscode|vs code/i],
  ["neovim", /neovim|\bnvim\b/i],
];

export function valuesIn(text: string): string[] {
  return VALUE_WORDS.filter(([, pattern]) => pattern.test(text)).map(([value]) => value);
}

export type Resolution = {
  /** The row that should be treated as current, per slot. */
  current: MemoryRow[];
  /** Rows about a slot that were replaced by a newer one. */
  outdated: MemoryRow[];
};

/**
 * Resolve which active rows are "current" per slot.
 *
 * Only rows that land in the same slot compete; two unrelated preferences are never compared.
 * Ties are broken by `updatedAt`, which is what the store sets on every write.
 */
export function resolvePreferences(rows: MemoryRow[]): Resolution {
  // Callers should pass active *and* superseded preference rows: the store retires the old row on
  // write, so a guard that only looks at active rows can never see what was replaced.
  const bySlot = new Map<Slot, MemoryRow[]>();
  for (const row of rows) {
    if (row.category !== "preference") continue;
    const slot = slotOf(`${row.key} ${row.content}`);
    if (slot === "other") continue;
    const list = bySlot.get(slot) ?? [];
    list.push(row);
    bySlot.set(slot, list);
  }

  const current: MemoryRow[] = [];
  const outdated: MemoryRow[] = [];
  for (const list of bySlot.values()) {
    // Timestamps can collide (two writes in the same second, e.g. a corrected statement right
    // after the original). Fall back to id, which is monotonic, so "latest" is never ambiguous.
    const sorted = [...list].sort((a, b) => {
      const byTime = String(a.updatedAt ?? "").localeCompare(String(b.updatedAt ?? ""));
      return byTime !== 0 ? byTime : a.id - b.id;
    });
    const newest = sorted[sorted.length - 1];
    if (!newest) continue;
    current.push(newest);
    outdated.push(...sorted.slice(0, -1));
  }
  return { current, outdated };
}

export type Violation = { slot: Slot; staleValue: string; currentValue: string; currentEventId: number | null };

/**
 * Scan a reply for values that were superseded.
 *
 * A violation means the reply used a value that a newer memory contradicts. It is reported with
 * the row that should have been followed, so the caller can log it, ask for a rewrite, or just
 * surface it — but the decision stays explicit rather than hidden in a prompt.
 */
export function violations(reply: string, resolution: Resolution): Violation[] {
  const found = valuesIn(reply);
  const result: Violation[] = [];
  for (const stale of resolution.outdated) {
    const staleValues = valuesIn(`${stale.key} ${stale.content}`);
    const currentRow = resolution.current.find((row) => slotOf(`${row.key} ${row.content}`) === slotOf(`${stale.key} ${stale.content}`));
    if (!currentRow) continue;
    const currentValues = valuesIn(`${currentRow.key} ${currentRow.content}`);
    for (const value of staleValues) {
      if (currentValues.includes(value)) continue; // same value, not a contradiction
      if (!found.includes(value)) continue; // reply did not use it
      result.push({
        slot: slotOf(`${stale.key} ${stale.content}`),
        staleValue: value,
        currentValue: currentValues[0] ?? "",
        currentEventId: currentRow.evidenceEventId ?? null,
      });
    }
  }
  return result;
}

/** One line the prompt can carry so the model knows which preference is current. */
export function precedenceNote(resolution: Resolution): string {
  if (resolution.current.length === 0) return "";
  const lines = resolution.current.map((row) => {
    const slot = slotOf(`${row.key} ${row.content}`);
    return `- ${slot}：${row.content}（更新于 ${String(row.updatedAt ?? "").slice(0, 10) || "未知"}）`;
  });
  return ["## 当前生效偏好（同槽位以最新为准）", ...lines].join("\n");
}
