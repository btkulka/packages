/**
 * Markdown → store reconciliation.
 *
 * THE CONTRACT: markdown is truth, the vector store is a derived index. Every fact
 * written from markdown carries a source tag; after upserting, any tagged row no
 * longer present in the corpus is pruned. So editing a `.md` and re-running is the
 * whole migration story — there is never a schema migration to write, and a deleted
 * bullet actually disappears.
 *
 * Rows written at RUNTIME (procedural memories, gossip, anything without the source
 * tag) are never touched by the prune. That separation is what lets one store hold
 * both authored canon and simulation output safely.
 *
 * Ported from orson's `src/lore/index.ts`, with two changes for shared use:
 *   - `loreDir` and `cachePath` are required rather than package-relative defaults;
 *     a shared package has no business guessing a consumer's directory layout.
 *   - `sourceTag` is configurable, so a consumer can maintain several independent
 *     markdown-backed tiers in one store (Starfall's per-save canon does this).
 */
import { readFile, writeFile } from "node:fs/promises";
import { readdirSync, existsSync, statSync } from "node:fs";
import { relative, resolve, sep } from "node:path";
import { defaultsForPath, parseLoreFile, type LoreFact } from "./format.js";

/** Default tag marking a row as sourced from markdown. Used by the prune step. */
export const LORE_SOURCE_TAG = "source:lore";

interface LoreCacheEntry {
  mtimeMs: number;
  facts: LoreFact[];
}

interface LoreCache {
  version: 1;
  files: Record<string, LoreCacheEntry>;
}

async function readCache(path: string): Promise<LoreCache> {
  if (!existsSync(path)) return { version: 1, files: {} };
  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as LoreCache;
    if (parsed?.version !== 1 || typeof parsed.files !== "object") {
      return { version: 1, files: {} };
    }
    return parsed;
  } catch {
    return { version: 1, files: {} };
  }
}

async function writeCache(path: string, cache: LoreCache): Promise<void> {
  await writeFile(path, JSON.stringify(cache), "utf8");
}

function walkMarkdown(dir: string, root = dir): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = resolve(dir, entry.name);
    if (entry.isDirectory()) out.push(...walkMarkdown(full, root));
    else if (entry.isFile() && entry.name.endsWith(".md")) out.push(full);
  }
  return out;
}

/** Parse every `.md` under `loreDir` into facts. Throws on a malformed file. */
export async function loadAllLore(loreDir: string): Promise<LoreFact[]> {
  const files = walkMarkdown(loreDir);
  const facts: LoreFact[] = [];
  for (const file of files) {
    const rel = relative(loreDir, file).split(sep).join("/");
    const defaults = defaultsForPath(rel);
    if (!defaults) continue;
    const raw = await readFile(file, "utf8");
    try {
      facts.push(...parseLoreFile(raw, defaults));
    } catch (err) {
      throw new Error(`Failed to parse lore file ${rel}: ${(err as Error).message}`);
    }
  }
  return facts;
}

export interface ReindexClient {
  addEntry(args: {
    collection: LoreFact["collection"];
    text: string;
    obscurity: number;
    tags: string[];
    charId?: string;
    saveId?: string;
    source?: "lore" | "save" | "runtime";
  }): Promise<unknown>;
  pruneLoreOrphans(args: {
    collection: LoreFact["collection"];
    keep: Array<{ text: string; charId: string }>;
    source?: "lore" | "save" | "runtime";
    saveId?: string;
  }): Promise<unknown>;
  /**
   * Optional. When provided, reindex does one `IN (...)` scan per collection instead
   * of N individual probes. Falls back to addEntry's own idempotency when absent.
   */
  hasEntries?(args: {
    collection: LoreFact["collection"];
    keys: Array<{ text: string; charId: string }>;
    saveId?: string;
  }): Promise<unknown>;
}

export interface ReindexResult {
  total: number;
  inserted: number;
  pruned: number;
  skippedFiles: number;
}

function factKey(f: { text: string; charId: string }): string {
  return `${f.text}\t${f.charId ?? ""}`;
}

/**
 * Parse every `.md` under `loreDir` and reconcile it into the store.
 *
 * Two optimizations over a naive re-upsert, both of which matter because this runs on
 * every boot:
 *   1. Per-file mtime cache at `cachePath`. An unchanged file reuses its cached parse
 *      and skips the presence check entirely — by construction its facts are already in.
 *   2. Bulk presence check via `hasEntries` (one `IN (...)` scan per collection) for the
 *      facts that do need probing.
 *
 * Keep the cache beside the store it describes, so deleting the store also invalidates
 * the cache. A cache that outlives its store would report everything as already-indexed
 * against an empty table.
 */
