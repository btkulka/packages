/**
 * The three lore collections. Mirrors orson's `src/types.ts` so a store opened
 * by either project sees the same table names.
 *
 * - `world_truth`        — narrator-omniscient world canon (charId empty).
 * - `character_memories` — per-character recall, scoped by `charId`, INT-gated.
 * - `common_knowledge`   — public, location-scoped knowledge (charId empty).
 */
export const COLLECTIONS = ["world_truth", "character_memories", "common_knowledge"] as const;
export type Collection = (typeof COLLECTIONS)[number];

/**
 * The canonical obscurity scale — a fact's recall DC, in D&D terms: how hard it is
 * to know. Reads are gated against it, and in Claude mode (no embeddings) it is the
 * *only* ranking signal, so lower means "surfaces first".
 *
 * Mirrors orson's `src/types.ts`. Authors reach for these by keyword in markdown
 * (`- [secret] …`), which `parseLoreFile` resolves through this table.
 *
 * NOTE: a consumer may keep its own scale for runtime rows on the same numeric axis
 * — Starfall's `server/memory.ts` uses belief/episode/gossip for procedural villager
 * memories. Those coexist deliberately; they are not this enum and should not be
 * folded into it.
 */
export const OBSCURITY = {
  trivial: 5,
  common: 10,
  uncommon: 15,
  rare: 20,
  hidden: 25,
  secret: 30,
} as const;
export type ObscurityLevel = (typeof OBSCURITY)[keyof typeof OBSCURITY];

/**
 * Where a row came from, and therefore who may delete it. A first-class column rather
 * than a tag because every prune filters on it, and because a scan that parses tag
 * strings in JS is the thing this column exists to eliminate.
 *
 * - `lore`    — authored base canon, reconciled from markdown. Pruned when its bullet
 *               disappears from the corpus.
 * - `save`    — canon generated for ONE world. Pruned per-save, never across saves.
 * - `runtime` — written by the simulation (episodes, gossip, beliefs). Never pruned by
 *               any reindex; only the sim's own lifecycle removes these.
 */
export const ROW_SOURCES = ["lore", "save", "runtime"] as const;
export type RowSource = (typeof ROW_SOURCES)[number];

/** A stored row. `vector` is the embedding (768-dim, or all-zero in Claude mode). */
export interface Row extends Record<string, unknown> {
  vector: number[];
  text: string;
  /**
   * Comma-separated tags (LanceDB has no array column). FREE-FORM ANNOTATION ONLY —
   * anything a hot query filters on belongs in a real column instead. Substring
   * matching on this field is not a filter: `tags LIKE '%save:1%'` also matches
   * `save:12` and `save:100`, which is exactly the bug `saveId` exists to prevent.
   */
  tags: string;
  /** Owning character id for `character_memories`, else "". */
  charId: string;
  /** Recall DC, typically 5–30 (trivial→secret). */
  obscurity: number;
  /** Insert epoch (ms). */
  ts: number;
  /**
   * Which world this row belongs to. `""` = base canon, shared by every save. Otherwise
   * the world seed as a string. A read for save S is `saveId IN ('', S)` — base canon
   * plus that world's own additions, and nothing from any other world.
   */
  saveId: string;
  /** {@link RowSource}. Stored as a plain string so LanceDB can index it. */
  source: string;
}

/**
 * A row without its (large) embedding vector — for diagnostics/dumps. Declared
 * explicitly (not `Omit<Row, "vector">`) so it does NOT inherit `Row`'s
 * `Record<string, unknown>` index signature, which would widen field access to
 * `unknown` for consumers.
 */
export interface DumpedRow {
  text: string;
  tags: string;
  charId: string;
  obscurity: number;
  ts: number;
  saveId: string;
  source: string;
}

/** A retrieval result. `score` is cosine similarity in [0,1] (1 in Claude mode). */
export interface SearchHit {
  text: string;
  score: number;
  obscurity: number;
  tags: string[];
  charId: string;
  /**
   * Which world this hit came from — `""` for base canon, else the world seed. A
   * scoped read returns base and save rows unioned, and the caller usually needs to
   * tell them apart: what is true everywhere reads differently to a character than
   * what became true in this world alone.
   */
  saveId?: string;
  /** {@link RowSource} of the underlying row, when known. */
  source?: string;
}
