import * as lancedb from "@lancedb/lancedb";
import {
  COLLECTIONS,
  type Collection,
  type Row,
  type DumpedRow,
  type SearchHit,
  type RowSource,
} from "./types.js";
import { CLAUDE_ZERO_VECTOR_TAG, claudeEmbedder, type Embedder } from "./embed.js";

// Cosine distance ∈ [0, 2] → similarity ∈ [0, 1].
export function toSimilarity(cosineDistance: number): number {
  return Math.max(0, Math.min(1, 1 - cosineDistance / 2));
}

export function rowToHit(r: Row & { _distance: number }): SearchHit {
  return {
    text: r.text,
    score: toSimilarity(r._distance),
    obscurity: r.obscurity,
    tags: r.tags ? r.tags.split(",") : [],
    charId: r.charId,
    saveId: r.saveId ?? "",
    source: r.source ?? "runtime",
  };
}

/**
 * Hard cap on full-table scans (`pruneLoreOrphans`, `dumpAll`, Claude-mode lookups).
 * Typical corpus is in the low thousands; this is a safety belt, not a working ceiling.
 * If the corpus ever approaches this number, paginate instead of bumping the cap.
 */
const MAX_SCAN_ROWS = 1_000_000;

/**
 * Escape a string literal for LanceDB's SQL-like filter syntax. LanceDB has no
 * parameterized queries, so we double single quotes (SQL convention) to neutralize
 * the only character that can break out of a string literal. Use via `whereEq`.
 */
function sqlQuote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/** Build an equality predicate, e.g. `whereEq("charId", "corina")` → `charId = 'corina'`. */
function whereEq(field: string, value: string): string {
  return `${field} = ${sqlQuote(value)}`;
}

/**
 * SQL fragment that filters out rows written with the Claude-mode zero-vector
 * placeholder. Stored as `tags` substrings (LanceDB has no array column), so a
 * substring match on the tag is the cheapest reliable filter.
 */
const EXCLUDE_ZERO_VECTOR = `(tags IS NULL OR tags NOT LIKE '%${CLAUDE_ZERO_VECTOR_TAG}%')`;

/** k scales with INT modifier; minimum of 1, baseline 2. */
export function characterLookupK(intModifier: number): number {
  return Math.max(1, 2 + intModifier);
}

/** Minimum cosine similarity — low INT tightens the filter. */
export function characterLookupFloor(intModifier: number): number {
  return intModifier < 0 ? 0.55 : 0.45;
}

/**
 * A LanceDB-backed lore store with obscurity-gated retrieval.
 *
 * Ported from orson's `knowledge-core.ts` with the embedding backend injected
 * (an {@link Embedder}) rather than imported, so the same store can run in
 * Claude mode (no endpoint, obscurity-ranked) or with real vectors (ANN). When
 * `embedder.hasRealEmbeddings()` is false every read takes the Claude-mode
 * branch and every write stamps {@link CLAUDE_ZERO_VECTOR_TAG}.
 */
export class KnowledgeStore {
  private readonly tables = new Map<Collection, lancedb.Table>();

  constructor(
    private readonly db: lancedb.Connection,
    private readonly embedder: Embedder = claudeEmbedder,
  ) {}

  private claudeMode(): boolean {
    return !this.embedder.hasRealEmbeddings();
  }

  /**
   * Whether this store can produce MEANINGFUL similarity scores.
   *
   * Public because `score` is not self-describing: in Claude mode every hit is stamped
   * `score: 1` (there is no vector to measure against), and a consumer that compares
   * that against a threshold will find every threshold satisfied by an arbitrary row.
   * Anything that branches on similarity must ask this first.
   */
  hasRealEmbeddings(): boolean {
    return this.embedder.hasRealEmbeddings();
  }

  /**
   * Open (or create) a store at `dbDir`. `embedder` defaults to the
   * infrastructure-free Claude-mode embedder; pass {@link ollamaEmbedder} for ANN.
   */
  static async open(dbDir: string, embedder: Embedder = claudeEmbedder): Promise<KnowledgeStore> {
    const db = await lancedb.connect(dbDir);
    const store = new KnowledgeStore(db, embedder);
    // Sequential, not Promise.all: migrateTable can ALTER a table's schema, and running
    // three concurrent migrations against one LanceDB connection races on commit.
    for (const c of COLLECTIONS) await store.getTable(c);
    await store.ensureIndices();
    return store;
  }

