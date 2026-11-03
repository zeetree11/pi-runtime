import { Memory } from "mem0ai/oss";
const m = new Memory({
  vectorStore: { provider: "memory", config: { collectionName: "t" } },
  llm: { provider: "openai", config: { apiKey: "x", model: "gpt-4o-mini" } },
  embedder: { provider: "openai", config: { apiKey: "x", model: "text-embedding-3-small" } },
});
for (const name of ["createMemory", "search", "addToVectorStore"]) {
  console.log("=== " + name + " ===");
  console.log(m[name].toString().slice(0, 420).replace(/\n\s+/g, " "));
}