export async function reindexLoreFromMarkdown(
  client: ReindexClient,
  loreDir: string,
  cachePath: string,
  opts: {
    /** Which authored tier this corpus is. Default `lore` (base canon). */
    source?: "lore" | "save";
    /** World seed when `source` is `save`. Base canon leaves this empty. */
    saveId?: string;
  } = {},
): Promise<ReindexResult> {
  const source = opts.source ?? "lore";
  const saveId = (opts.saveId ?? "").trim();
  if (source === "save" && !saveId) {
    throw new Error("reindexLoreFromMarkdown: source 'save' requires a saveId");
  }
  const files = walkMarkdown(loreDir);
  const prevCache = await readCache(cachePath);
  const nextCache: LoreCache = { version: 1, files: {} };

  const allFacts: LoreFact[] = [];
  const factsNeedingCheck: LoreFact[] = [];
  let skippedFiles = 0;

  for (const file of files) {
    const rel = relative(loreDir, file).split(sep).join("/");
    const defaults = defaultsForPath(rel);
    if (!defaults) continue;
    const mtimeMs = statSync(file).mtimeMs;
    const cached = prevCache.files[rel];
    if (cached && cached.mtimeMs === mtimeMs) {
      allFacts.push(...cached.facts);
      nextCache.files[rel] = cached;
      skippedFiles += 1;
      continue;
    }
    const raw = await readFile(file, "utf8");
    let parsed: LoreFact[];
    try {
      parsed = parseLoreFile(raw, defaults);
    } catch (err) {
      throw new Error(`Failed to parse lore file ${rel}: ${(err as Error).message}`);
    }
    allFacts.push(...parsed);
    factsNeedingCheck.push(...parsed);
    nextCache.files[rel] = { mtimeMs, facts: parsed };
  }

  const missingByKey = await resolveMissingFacts(client, factsNeedingCheck, saveId);

  let inserted = 0;
  for (const f of factsNeedingCheck) {
    if (missingByKey && !missingByKey.has(`${f.collection}\t${factKey(f)}`)) continue;
    // The legacy `source:lore` tag is still written for readability in dumps and for
    // any consumer reading tags directly — but it is no longer load-bearing. Provenance
    // now lives in the indexed `source` column, which is what prune actually filters on.
    const tags = f.tags.includes(LORE_SOURCE_TAG) ? f.tags : [...f.tags, LORE_SOURCE_TAG];
    const res = (await client.addEntry({
      collection: f.collection,
      text: f.text,
      obscurity: f.obscurity,
      tags,
      charId: f.charId || undefined,
      saveId,
      source,
    })) as { inserted?: boolean };
    if (res?.inserted) inserted += 1;
  }

  const byCollection = new Map<LoreFact["collection"], Array<{ text: string; charId: string }>>();
  for (const f of allFacts) {
    const arr = byCollection.get(f.collection) ?? [];
    arr.push({ text: f.text, charId: f.charId });
    byCollection.set(f.collection, arr);
  }
  let pruned = 0;
  for (const collection of ["world_truth", "character_memories", "common_knowledge"] as const) {
    const res = (await client.pruneLoreOrphans({
      collection,
      keep: byCollection.get(collection) ?? [],
      source,
      saveId,
    })) as { deleted?: number };
    if (typeof res?.deleted === "number") pruned += res.deleted;
  }

  await writeCache(cachePath, nextCache);

  return { total: allFacts.length, inserted, pruned, skippedFiles };
}

/**
 * Keys (as `collection\ttext\tcharId`) that are NOT already in the store, i.e. need
 * inserting. Returns null when the client can't bulk-check, in which case callers fall
 * back to addEntry's per-fact idempotency.
 */
async function resolveMissingFacts(
  client: ReindexClient,
  facts: LoreFact[],
  saveId: string,
): Promise<Set<string> | null> {
  if (!client.hasEntries || facts.length === 0) return null;
  const byCollection = new Map<LoreFact["collection"], Array<{ text: string; charId: string }>>();
  for (const f of facts) {
    const arr = byCollection.get(f.collection) ?? [];
    arr.push({ text: f.text, charId: f.charId });
    byCollection.set(f.collection, arr);
  }
  const missing = new Set<string>();
  for (const [collection, keys] of byCollection) {
    // Scoped to the tier being reconciled: a row in another world is NOT evidence that
    // this tier already holds the fact.
    const res = (await client.hasEntries({ collection, keys, saveId })) as {
      present?: Array<{ text: string; charId: string }>;
    };
    const presentSet = new Set((res?.present ?? []).map(factKey));
    for (const k of keys) {
      if (!presentSet.has(factKey(k))) missing.add(`${collection}\t${factKey(k)}`);
    }
  }
  return missing;
}

/**
 * Fact texts from one location's common-knowledge file, in author order. Returns []
 * when the file doesn't exist — a location is not required to have common knowledge.
 */
export async function loadCommonKnowledgeFor(
  locationId: string,
  loreDir: string,
): Promise<string[]> {
  const path = resolve(loreDir, "common", `${locationId}.md`);
  if (!existsSync(path)) return [];
  const raw = await readFile(path, "utf8");
  return parseLoreFile(raw, { collection: "common_knowledge", charId: "" }).map((f) => f.text);
}