  async getTable(collection: Collection): Promise<lancedb.Table> {
    const cached = this.tables.get(collection);
    if (cached) return cached;
    const names = await this.db.tableNames();
    if (names.includes(collection)) {
      const t = await this.db.openTable(collection);
      await this.migrateTable(t, collection);
      this.tables.set(collection, t);
      return t;
    }
    const probe = await this.embedder.embed("__schema__");
    const seed: Row = {
      vector: probe,
      text: "__schema__",
      tags: "",
      charId: "",
      obscurity: 0,
      ts: 0,
      saveId: "",
      source: "runtime",
    };
    const t = await this.db.createTable(collection, [seed]);
    await t.delete("text = '__schema__'");
    this.tables.set(collection, t);
    return t;
  }

  /**
   * Bring a table opened from disk up to the current schema.
   *
   * Stores predating the `saveId`/`source` columns hold every access-path signal inside
   * the comma-joined `tags` string, which cannot be indexed and cannot be matched
   * safely (see the note on Row.tags). This adds the columns in place — no rebuild, no
   * data movement — and derives their values from what the old rows already carry.
   *
   * Idempotent: it inspects the live schema first and does nothing once migrated.
   */
  private async migrateTable(t: lancedb.Table, collection: Collection): Promise<void> {
    const fields = new Set((await t.schema()).fields.map((f) => f.name));
    if (fields.has("saveId") && fields.has("source")) return;

    // Add columns ONE AT A TIME with constant defaults. Two constraints drive this:
    // lance's SQL planner rejects CASE expressions in addColumns (only simple exprs are
    // supported), and adding them separately means a migration interrupted between the
    // two resumes correctly rather than re-adding an existing column and throwing.
    if (!fields.has("saveId")) {
      // Everything predating the column is base canon or un-scoped runtime data.
      // Per-world back-fill happens below, where charId can actually be parsed.
      await t.addColumns([{ name: "saveId", valueSql: "''" }]);
    }
    if (!fields.has("source")) {
      await t.addColumns([{ name: "source", valueSql: "'runtime'" }]);
      // Then reclassify the authored rows. The old marker was a `source:lore` tag;
      // anything without it was written by the simulation. Substring matching is safe
      // HERE (unlike save ids) because the tag is a fixed literal that prefixes nothing.
      await t.update({ where: "tags LIKE '%source:lore%'", values: { source: "lore" } });
    }

    // Back-fill saveId for simulation memories, whose charId already encodes the world
    // as `starfall:<seed>:<villagerId>`. One UPDATE per distinct seed rather than per
    // row — there are a handful of worlds and potentially thousands of memories.
    if (!fields.has("saveId") && collection === "character_memories") {
      const rows = (await t.query().limit(MAX_SCAN_ROWS).toArray()) as Row[];
      const seeds = new Set<string>();
      for (const r of rows) {
        const m = /^starfall:(\d+):/.exec(String(r.charId ?? ""));
        if (m) seeds.add(m[1]);
      }
      for (const seed of seeds) {
        await t.update({
          where: `charId LIKE ${sqlQuote(`starfall:${seed}:%`)}`,
          values: { saveId: seed },
        });
      }
      if (seeds.size) {
        console.info(`[lore-core] migrated ${collection}: scoped ${seeds.size} world(s) by saveId`);
      }
    }
  }

