/**
 * @datrapscallion/lore-core
 *
 * A lightweight, LanceDB-backed lore retrieval core extracted from orson. Open a
 * store over a `data/lancedb` directory and run obscurity-gated lookups:
 *
 *   import { KnowledgeStore } from "@datrapscallion/lore-core";
 *   const store = await KnowledgeStore.open("D:/source/orson/data/lancedb");
 *   const hits = await store.narratorLookup({ query: "the Shrine", k: 5 });
 *
 * Defaults to Claude mode (no embedding endpoint — reads rank by obscurity).
 * Pass `ollamaEmbedder()` to `KnowledgeStore.open` for real ANN vector search.
 */
export { KnowledgeStore, characterLookupK, characterLookupFloor, toSimilarity, rowToHit } from "./KnowledgeStore.js";
export { COLLECTIONS, OBSCURITY, ROW_SOURCES } from "./types.js";
export type { Collection, Row, DumpedRow, SearchHit, ObscurityLevel, RowSource } from "./types.js";

// The markdown authoring layer: parse `lore/**.md` into facts, and reconcile those
// facts into a store (upsert + prune orphans). Markdown is truth; the store is the
// derived index. See ./lore/reindex.ts for the contract.
export {
  parseLoreFile,
  defaultsForPath,
  parseLoreDocument,
  parseDocumentMeta,
} from "./lore/format.js";
export type { LoreFact, PathDefaults, LoreDocument } from "./lore/format.js";
export {
  reindexLoreFromMarkdown,
  loadAllLore,
  loadCommonKnowledgeFor,
  LORE_SOURCE_TAG,
} from "./lore/reindex.js";
export type { ReindexClient, ReindexResult } from "./lore/reindex.js";
export {
  claudeEmbedder,
  ollamaEmbedder,
  EMBED_DIM,
  CLAUDE_ZERO_VECTOR_TAG,
} from "./embed.js";
export type { Embedder } from "./embed.js";
