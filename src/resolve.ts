import { scoreConfidence } from "./confidence.ts";
import type { MemoryRow } from "./memory.ts";

/**
 * Resolve a collision between memories that claim the same thing at different times.
 *
 * Two forces decide, and they pull in opposite directions:
 *
 * - **credibility** grows with evidence quality: confirmed repeatedly, used often, phrased without
 *   hedging. `confidence.ts` already scores this.
 * - **recency** grows with time: a statement from last week beats a confident one from last year,
 *   because preferences and facts change while old memories never do.
 *
 * The rule is multiplicative (`credibility × decay`), not a ranking of either alone:
 *
 * - recency alone would let a vague aside today beat a repeatedly confirmed fact;
 * - credibility alone would keep a stale preference alive forever.
 *
 * When the top two land within `TIE_EPSILON` the result is **contested**, not a silent pick. An
 * ambiguous memory is more useful reported than guessed, because the caller can then ask.
 */
export const TIE_EPSILON = 0.05;

export type Candidate = {
  row: MemoryRow;
  credibility: number;
  recency: number;
  score: number;
  ageDays: number;
  factors: string[];
};

export type Resolution = {
  winner: Candidate | null;
  runners: Candidate[];
  /** True when the top two are too close to call: surface it instead of pretending certainty. */
  contested: boolean;
  reason: string;
};

const HALF_LIFE_DAYS: Record<string, number | null> = { preference: null, fact: 90, event: 365 };

function daysBetween(from: string | undefined, now: Date): number {
  if (!from) return 0;
  const at = new Date(from);
  if (Number.isNaN(at.getTime())) return 0;
  return Math.max(0, (now.getTime() - at.getTime()) / 86_400_000);
}

/** Score one candidate: credibility from evidence, recency decay by category. */
export function scoreCandidate(row: MemoryRow, now = new Date(), confirmations = 1): Candidate {
  const ageDays = daysBetween(row.updatedAt ?? row.createdAt, now);
  const confidence = scoreConfidence({
    category: (row.category as "preference" | "fact" | "event") ?? "fact",
    fromUser: Boolean(row.evidenceEventId),
    text: row.content,
    confirmations,
    ageDays,
  });

  const halfLife = HALF_LIFE_DAYS[row.category] ?? 90;
  // scoreConfidence already decays facts/events; preferences are exempt there because tastes are
  // not "wrong" just because they are old — but they still lose to a newer stated taste. This
  // factor is that tie-break, and it is deliberately mild.
  const recency = halfLife === null
    ? Math.pow(0.5, ageDays / 365)
    : Math.pow(0.5, ageDays / (halfLife * 2));

  return {
    row,
    credibility: confidence.score,
    recency,
    score: confidence.score * recency,
    ageDays,
    factors: [...confidence.factors, `时效 ×${recency.toFixed(2)}（${Math.round(ageDays)} 天前）`],
  };
}

/** Pick the most credible-and-recent claim. Ties are reported, never hidden. */
export function resolveCollision(rows: MemoryRow[], options: { now?: Date; confirmations?: number } = {}): Resolution {
  const now = options.now ?? new Date();
  const candidates = rows
    .map((row) => scoreCandidate(row, now, options.confirmations ?? 1))
    .sort((a, b) => {
      if (Math.abs(a.score - b.score) > 1e-9) return b.score - a.score;
      // Equal scores: the newer row wins, then the larger id (monotonic within one database).
      const byAge = a.ageDays - b.ageDays;
      if (Math.abs(byAge) > 1e-9) return byAge;
      return b.row.id - a.row.id;
    });

  if (candidates.length === 0) {
    return { winner: null, runners: [], contested: false, reason: "没有候选记忆" };
  }

  const [best, second] = candidates;
  const contested = Boolean(second) && Math.abs(best.score - second.score) <= TIE_EPSILON;

  const reason = contested
    ? `#${best.row.id}（${best.score.toFixed(2)}）与 #${second.row.id}（${second.score.toFixed(2)}）差距 ≤ ${TIE_EPSILON}，判为有争议`
    : `#${best.row.id} 胜出：可信度 ${best.credibility.toFixed(2)} × 时效 ${best.recency.toFixed(2)} = ${best.score.toFixed(2)}`;

  return { winner: best, runners: candidates.slice(1), contested, reason };
}