  /**
   * Create scalar indices for the columns every hot query filters on. LanceDB scans
   * without them, which is invisible at a few hundred rows and painful once each save
   * contributes its own canon and memory stream.
   *
   * Safe to call repeatedly; an existing index is left alone. Failures are logged and
   * swallowed — an index is an optimization, and a store that can't build one should
   * still serve reads.
   */
  async ensureIndices(): Promise<void> {
    for (const collection of COLLECTIONS) {
      const t = await this.getTable(collection);
      let existing: Set<string>;
      try {
        existing = new Set((await t.listIndices()).map((i) => i.columns?.[0]).filter(Boolean) as string[]);
      } catch {
        existing = new Set();
      }
      for (const column of ["charId", "saveId", "source", "obscurity"]) {
        if (existing.has(column)) continue;
        try {
          await t.createIndex(column);
        } catch (err) {
          // An empty table has nothing to index yet — the common, harmless case.
          const msg = String(err);
          if (!/empty|no data|zero rows/i.test(msg)) {
            console.warn(`[lore-core] index on ${collection}.${column} failed: ${msg}`);
          }
        }
      }
    }
  }

  /**
   * SQL predicate scoping a read to one world: base canon plus that world's own facts,
   * and nothing belonging to another world. `undefined` means base canon only, which is
   * the correct default for anything that isn't playing a specific save.
   */
  private saveScope(saveId?: string, only = false): string {
    const id = (saveId ?? "").trim();
    if (!id) return `saveId = ''`;
    // `only` excludes base canon — for a caller that needs the two tiers SEPARATELY
    // ranked rather than merged, so neither can crowd the other out of a shared top-k.
    return only ? whereEq("saveId", id) : `saveId IN ('', ${sqlQuote(id)})`;
  }

  /**
   * Bulk existence check. Given a list of `(text, charId)` keys, returns the
   * subset that already exists in the collection. Lets a reindexer avoid N
   * individual SELECT round-trips when re-upserting a large markdown corpus
   * on every start; a single `text IN (...)` scan is orders of magnitude
   * cheaper than N probes.
   */
  async hasEntries(args: {
    collection: Collection;
    keys: Array<{ text: string; charId: string }>;
    /**
     * Which world's rows count as "present". MUST match the saveId the caller would
     * write with — presence is only meaningful within one tier.
     */
    saveId?: string;
  }): Promise<{ present: Array<{ text: string; charId: string }> }> {
    if (args.keys.length === 0) return { present: [] };
    const saveId = args.saveId ?? "";
    const t = await this.getTable(args.collection);
    const texts = Array.from(new Set(args.keys.map((k) => k.text)));
    const inList = texts.map(sqlQuote).join(", ");
    // Scope to the tier being checked. Identity in addEntry is (text, charId, saveId),
    // so a presence check keyed on only (text, charId) would report a row belonging to
    // a DIFFERENT world as already-present and the reindexer would skip the insert —
    // leaving base canon asserting a fact that exists in the index only as one save's
    // row, and vanishing entirely when that save later prunes it.
    const rows = (await t
      .query()
      .where(`text IN (${inList}) AND ${whereEq("saveId", saveId)}`)
      .limit(MAX_SCAN_ROWS)
      .toArray()) as Row[];
    const found = new Set(rows.map((r) => `${r.text}\t${r.charId ?? ""}`));
    const present = args.keys.filter((k) => found.has(`${k.text}\t${k.charId ?? ""}`));
    return { present };
  }

  async addEntry(args: {
    collection: Collection;
    text: string;
    obscurity: number;
    tags?: string[];
    charId?: string;
    /** `""` (default) = base canon, shared by every world. Otherwise the world seed. */
    saveId?: string;
    /** Defaults to `runtime` — the safe choice, since no reindex ever prunes it. */
    source?: RowSource;
  }): Promise<{ ok: true; inserted: boolean }> {
    if (typeof args.obscurity !== "number" || !Number.isFinite(args.obscurity)) {
      throw new Error("addEntry requires a numeric obscurity (recall DC, typically 5–30)");
    }
    const t = await this.getTable(args.collection);
    const charId = args.charId ?? "";
    const saveId = args.saveId ?? "";
    // Identity is (text, charId, saveId): the same sentence may legitimately be true in
    // base canon AND restated in one world, and those are different rows with different
    // lifecycles. Ignoring saveId here would let one world's fact suppress another's.
    const existing = await t
      .query()
      .where(
        `${whereEq("text", args.text)} AND ${whereEq("charId", charId)} AND ${whereEq("saveId", saveId)}`,
      )
      .limit(1)
      .toArray();
    if (existing.length > 0) {
      return { ok: true, inserted: false };
    }
    const vector = await this.embedder.embed(args.text);
    // Tag zero-vector rows so a later real-embedding session can detect them and
    // either rebuild from `lore/` or skip them in ANN ranking instead of trusting
    // a placeholder distance.
    const baseTags = args.tags ?? [];
    const tags = this.claudeMode() && !baseTags.includes(CLAUDE_ZERO_VECTOR_TAG)
      ? [...baseTags, CLAUDE_ZERO_VECTOR_TAG]
      : baseTags;
    const row: Row = {
      vector,
      text: args.text,
      tags: tags.join(","),
      charId,
      obscurity: args.obscurity,
      ts: Date.now(),
      saveId,
      source: args.source ?? "runtime",
    };
    await t.add([row]);
    return { ok: true, inserted: true };
  }

