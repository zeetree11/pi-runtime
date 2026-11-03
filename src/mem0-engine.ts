import { Memory } from "mem0ai/oss";
import type { MemoryRow } from "./memory.ts";

/**
 * Mem0 as the retrieval engine, our SQLite table as the source of truth.
 *
 * Why not replace the store: Mem0 keeps `(text, metadata, user_id)`. It has no notion of a
 * verbatim evidence quote, no four-state lifecycle (active / tentative / superseded / contested)
 * and no partial unique index on `key`. Those are the parts that make our memory auditable, so
 * they stay. Mem0 brings the retrieval plumbing — embedding call, vector store, dedupe scoring.
 *
 * Persistence model: the Node OSS build's `memory` vector store lives in the process. That is
 * fine here because it is a *cache*: on boot we replay the active rows from SQLite into Mem0. If
 * the process dies, nothing is lost; the rebuild takes milliseconds at our size. The alternative
 * (a separate Qdrant process) costs a service and 100–200 MB on a 1.7 GB box for an index that
 * holds a few hundred vectors.
 */
export type Mem0Config = {
  /** OpenAI-compatible embeddings endpoint. */
  baseURL: string;
  apiKey: string;
  model: string;
  /** Must match the endpoint's output; Mem0 refuses to guess when it cannot reach it. */
  dimension: number;
  collection?: string;
  /** Mem0 scopes every vector by entity; one owner is enough for a single-user runtime. */
  owner?: string;
  /**
   * Where the vectors live. Omitted = Mem0's in-process store (rebuilt from SQLite on boot).
   * With Qdrant the vectors survive restarts on their own, at the cost of one more service.
   */
  qdrantUrl?: string;
};

export type Recalled = { key: string; eventId: number | null; text: string; score: number };

export class Mem0Engine {
  private readonly memory: Memory;
  private readonly config: Mem0Config;
  private synced = new Set<string>();

  constructor(config: Mem0Config) {
    this.config = config;
    this.memory = new Memory({
      vectorStore: config.qdrantUrl
        ? {
            provider: "qdrant",
            config: {
              url: config.qdrantUrl,
              collectionName: config.collection ?? "memories",
              dimension: config.dimension,
            },
          }
        : {
            provider: "memory",
            config: { collectionName: config.collection ?? "memories" },
          },
      llm: {
        // Extraction is disabled (`infer: false`), so the LLM is never called; Mem0 still wants a
        // provider configured at construction time.
        provider: "openai",
        config: { apiKey: config.apiKey || "unused", model: "gpt-4o-mini" },
      },
      embedder: {
        provider: "openai",
        config: {
          apiKey: config.apiKey,
          model: config.model,
          baseURL: config.baseURL,
          embeddingDims: config.dimension,
        },
      },
      // Mem0 v3 wants the dimension up front; without it, it probes the endpoint at init.
      dimension: config.dimension,
    } as never);
  }

  /** Replay active rows into the in-process store. Idempotent per `key + updated_at`. */
  async sync(rows: MemoryRow[]): Promise<number> {
    let added = 0;
    for (const row of rows) {
      const stamp = `${row.key}@${row.updatedAt ?? ""}`;
      if (this.synced.has(stamp)) continue;
      this.synced.add(stamp);
      await this.memory.addToVectorStore(
        [{ role: "user", content: row.content }],
        // user_id is required: Mem0 refuses to search across an unscoped collection.
        {
          user_id: this.config.owner ?? "owner",
          key: row.key,
          eventId: row.evidenceEventId ?? null,
          subject: row.subject ?? null,
        },
        {},
        false,
      );
      added += 1;
    }
    return added;
  }

  async recall(query: string, limit = 5): Promise<Recalled[]> {
    // v3 rejects top-level entity params in search; the scope goes through `filters` with a
    // camelCase key (`userId`), while `addToVectorStore` metadata uses snake_case (`user_id`).
    const result: any = await this.memory.search(query, {
      limit,
      filters: { user_id: this.config.owner ?? "owner" },
    } as never);
    const items: any[] = result?.results ?? result?.memories ?? (Array.isArray(result) ? result : []);
    return items
      .map((item) => ({
        key: String(item?.metadata?.key ?? ""),
        eventId: item?.metadata?.eventId ?? null,
        text: String(item?.memory ?? item?.data ?? ""),
        score: Number(item?.score ?? 0),
      }))
      .filter((item) => item.key)
      // Mem0 returns its own topK; the caller's limit is authoritative here.
      .slice(0, Math.max(1, limit));
  }

  /** Cheap identity for logs: which model and space this engine is comparing against. */
  describe(): string {
    return `mem0/${this.config.qdrantUrl ? "qdrant" : "inmemory"} model=${this.config.model} dim=${this.config.dimension} synced=${this.synced.size}`;
  }
}

/** Read Mem0 settings from the environment; returns null when no embedding endpoint is set. */
export function mem0ConfigFromEnv(env: NodeJS.ProcessEnv = process.env): Mem0Config | null {
  const baseURL = env.MEM0_EMBED_BASE_URL ?? env.EMBEDDING_BASE_URL;
  const apiKey = env.MEM0_EMBED_API_KEY ?? env.EMBEDDING_API_KEY;
  const model = env.MEM0_EMBED_MODEL ?? env.EMBEDDING_MODEL;
  if (!baseURL || !model) return null;
  return {
    baseURL,
    apiKey: apiKey ?? "",
    model,
    dimension: Number(env.MEM0_EMBED_DIM ?? env.EMBEDDING_DIM ?? 1024),
    collection: env.MEM0_COLLECTION ?? "memories",
    qdrantUrl: env.MEM0_QDRANT_URL,
  };
}
