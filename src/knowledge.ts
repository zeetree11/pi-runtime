import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import { blobToVector, cosine, embedText, vectorToBlob } from "../mcp/lib/embed.mjs";

/**
 * Document knowledge base — the "RAG" half that memories deliberately are not.
 *
 * The split matters:
 *
 * - memories answer *"what do I know about this person"* — structured rows, exact scoping, every
 *   claim tied to an event. Retrieval there is a filter, not a similarity search.
 * - knowledge answers *"what does this document say"* — unstructured text, chunked and embedded,
 *   retrieved by similarity. There is no claim to verify and no subject to scope.
 *
 * Keeping them apart means a document can never be mistaken for something the user said, and a
 * memory can never be buried by a long PDF.
 *
 * Chunking is deliberately boring: fixed window with overlap, breaking on paragraph/sentence
 * boundaries when one is close. Overlap exists because an answer often straddles a boundary; 80
 * characters is roughly one sentence in Chinese.
 */
export const CHUNK_CHARS = 600;
export const CHUNK_OVERLAP = 80;

export type Chunk = { source: string; index: number; text: string };

export type KnowledgeHit = {
  id: number;
  source: string;
  chunkNo: number;
  text: string;
  score: number;
  model: string;
};

/**
 * Split into overlapping windows, preferring to break after a sentence or paragraph end.
 *
 * Export for tests: chunk boundaries are the one part of RAG that is cheap to get wrong and
 * expensive to notice.
 */
export function chunkText(text: string, chars = CHUNK_CHARS, overlap = CHUNK_OVERLAP): string[] {
  const normalized = String(text ?? "").replace(/\r\n/g, "\n").trim();
  if (!normalized) return [];
  if (normalized.length <= chars) return [normalized];

  const chunks: string[] = [];
  let start = 0;
  while (start < normalized.length) {
    let end = Math.min(normalized.length, start + chars);
    if (end < normalized.length) {
      // Look back for a natural break inside the last 30% of the window.
      const window = normalized.slice(start, end);
      const boundary = Math.max(
        window.lastIndexOf("\n\n"),
        window.lastIndexOf("。"),
        window.lastIndexOf("\n"),
        window.lastIndexOf("；"),
      );
      if (boundary > chars * 0.7) end = start + boundary + 1;
    }
    const piece = normalized.slice(start, end).trim();
    if (piece) chunks.push(piece);
    if (end >= normalized.length) break;
    start = Math.max(end - overlap, start + 1);
  }
  return chunks;
}

export class KnowledgeStore {
  private readonly db: DatabaseSync;

  constructor(dataDir: string) {
    this.db = new DatabaseSync(path.join(dataDir, "runtime.db"));
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec("PRAGMA busy_timeout = 5000;");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS knowledge_chunks (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        source          TEXT NOT NULL,
        chunk_no        INTEGER NOT NULL,
        text            TEXT NOT NULL,
        embedding       BLOB,
        embedding_model TEXT,
        created_at      TEXT NOT NULL
      );
    `);
    this.db.exec("CREATE INDEX IF NOT EXISTS idx_knowledge_source ON knowledge_chunks(source);");
  }

  /** Ingest a document: replace any previous chunks for the same source, then embed each chunk. */
  async add(source: string, text: string): Promise<{ source: string; chunks: number; model: string }> {
    const name = String(source ?? "").trim();
    if (!name) throw new Error("source 为空");
    const chunks = chunkText(text);
    if (chunks.length === 0) throw new Error("文档没有内容");

    this.remove(name);
    const createdAt = new Date().toISOString();
    let model = "";
    for (const [index, chunk] of chunks.entries()) {
      const embedded = await embedText(chunk);
      model = embedded.model;
      this.db
        .prepare(
          `INSERT INTO knowledge_chunks (source, chunk_no, text, embedding, embedding_model, created_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(name, index, chunk, vectorToBlob(embedded.vector), embedded.model, createdAt);
    }
    return { source: name, chunks: chunks.length, model };
  }

  /** Cosine search over chunks, restricted to one embedding space. */
  async search(query: string, options: { limit?: number; minScore?: number } = {}): Promise<KnowledgeHit[]> {
    const trimmed = String(query ?? "").trim();
    if (!trimmed) return [];
    const limit = Math.min(Math.max(options.limit ?? 5, 1), 20);
    const minScore = options.minScore ?? 0.08;
    const { vector, model } = await embedText(trimmed);

    const rows = this.db
      .prepare("SELECT * FROM knowledge_chunks WHERE embedding IS NOT NULL AND embedding_model = ?")
      .all(model) as Array<Record<string, unknown>>;

    const hits: KnowledgeHit[] = [];
    for (const row of rows) {
      const stored = blobToVector(row.embedding ?? null);
      if (!stored || stored.length !== vector.length) continue;
      const score = cosine(vector, stored);
      if (score < minScore) continue;
      hits.push({
        id: Number(row.id),
        source: String(row.source),
        chunkNo: Number(row.chunk_no),
        text: String(row.text),
        score,
        model: String(row.embedding_model),
      });
    }
    return hits.sort((a, b) => b.score - a.score).slice(0, limit);
  }

  list(): Array<{ source: string; chunks: number; chars: number }> {
    const rows = this.db
      .prepare(
        `SELECT source, COUNT(*) chunks, SUM(LENGTH(text)) chars
           FROM knowledge_chunks GROUP BY source ORDER BY source`,
      )
      .all() as Array<{ source: string; chunks: number; chars: number }>;
    return rows.map((row) => ({ source: String(row.source), chunks: Number(row.chunks), chars: Number(row.chars) }));
  }

  remove(source: string): boolean {
    const result = this.db.prepare("DELETE FROM knowledge_chunks WHERE source = ?").run(String(source));
    return Number(result.changes) > 0;
  }

  stats(): { documents: number; chunks: number; models: string[] } {
    const documents = this.list().length;
    const chunks = Number((this.db.prepare("SELECT COUNT(*) n FROM knowledge_chunks").get() as { n: number }).n);
    const models = (
      this.db
        .prepare("SELECT DISTINCT embedding_model m FROM knowledge_chunks WHERE embedding_model IS NOT NULL")
        .all() as Array<{ m: string }>
    ).map((row) => row.m);
    return { documents, chunks, models };
  }
}

/** Render hits as the block a model reads: source + position first, so quotes stay checkable. */
export function formatHits(hits: KnowledgeHit[], query: string): string {
  if (hits.length === 0) return `知识库里没有和「${query}」相关的内容。`;
  return [
    `## 知识库命中（${hits.length} 段，query: ${query}）`,
    ...hits.map(
      (hit) => `\n### ${hit.source} #${hit.chunkNo}（相关度 ${hit.score.toFixed(2)}）\n${hit.text}`,
    ),
  ].join("\n");
}