  /**
   * The most RECENT rows for one character — the recency window a conversation uses to
   * remember what was just said.
   *
   * The charId filter is pushed into SQL. It previously wasn't: the caller dumped the
   * entire `character_memories` table and filtered in JavaScript on every dialogue turn,
   * which is fine at a few hundred rows and untenable once every world contributes its
   * own memory stream. Ordering still happens in JS because LanceDB's JS query builder
   * has no ORDER BY — but it now sorts one villager's handful of rows instead of the
   * whole table.
   */
  async recentFor(args: {
    collection: Collection;
    charId: string;
    limit: number;
    saveId?: string;
  }): Promise<SearchHit[]> {
    const t = await this.getTable(args.collection);
    const rows = (await t
      .query()
      .where(`${whereEq("charId", args.charId)} AND ${this.saveScope(args.saveId)}`)
      .limit(MAX_SCAN_ROWS)
      .toArray()) as Row[];
    return rows
      .filter((r) => r.text !== "__schema__")
      .sort((a, b) => b.ts - a.ts)
      .slice(0, args.limit)
      .map((r) => ({
        text: r.text,
        score: 1,
        obscurity: r.obscurity,
        tags: r.tags ? r.tags.split(",").filter(Boolean) : [],
        charId: r.charId,
        saveId: r.saveId ?? "",
        source: r.source ?? "runtime",
      }));
  }

  /**
   * Delete every source-tagged row in a collection whose (text, charId) isn't in the
   * keep list. Runtime-added rows (no source tag) are untouched — that separation is
   * what lets authored canon and simulation output share one store. Returns the number
   * of rows deleted.
   *
   * `sourceTag` selects WHICH markdown-backed tier is being reconciled, so a consumer
   * can maintain several independently (Starfall reindexes base canon under
   * `source:lore` and each save's canon under `source:save`, and neither prune may
   * touch the other's rows).
   */
  async pruneLoreOrphans(args: {
    collection: Collection;
    keep: Array<{ text: string; charId: string }>;
    /** Which authored tier to reconcile. Runtime rows are never eligible. */
    source?: RowSource;
    /** Scope the prune to one world. `""`/undefined = base canon. */
    saveId?: string;
  }): Promise<{ deleted: number }> {
    const source = args.source ?? "lore";
    const saveId = (args.saveId ?? "").trim();
    const t = await this.getTable(args.collection);
    const keepKeys = new Set(args.keep.map((k) => `${k.text}\t${k.charId ?? ""}`));

    // Only this tier, only this world. Both are indexed equality predicates now, so the
    // scan reads just the rows that could possibly be deleted — and, more importantly,
    // one world's reindex can no longer delete another world's canon.
    const scope = `${whereEq("source", source)} AND ${whereEq("saveId", saveId)}`;
    const rows = (await t.query().where(scope).limit(MAX_SCAN_ROWS).toArray()) as Row[];

    let deleted = 0;
    for (const r of rows) {
      if (r.text === "__schema__") continue;
      const key = `${r.text}\t${r.charId ?? ""}`;
      if (keepKeys.has(key)) continue;
      await t.delete(
        `${whereEq("text", r.text)} AND ${whereEq("charId", r.charId ?? "")} AND ${scope}`,
      );
      deleted++;
    }
    return { deleted };
  }

