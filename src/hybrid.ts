/**
 * Hybrid recall: BM25 + vector, then an optional cross-encoder rerank.
 *
 * Why both, given the current numbers (recall@5 = 97% on 28 memories):
 *
 * - BM25 fixes a *specific* failure we actually observed: "数据库用的什么" missed the
 *   "runtime 用 SQLite 单机部署" memory entirely. Dense vectors blur rare tokens (SQLite, 912),
 *   lexical matching does not. It costs no model call.
 * - Rerank fixes ordering, not recall. It is expensive per candidate, so it runs *last*, on a
 *   shortlist, and only when a shortlist exists. Today it buys little; the point of building it
 *   now is that the trigger is a threshold (shortlist quality), not a rewrite.
 *
 * Fusion uses RRF (reciprocal rank fusion) rather than score averaging: cosine and BM25 live on
 * incomparable scales, and normalising them per query invents a relationship that is not there.
 * RRF only uses ranks, which is the one thing both sides agree on.
 */
export type Doc = { key: string; text: string };

/** Tokenise for BM25: latin words + CJK bigrams. Crude, and deliberately stateless. */
export function tokenize(text: string): string[] {
  const tokens: string[] = [];
  for (const word of String(text ?? "").toLowerCase().split(/[^a-z0-9\u4e00-\u9fa5]+/)) {
    if (!word) continue;
    if (/^[a-z0-9]+$/.test(word)) {
      tokens.push(word);
      continue;
    }
    // A single CJK character is too coarse (it matches almost everything); bigrams are the
    // smallest unit that still carries meaning without a dictionary.
    if (word.length === 1) tokens.push(word);
    for (let i = 0; i < word.length - 1; i += 1) tokens.push(word.slice(i, i + 2));
  }
  return tokens;
}

export type Bm25Hit = { key: string; score: number };

/** Classic BM25 with the usual k1/b defaults; scores are only comparable within one query. */
export function bm25(query: string, docs: Doc[], options: { k1?: number; b?: number } = {}): Bm25Hit[] {
  const k1 = options.k1 ?? 1.2;
  const b = options.b ?? 0.75;
  const queryTokens = tokenize(query);
  if (docs.length === 0 || queryTokens.length === 0) return [];

  const tokenised = docs.map((doc) => tokenize(doc.text));
  const avgLength = tokenised.reduce((sum, tokens) => sum + tokens.length, 0) / tokenised.length || 1;

  const df = new Map<string, number>();
  for (const tokens of tokenised) {
    for (const token of new Set(tokens)) df.set(token, (df.get(token) ?? 0) + 1);
  }

  const hits: Bm25Hit[] = [];
  for (const [index, doc] of docs.entries()) {
    const tokens = tokenised[index];
    const freq = new Map<string, number>();
    for (const token of tokens) freq.set(token, (freq.get(token) ?? 0) + 1);

    let score = 0;
    for (const token of queryTokens) {
      const tf = freq.get(token) ?? 0;
      if (tf === 0) continue;
      const n = df.get(token) ?? 0;
      const idf = Math.log(1 + (docs.length - n + 0.5) / (n + 0.5));
      score += idf * ((tf * (k1 + 1)) / (tf + k1 * (1 - b + (b * tokens.length) / avgLength)));
    }
    if (score > 0) hits.push({ key: doc.key, score });
  }
  return hits.sort((a, b2) => b2.score - a.score);
}

/**
 * Reciprocal rank fusion. `k` damps the influence of top ranks; 60 is the value from the
 * original paper and works fine as a default.
 */
export function rrf(lists: string[][], k = 60): Array<{ key: string; score: number }> {
  const scores = new Map<string, number>();
  for (const list of lists) {
    for (const [rank, key] of list.entries()) {
      scores.set(key, (scores.get(key) ?? 0) + 1 / (k + rank + 1));
    }
  }
  return [...scores.entries()].map(([key, score]) => ({ key, score })).sort((a, b) => b.score - a.score);
}

export type RerankConfig = { baseURL: string; apiKey: string; model: string };

/**
 * Cross-encoder rerank through an OpenAI-compatible `/rerank` endpoint (SiliconFlow's shape).
 *
 * Failure is never fatal: if the endpoint is unreachable the caller keeps the fused order. A
 * ranking refinement must not be able to take memory recall down with it.
 */
export async function rerank(
  query: string,
  docs: Doc[],
  config: RerankConfig,
  options: { topN?: number } = {},
): Promise<Array<{ key: string; score: number }> | null> {
  if (docs.length === 0) return [];
  try {
    const response = await fetch(`${config.baseURL.replace(/\/$/, "")}/rerank`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${config.apiKey}` },
      body: JSON.stringify({
        model: config.model,
        query,
        documents: docs.map((doc) => doc.text),
        top_n: options.topN ?? docs.length,
      }),
    });
    if (!response.ok) return null;
    const payload: any = await response.json();
    const items: any[] = payload?.results ?? [];
    return items
      .map((item) => ({ key: docs[item.index]?.key ?? "", score: Number(item.relevance_score ?? 0) }))
      .filter((item) => item.key);
  } catch {
    return null;
  }
}
