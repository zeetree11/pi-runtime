/**
 * Embedding helpers shared by the runtime and the memory MCP server.
 *
 * Two providers, one interface:
 *
 * - `hash`  — deterministic character n-gram hashing, no network, no key. It captures surface
 *             similarity (shared vocabulary) but not meaning. Enough for "did the user mention
 *             the concurrency thing" while keeping the system usable offline.
 * - `http`  — any OpenAI-compatible /v1/embeddings endpoint. Enable by setting
 *             EMBEDDING_BASE_URL, EMBEDDING_API_KEY and EMBEDDING_MODEL.
 *
 * Why the hash fallback exists at all: a memory search that silently returns nothing when an
 * API key is missing is worse than a rough search. The provider is explicit (`embedding_model`
 * is stored next to the vector) so a later switch never silently compares vectors from two
 * different spaces.
 */

export const HASH_MODEL = "hash-256";
const HASH_DIM = 256;

/** Character n-gram hashing into a fixed-size vector, then L2-normalised. */
export function hashEmbed(text, dim = HASH_DIM) {
  const vector = new Float32Array(dim);
  const normalized = String(text ?? "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
  if (!normalized) return vector;

  const counts = new Map();
  // Character bigrams work better than words for Chinese, where "并发" has no spaces.
  const chars = [...normalized];
  for (let i = 0; i < chars.length; i += 1) {
    const gram = i + 1 < chars.length ? chars[i] + chars[i + 1] : chars[i];
    counts.set(gram, (counts.get(gram) ?? 0) + 1);
  }
  for (const [gram, count] of counts) {
    let hash = 2166136261;
    for (const ch of gram) {
      hash ^= ch.codePointAt(0);
      hash = Math.imul(hash, 16777619);
    }
    const index = Math.abs(hash) % dim;
    vector[index] += 1 + Math.log(count);
  }

  let norm = 0;
  for (const value of vector) norm += value * value;
  norm = Math.sqrt(norm);
  if (norm > 0) for (let i = 0; i < dim; i += 1) vector[i] /= norm;
  return vector;
}

export function cosine(a, b) {
  if (!a || !b || a.length !== b.length) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i += 1) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

export function vectorToBlob(vector) {
  return Buffer.from(new Float32Array(vector).buffer);
}

export function blobToVector(blob) {
  if (!blob) return null;
  const buffer = Buffer.isBuffer(blob) ? blob : Buffer.from(blob);
  if (buffer.byteLength % 4 !== 0) return null;
  const copy = Buffer.from(buffer);
  return new Float32Array(copy.buffer, copy.byteOffset, copy.byteLength / 4);
}

export function embeddingConfig(env = process.env) {
  const baseUrl = env.EMBEDDING_BASE_URL ?? "";
  const apiKey = env.EMBEDDING_API_KEY ?? "";
  const model = env.EMBEDDING_MODEL ?? "";
  if (!baseUrl || !apiKey || !model) {
    return { provider: "hash", model: HASH_MODEL, baseUrl: "", apiKey: "", dim: HASH_DIM };
  }
  return { provider: "http", model, baseUrl: baseUrl.replace(/\/$/, ""), apiKey, dim: 0 };
}

async function httpEmbed(text, config, signal) {
  const response = await fetch(`${config.baseUrl}/embeddings`, {
    method: "POST",
    signal,
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${config.apiKey}`,
    },
    body: JSON.stringify({ model: config.model, input: text }),
  });
  if (!response.ok) throw new Error(`embedding HTTP ${response.status}`);
  const payload = await response.json();
  const vector = payload?.data?.[0]?.embedding;
  if (!Array.isArray(vector)) throw new Error("embedding 响应缺少 data[0].embedding");
  return Float32Array.from(vector);
}

/**
 * Embed one text. Falls back to the hash provider when the HTTP call fails, so a quota error
 * degrades recall instead of breaking memory writes.
 */
export async function embedText(text, options = {}) {
  const config = options.config ?? embeddingConfig();
  if (config.provider === "hash") return { vector: hashEmbed(text), model: HASH_MODEL };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 15_000);
  try {
    const vector = await httpEmbed(text, config, controller.signal);
    return { vector, model: config.model };
  } catch {
    return { vector: hashEmbed(text), model: HASH_MODEL };
  } finally {
    clearTimeout(timer);
  }
}