  /** Delete every row belonging to one world. The lifecycle hook for deleting a save. */
  async deleteSave(saveId: string): Promise<{ deleted: number }> {
    const id = saveId.trim();
    if (!id) throw new Error("deleteSave requires a saveId — refusing to wipe base canon");
    let deleted = 0;
    for (const collection of COLLECTIONS) {
      const t = await this.getTable(collection);
      const before = (await t.query().where(whereEq("saveId", id)).limit(MAX_SCAN_ROWS).toArray()).length;
      if (before === 0) continue;
      await t.delete(whereEq("saveId", id));
      deleted += before;
    }
    return { deleted };
  }

  /**
   * Re-embed every row written under Claude mode (tagged {@link CLAUDE_ZERO_VECTOR_TAG})
   * with this store's real embedder, dropping the tag as each row is rewritten.
   *
   * WHY THIS EXISTS: a store built in Claude mode holds all-zero vectors, and every
   * real-embedding read path filters those rows out via {@link EXCLUDE_ZERO_VECTOR}.
   * So flipping a consumer from Claude mode to a real embedder makes the entire
   * existing corpus *invisible* rather than merely badly ranked. This is the migration
   * that closes that gap.
   *
   * ORDER MATTERS — add the replacement BEFORE deleting the original. LanceDB has no
   * multi-statement transaction, so an interrupt has to fail toward duplication rather
   * than loss: the delete predicate carries the zero-vector tag, so it can only ever
   * match the old row, never the freshly written one. Re-running after an interrupt is
   * therefore safe and idempotent — whatever still carries the tag still needs doing.
   *
   * Throws in Claude mode. Re-embedding with a zero embedder would strip the tag while
   * leaving the zeros in place, quietly converting a recoverable corpus into an
   * unrecoverable one — the single worst outcome available here, so it is a hard error
   * rather than a no-op.
   */
  async reembedAll(
    collection: Collection,
    opts: {
      /** Rows per write batch. Keeps the OR-predicate bounded. Default 64. */
      batch?: number;
      onProgress?: (done: number, total: number) => void;
    } = {},
  ): Promise<{ total: number; reembedded: number }> {
    if (this.claudeMode()) {
      throw new Error(
        "reembedAll requires a real embedder — running it in Claude mode would drop the " +
          "zero-vector tag while leaving zero vectors in place, making the corpus " +
          "permanently unrecoverable. Open the store with ollamaEmbedder() first.",
      );
    }
    const t = await this.getTable(collection);
    const stale = (await t
      .query()
      .where(`tags LIKE '%${CLAUDE_ZERO_VECTOR_TAG}%'`)
      .limit(MAX_SCAN_ROWS)
      .toArray()) as Row[];
    const pending = stale.filter((r) => r.text !== "__schema__");
    const total = pending.length;
    if (total === 0) return { total: 0, reembedded: 0 };

    const batchSize = Math.max(1, opts.batch ?? 64);
    let reembedded = 0;

    for (let i = 0; i < pending.length; i += batchSize) {
      const slice = pending.slice(i, i + batchSize);
      const rewritten: Row[] = [];
      for (const r of slice) {
        const tags = (r.tags ? r.tags.split(",") : []).filter(
          (tag) => tag !== CLAUDE_ZERO_VECTOR_TAG,
        );
        rewritten.push({
          vector: await this.embedder.embed(r.text),
          text: r.text,
          tags: tags.join(","),
          charId: r.charId ?? "",
          obscurity: r.obscurity,
          // Preserve the original timestamp — `recentMemories` and any recency-ordered
          // read treat ts as when the memory HAPPENED, not when it was last indexed.
          ts: r.ts,
          // Provenance and world-scope survive a re-embed untouched. Losing either would
          // silently move a row between tiers: a `lore` row demoted to `runtime` becomes
          // un-prunable, and a world's fact reset to `saveId:""` leaks into every save.
          saveId: r.saveId ?? "",
          source: r.source ?? "runtime",
        });
      }
      await t.add(rewritten);

      // Delete precisely the originals: (text, charId) pairs from THIS batch that still
      // carry the tag. A blanket `text IN (...)` would also catch same-text rows belonging
      // to other charIds that this batch never re-added.
      const pairs = slice
        .map(
          (r) =>
            `(${whereEq("text", r.text)} AND ${whereEq("charId", r.charId ?? "")}` +
            // saveId completes the identity. Without it a batch's delete would also reap
            // an identically-worded row belonging to another world that this batch never
            // re-added — silently losing that world's copy of the fact.
            ` AND ${whereEq("saveId", r.saveId ?? "")})`,
        )
        .join(" OR ");
      await t.delete(`tags LIKE '%${CLAUDE_ZERO_VECTOR_TAG}%' AND (${pairs})`);

      reembedded += slice.length;
      opts.onProgress?.(reembedded, total);
    }
    return { total, reembedded };
  }

  /**
   * Every row in a collection. Pass `saveId` to scope to one world (base canon plus
   * that world) — without it this is genuinely everything, including OTHER worlds'
   * rows, which is rarely what a user-facing listing wants.
   */
  async dumpAll(collection: Collection, opts: { saveId?: string } = {}): Promise<DumpedRow[]> {
    const t = await this.getTable(collection);
    const q = t.query();
    // Only filter when asked: callers like the migration and prune legitimately need
    // the unfiltered table, and an always-on scope would silently hide rows from them.
    const rows = (await (opts.saveId === undefined ? q : q.where(this.saveScope(opts.saveId)))
      .limit(MAX_SCAN_ROWS)
      .toArray()) as Row[];
    const out: DumpedRow[] = [];
    for (const r of rows) {
      if (r.text === "__schema__") continue;
      out.push({
        text: r.text,
        tags: r.tags,
        charId: r.charId,
        obscurity: r.obscurity,
        ts: r.ts,
        saveId: r.saveId ?? "",
        source: r.source ?? "runtime",
      });
    }
    return out;
  }

  /**
   * Raw relevance search within ONE collection, with no obscurity gate and no
   * role framing. `narratorLookup` and `characterLookup` model *who is recalling
   * what* — they exist to answer "what would this character plausibly know". This
   * answers a different question: "what does the corpus already say near this text",
   * regardless of who could know it.
   *
   * That distinction matters for auditing a proposed fact, where a secret is exactly
   * the row you most need to see: a new claim that contradicts hidden canon must be
   * caught, and an obscurity-gated read would hide the very row that proves it.
   */
  async searchCollection(args: {
    collection: Collection;
    query: string;
    k?: number;
    /** Scope to one world (base canon + that world). Omit for base canon only. */
    saveId?: string;
  }): Promise<SearchHit[]> {
    const k = args.k ?? 10;
    const t = await this.getTable(args.collection);
    const scope = this.saveScope(args.saveId);
    if (this.claudeMode()) {
      // No embeddings to rank with. Obscurity order is the only signal available and
      // it says nothing about relevance, so callers get the shallowest rows and should
      // treat scores as meaningless (1) — see the `score` field.
      const all = (await t.query().where(scope).limit(MAX_SCAN_ROWS).toArray()) as Row[];
      return all
        .filter((r) => r.text !== "__schema__")
        .sort((a, b) => a.obscurity - b.obscurity)
        .slice(0, k)
        .map((r) => ({
          text: r.text,
          score: 1,
          obscurity: r.obscurity,
          tags: r.tags ? r.tags.split(",") : [],
          charId: r.charId,
          saveId: r.saveId ?? "",
          source: r.source ?? "runtime",
        }));
    }
    const qv = await this.embedder.embed(args.query);
    const rows = (await t
      .vectorSearch(qv)
      .distanceType("cosine")
      .where(`${EXCLUDE_ZERO_VECTOR} AND ${scope}`)
      .limit(k)
      .toArray()) as Array<Row & { _distance: number }>;
    return rows.map(rowToHit);
  }

  async narratorLookup(args: {
    query: string;
    k?: number;
    maxObscurity?: number;
    /** Scope to one world (base canon + that world). Omit for base canon only. */
    saveId?: string;
    /** With `saveId`, return ONLY that world's rows — base canon excluded. */
    saveOnly?: boolean;
  }): Promise<SearchHit[]> {
    const k = args.k ?? 5;
    const t = await this.getTable("world_truth");
    const scope = this.saveScope(args.saveId, args.saveOnly);
    if (this.claudeMode()) {
      // No embeddings; return obscurity-ordered rows up to k. The LLM's attention
      // handles relevance across the small corpus.
      let q = t.query().where(
        typeof args.maxObscurity === "number"
          ? `obscurity <= ${args.maxObscurity} AND ${scope}`
          : scope,
      );
      const all = (await q.toArray()) as Row[];
      return all
        .filter((r) => r.text !== "__schema__")
        .sort((a, b) => a.obscurity - b.obscurity)
        .slice(0, k)
        .map((r) => ({
          text: r.text,
          score: 1,
          obscurity: r.obscurity,
          tags: r.tags ? r.tags.split(",") : [],
          charId: r.charId,
          saveId: r.saveId ?? "",
          source: r.source ?? "runtime",
        }));
    }
    const qv = await this.embedder.embed(args.query);
    let q = t.vectorSearch(qv).distanceType("cosine");
    const where = typeof args.maxObscurity === "number"
      ? `obscurity <= ${args.maxObscurity} AND ${EXCLUDE_ZERO_VECTOR} AND ${scope}`
      : `${EXCLUDE_ZERO_VECTOR} AND ${scope}`;
    q = q.where(where);
    const rows = (await q.limit(k).toArray()) as Array<Row & { _distance: number }>;
    return rows.map(rowToHit);
  }

  async characterLookup(args: {
    charId: string;
    query: string;
    intModifier: number;
    total: number;
    critFail?: boolean;
    /** Scope to one world (base canon + that world). Omit for base canon only. */
    saveId?: string;
  }): Promise<SearchHit[]> {
    const k = characterLookupK(args.intModifier);
    const skipTop = args.critFail ? 1 : 0;
    const scope = this.saveScope(args.saveId);
    const obscurityClause = `obscurity <= ${args.total} AND ${scope}`;
    const charIdClause = whereEq("charId", args.charId);

    const memsTable = await this.getTable("character_memories");
    const commonTable = await this.getTable("common_knowledge");

    if (this.claudeMode()) {
      const memRowsAll = (await memsTable
        .query()
        .where(`${charIdClause} AND ${obscurityClause}`)
        .limit(MAX_SCAN_ROWS)
        .toArray()) as Row[];
      const commonRowsAll = (await commonTable
        .query()
        .where(obscurityClause)
        .limit(MAX_SCAN_ROWS)
        .toArray()) as Row[];
      const all = [...memRowsAll, ...commonRowsAll]
        .filter((r) => r.text !== "__schema__")
        .sort((a, b) => a.obscurity - b.obscurity);
      const picked = all.slice(skipTop, skipTop + k);
      return picked.map((r) => ({
        text: r.text,
        score: 1,
        obscurity: r.obscurity,
        tags: r.tags ? r.tags.split(",") : [],
        charId: r.charId,
        saveId: r.saveId ?? "",
        source: r.source ?? "runtime",
      }));
    }

    const fetched = Math.max(k + skipTop + 2, 4);
    const qv = await this.embedder.embed(args.query);

    const memRows = (await memsTable
      .vectorSearch(qv)
      .distanceType("cosine")
      .where(`${charIdClause} AND ${obscurityClause} AND ${EXCLUDE_ZERO_VECTOR}`)
      .limit(fetched)
      .toArray()) as Array<Row & { _distance: number }>;

    const commonRows = (await commonTable
      .vectorSearch(qv)
      .distanceType("cosine")
      .where(`${obscurityClause} AND ${EXCLUDE_ZERO_VECTOR}`)
      .limit(fetched)
      .toArray()) as Array<Row & { _distance: number }>;

    const all = [...memRows, ...commonRows].sort((a, b) => a._distance - b._distance);
    const picked = all.slice(skipTop, skipTop + k);

    const minSimilarity = characterLookupFloor(args.intModifier);
    return picked.map(rowToHit).filter((h) => h.score >= minSimilarity);
  }
}
