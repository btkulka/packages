import { existsSync, statSync, type Stats } from "node:fs";
import { copyFile, mkdir, readdir, rename, stat, unlink } from "node:fs/promises";
import { join } from "node:path";
import type { DatabaseSync, SQLInputValue, StatementSync } from "node:sqlite";
import { keyValueStore, migrate, openDatabase, placeholders, runOnce, transaction, type KeyValueStore } from "@btkulka/sqlite-store";
import type {
  AddResult,
  CollectionInfo,
  ConceptLink,
  ItemKind,
  MeshInfo,
  FileMode,
  ImageDetail,
  ImageRow,
  LibraryInfo,
  MoveResult,
  ScanResult,
  SearchQuery,
  ViewRequest,
  SearchResult,
  Sidecar,
  StackRef,
  TagInfo,
  VideoInfo,
  WatchInfo,
} from "./types.js";
import { imageSize } from "./imagesize.js";
import { companionsOf, conceptStems, isPart, meshBeside, meshInfo, readModelMeta, readSet, sidecarStems } from "./models.js";
import { extOf, folderOf, IMAGE_EXTS, isImage, isModel, isUnder, isVideo, likeEscape, markdownSrc, nameOf, normPath, sidecarOf } from "./paths.js";
import { parseSidecar, readSidecar } from "./sidecar.js";
import { videoInfo } from "./video.js";

// The library: one SQLite file that several processes can share (WAL, so one writes while another reads:
// Benhäus's Gallery page and Gallery's MCP server). Collections are virtual: an image can sit in several,
// and filing it never touches the disk. Moving and renaming files are their own actions, and they keep
// the gemini-image sidecar with its image. Items are pictures, 3D models and videos.

/**
 * The star: the tag the Gallery page's star sets, and what a pick in a chat records. It was "picked"
 * until 2026-11-19, when Ben renamed it; a library's old "picked" tag folds into it each time it opens (an
 * older Benhäus may still be adding it). `PICKED` is the same tag, under its old name.
 */
export const STARRED = "starred";
export const PICKED = STARRED;
const OLD_STAR = "picked";

const NOW = "(strftime('%Y-%m-%dT%H:%M:%fZ','now'))";

const MIGRATIONS = [
  `
  CREATE TABLE collections (
    id INTEGER PRIMARY KEY,
    parent_id INTEGER REFERENCES collections(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    folder TEXT,
    note TEXT NOT NULL DEFAULT '',
    sort INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT ${NOW}
  );
  CREATE UNIQUE INDEX collections_name ON collections (ifnull(parent_id, 0), name COLLATE NOCASE);

  CREATE TABLE images (
    id INTEGER PRIMARY KEY,
    path TEXT NOT NULL UNIQUE COLLATE NOCASE,
    name TEXT NOT NULL,
    folder TEXT NOT NULL COLLATE NOCASE,
    ext TEXT NOT NULL,
    bytes INTEGER NOT NULL DEFAULT 0,
    width INTEGER,
    height INTEGER,
    mtime INTEGER NOT NULL DEFAULT 0,
    created TEXT NOT NULL,
    added_at TEXT NOT NULL DEFAULT ${NOW},
    missing INTEGER NOT NULL DEFAULT 0,
    note TEXT NOT NULL DEFAULT '',
    prompt TEXT,
    model TEXT,
    usd REAL,
    sidecar TEXT,
    sidecar_mtime INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX images_folder ON images (folder);
  CREATE INDEX images_created ON images (created);
  CREATE INDEX images_bytes ON images (bytes);

  CREATE TABLE collection_images (
    collection_id INTEGER NOT NULL REFERENCES collections(id) ON DELETE CASCADE,
    image_id INTEGER NOT NULL REFERENCES images(id) ON DELETE CASCADE,
    added_at TEXT NOT NULL DEFAULT ${NOW},
    PRIMARY KEY (collection_id, image_id)
  ) WITHOUT ROWID;
  CREATE INDEX collection_images_image ON collection_images (image_id);

  CREATE TABLE tags (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL UNIQUE COLLATE NOCASE,
    created_at TEXT NOT NULL DEFAULT ${NOW}
  );
  CREATE TABLE image_tags (
    image_id INTEGER NOT NULL REFERENCES images(id) ON DELETE CASCADE,
    tag_id INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
    at TEXT NOT NULL DEFAULT ${NOW},
    PRIMARY KEY (image_id, tag_id)
  ) WITHOUT ROWID;
  CREATE INDEX image_tags_tag ON image_tags (tag_id);

  CREATE TABLE watches (
    id INTEGER PRIMARY KEY,
    folder TEXT NOT NULL UNIQUE COLLATE NOCASE,
    collection_id INTEGER REFERENCES collections(id) ON DELETE SET NULL,
    recursive INTEGER NOT NULL DEFAULT 1,
    enabled INTEGER NOT NULL DEFAULT 1,
    last_scan TEXT,
    created_at TEXT NOT NULL DEFAULT ${NOW}
  );
  `,
  // 3D models are items too: kind 'model', what's in them (mesh, as JSON), their triangles, and the concept
  // image they came from (concept_ref, what their sidecar says; concept_id, one set by hand).
  `
  ALTER TABLE images ADD COLUMN kind TEXT NOT NULL DEFAULT 'image';
  ALTER TABLE images ADD COLUMN mesh TEXT;
  ALTER TABLE images ADD COLUMN tris INTEGER;
  ALTER TABLE images ADD COLUMN concept_ref TEXT;
  ALTER TABLE images ADD COLUMN concept_id INTEGER REFERENCES images(id) ON DELETE SET NULL;
  CREATE INDEX images_kind ON images (kind);
  `,
  // Stacks: versions of one thing shown as one tile (a model's textured and untextured meshes). stack_id groups
  // them, stack_pos orders them, the first is the front runner. A stack left with one member is no stack.
  `
  ALTER TABLE images ADD COLUMN stack_id INTEGER;
  ALTER TABLE images ADD COLUMN stack_pos INTEGER NOT NULL DEFAULT 0;
  CREATE INDEX images_stack ON images (stack_id) WHERE stack_id IS NOT NULL;
  CREATE TRIGGER images_stack_tidy AFTER DELETE ON images WHEN old.stack_id IS NOT NULL
  BEGIN
    UPDATE images SET stack_id = NULL, stack_pos = 0 WHERE stack_id = old.stack_id AND (SELECT count(*) FROM images WHERE stack_id = old.stack_id) < 2;
  END;
  `,
  // Taken out of a stack by hand: the textured/untextured pairing leaves it alone from then on.
  `ALTER TABLE images ADD COLUMN stack_apart INTEGER NOT NULL DEFAULT 0;`,
  // Videos are items too: kind 'video', ffprobe's facts as JSON (their frame size in width and height). And
  // every item's views: how often it's been opened large on the Gallery page, and when last.
  `
  ALTER TABLE images ADD COLUMN video TEXT;
  ALTER TABLE images ADD COLUMN views INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE images ADD COLUMN viewed_at TEXT;
  `,
];

/** node:sqlite's DatabaseSync, handed in by the app (the package never imports a driver). */
export type SqliteDriver = typeof DatabaseSync;

/**
 * Opens (and creates or migrates) a library file. `driver` is node:sqlite's DatabaseSync:
 * `openLibrary(DatabaseSync, "D:/source/gallery/data/gallery.db")`.
 */
/**
 * `busyTimeout`: how long a statement waits for another connection's lock, in ms (sqlite-store's default,
 * 5000, when not given). An app that opens the library on a thread a person is waiting on (Benhäus's main
 * process) gives a short one and retries a busy call itself, off that thread.
 */
export function openLibrary(driver: SqliteDriver, path: string, options: { busyTimeout?: number } = {}): Library {
  const db = openDatabase(driver, path, {
    ...(options.busyTimeout !== undefined && { busyTimeout: options.busyTimeout }),
    init: (db) => {
      migrate(db, { steps: MIGRATIONS });
      runOnce(db, "picked_tag_v1", (db) => void db.prepare("INSERT OR IGNORE INTO tags (name) VALUES (?)").run(STARRED));
      foldOldStar(db);
    },
  });
  const lib = new Library(db, path);
  // Models that came in before stacks, or through an older copy of this package: twins stack now.
  lib.stackVariants();
  return lib;
}

type Row = Record<string, unknown>;
const p = (v: unknown): SQLInputValue => (v === undefined ? null : typeof v === "boolean" ? (v ? 1 : 0) : (v as SQLInputValue));
const num = (v: unknown) => (v == null ? null : Number(v));
const SEP = "\u001f";
const SKIP_DIRS = new Set(["node_modules", "__pycache__"]);
const BAD_NAME = /[<>:"/\\|?*\u0000-\u001f]/;

/** A problem worth saying as it is (no such collection, a name that's taken); anything else is a bug. */
export class LibraryError extends Error {}

export class Library {
  readonly db: DatabaseSync;
  readonly dbPath: string;
  /** Small shared state between the window and the MCP server (what to show, whether the window is up). */
  readonly state: KeyValueStore;
  private cache = new Map<string, StatementSync>();

  constructor(db: DatabaseSync, dbPath: string) {
    this.db = db;
    this.dbPath = dbPath;
    this.state = keyValueStore(db, "state");
  }

  /** Asks the Gallery window to show something (it looks within a second, or on its next start). */
  requestView(v: Omit<ViewRequest, "at">): ViewRequest {
    const req = { ...v, at: Date.now() };
    this.state.setJson("view_request", req);
    return req;
  }

  /** The window's side: a request it hasn't shown yet, no older than `maxAgeMs`. */
  takeViewRequest(maxAgeMs = 120_000): ViewRequest | undefined {
    const req = this.state.getJson<ViewRequest | null>("view_request", null);
    if (!req) return undefined;
    this.state.delete("view_request");
    return Date.now() - req.at <= maxAgeMs ? req : undefined;
  }

/** The window says it's up; the MCP server reads this to know whether to start it. Benhäus says so every 15s. */
  heartbeat() {
    this.state.set("window_alive", String(Date.now()));
  }
  /** The window is going: no longer up, without waiting for its last heartbeat to age out. */
  windowClosed() {
    this.state.delete("window_alive");
  }
  windowAlive(withinMs = 45_000): boolean {
    return Date.now() - Number(this.state.get("window_alive") ?? 0) < withinMs;
  }

  close() {
    this.cache.clear();
    this.db.close();
  }

  private q(sql: string): StatementSync {
    let s = this.cache.get(sql);
    if (!s) this.cache.set(sql, (s = this.db.prepare(sql)));
    return s;
  }
  private all(sql: string, ...args: unknown[]): Row[] {
    return this.q(sql).all(...args.map(p)) as Row[];
  }
  private get(sql: string, ...args: unknown[]): Row | undefined {
    return this.q(sql).get(...args.map(p)) as Row | undefined;
  }
  private run(sql: string, ...args: unknown[]) {
    return this.q(sql).run(...args.map(p));
  }
  private tx<T>(fn: () => T): T {
    return transaction(this.db, fn);
  }

  /** A named one-time step on this library (an app's seed collections, a data fix): runs once per file, ever. */
  once(name: string, step: (lib: Library) => void): boolean {
    return runOnce(this.db, name, () => step(this));
  }

  /** Changes when another connection (the MCP server, the window) commits: PRAGMA data_version. */
  dataVersion(): number {
    // Prepared once: Benhäus asks every second.
    return Number(this.get("PRAGMA data_version")?.data_version);
  }

  info(): LibraryInfo {
    const c = (sql: string) => Number(this.get(sql)?.n ?? 0);
    return {
      db: this.dbPath,
      images: c("SELECT count(*) n FROM images WHERE missing = 0 AND kind = 'image'"),
      meshes: c("SELECT count(*) n FROM images WHERE missing = 0 AND kind = 'model'"),
      videos: c("SELECT count(*) n FROM images WHERE missing = 0 AND kind = 'video'"),
      missing: c("SELECT count(*) n FROM images WHERE missing = 1"),
      collections: c("SELECT count(*) n FROM collections"),
      tags: c("SELECT count(*) n FROM tags"),
      watches: c("SELECT count(*) n FROM watches"),
      models: this.all("SELECT DISTINCT model FROM images WHERE model IS NOT NULL ORDER BY model").map((r) => String(r.model)),
    };
  }

  // ── Collections ────────────────────────────────────────────────────────

  listCollections(): CollectionInfo[] {
    const rows = this.all("SELECT id, parent_id, name, folder, note FROM collections ORDER BY sort, name COLLATE NOCASE");
    const direct = new Map(
      this.all("SELECT ci.collection_id id, count(*) n FROM collection_images ci JOIN images i ON i.id = ci.image_id AND i.missing = 0 GROUP BY ci.collection_id").map((r) => [Number(r.id), Number(r.n)]),
    );
    const total = new Map(
      this.all(
        `WITH RECURSIVE sub(root, id) AS (SELECT id, id FROM collections UNION ALL SELECT sub.root, c.id FROM collections c JOIN sub ON c.parent_id = sub.id)
         SELECT sub.root id, count(DISTINCT ci.image_id) n FROM sub JOIN collection_images ci ON ci.collection_id = sub.id JOIN images i ON i.id = ci.image_id AND i.missing = 0 GROUP BY sub.root`,
      ).map((r) => [Number(r.id), Number(r.n)]),
    );
    const byId = new Map(rows.map((r) => [Number(r.id), r]));
    const pathOf = (id: number): string => {
      const parts: string[] = [];
      for (let r = byId.get(id), guard = 0; r && guard < 64; r = r.parent_id == null ? undefined : byId.get(Number(r.parent_id)), guard++) parts.unshift(String(r.name));
      return parts.join(" › ");
    };
    return rows.map((r) => {
      const id = Number(r.id);
      return { id, parentId: num(r.parent_id), name: String(r.name), folder: (r.folder as string | null) ?? null, note: String(r.note ?? ""), count: direct.get(id) ?? 0, total: total.get(id) ?? 0, path: pathOf(id) };
    });
  }

  collection(id: number): CollectionInfo {
    const c = this.listCollections().find((x) => x.id === id);
    if (!c) throw new LibraryError(`No collection #${id}.`);
    return c;
  }

  /** The collection and every one below it. */
  descendants(id: number): number[] {
    return this.all("WITH RECURSIVE sub(id) AS (SELECT ? UNION ALL SELECT c.id FROM collections c JOIN sub ON c.parent_id = sub.id) SELECT id FROM sub", id).map((r) => Number(r.id));
  }

  /** A collection by id, by path ("toejam > Money Warehouse > Concept art", › and / work too), or by a name that's unique. */
  resolveCollection(ref: number | string): CollectionInfo {
    const all = this.listCollections();
    if (typeof ref === "number" || /^\s*#?\d+\s*$/.test(ref)) {
      const id = typeof ref === "number" ? ref : Number(ref.replace(/\D/g, ""));
      const c = all.find((x) => x.id === id);
      if (!c) throw new LibraryError(`No collection #${id}.`);
      return c;
    }
    const parts = ref.split(/\s*[>›/]\s*/).map((s) => s.trim()).filter(Boolean);
    if (!parts.length) throw new LibraryError("Name a collection.");
    if (parts.length > 1) {
      let parent: number | null = null;
      let hit: CollectionInfo | undefined;
      for (const part of parts) {
        hit = all.find((x) => x.parentId === parent && x.name.toLowerCase() === part.toLowerCase());
        if (!hit) throw new LibraryError(`No collection "${part}" under ${parent == null ? "the top" : all.find((x) => x.id === parent)?.path}.`);
        parent = hit.id;
      }
      return hit!;
    }
    const named = all.filter((x) => x.name.toLowerCase() === parts[0].toLowerCase());
    if (named.length === 1) return named[0];
    if (named.length > 1) throw new LibraryError(`"${parts[0]}" is more than one collection: ${named.map((x) => `#${x.id} ${x.path}`).join("; ")}. Give the path or the id.`);
    throw new LibraryError(`No collection called "${parts[0]}".`);
  }

  createCollection(o: { name: string; parentId?: number | null; folder?: string | null; note?: string }): CollectionInfo {
    const name = o.name.trim();
    if (!name) throw new LibraryError("A collection needs a name.");
    if (/[>›]/.test(name)) throw new LibraryError("A collection's name can't hold > or ›; those separate a path.");
    if (o.parentId != null) this.collection(o.parentId);
    try {
      const id = Number(this.run("INSERT INTO collections (parent_id, name, folder, note) VALUES (?, ?, ?, ?)", o.parentId ?? null, name, o.folder ? normPath(o.folder) : null, o.note ?? "").lastInsertRowid);
      return this.collection(id);
    } catch (e) {
      if (/UNIQUE/i.test(String(e))) throw new LibraryError(`There's already a collection called "${name}" there.`);
      throw e;
    }
  }

  /** Every collection along a path, created where missing. */
  ensureCollectionPath(path: string): CollectionInfo {
    const parts = path.split(/\s*[>›/]\s*/).map((s) => s.trim()).filter(Boolean);
    if (!parts.length) throw new LibraryError("Name a collection.");
    let parent: number | null = null;
    let hit: CollectionInfo | undefined;
    for (const part of parts) {
      hit = this.listCollections().find((x) => x.parentId === parent && x.name.toLowerCase() === part.toLowerCase()) ?? this.createCollection({ name: part, parentId: parent });
      parent = hit.id;
    }
    return hit!;
  }

  updateCollection(id: number, o: { name?: string; parentId?: number | null; folder?: string | null; note?: string }): CollectionInfo {
    const c = this.collection(id);
    if (o.parentId !== undefined && o.parentId !== null) {
      if (this.descendants(id).includes(o.parentId)) throw new LibraryError(`Can't put ${c.path} inside itself.`);
      this.collection(o.parentId);
    }
    const name = o.name === undefined ? c.name : o.name.trim();
    if (!name) throw new LibraryError("A collection needs a name.");
    if (/[>›]/.test(name)) throw new LibraryError("A collection's name can't hold > or ›; those separate a path.");
    try {
      this.run(
        "UPDATE collections SET name = ?, parent_id = ?, folder = ?, note = ? WHERE id = ?",
        name,
        o.parentId === undefined ? c.parentId : o.parentId,
        o.folder === undefined ? c.folder : o.folder ? normPath(o.folder) : null,
        o.note === undefined ? c.note : o.note,
        id,
      );
    } catch (e) {
      if (/UNIQUE/i.test(String(e))) throw new LibraryError(`There's already a collection called "${name}" there.`);
      throw e;
    }
    return this.collection(id);
  }

  /** Deletes the collection and everything below it. Images stay in the library. */
  deleteCollection(id: number): { removed: number } {
    this.collection(id);
    const n = this.descendants(id).length;
    this.run("DELETE FROM collections WHERE id = ?", id);
    return { removed: n };
  }

  /** Files images into a collection: add (also keeps them where they are), move (out of `fromId`, or out of every other collection) or remove. */
  fileImages(ids: number[], collectionId: number, mode: FileMode = "add", fromId?: number | null): { changed: number } {
    this.collection(collectionId);
    if (!ids.length) return { changed: 0 };
    return this.tx(() => {
      let changed = 0;
      if (mode === "remove") {
        changed = Number(this.db.prepare(`DELETE FROM collection_images WHERE collection_id = ? AND image_id IN (${placeholders(ids)})`).run(collectionId, ...ids).changes);
        return { changed };
      }
      if (mode === "move") {
        if (fromId != null) this.db.prepare(`DELETE FROM collection_images WHERE collection_id = ? AND image_id IN (${placeholders(ids)})`).run(fromId, ...ids);
        else this.db.prepare(`DELETE FROM collection_images WHERE collection_id <> ? AND image_id IN (${placeholders(ids)})`).run(collectionId, ...ids);
      }
      for (const id of ids) changed += Number(this.run("INSERT OR IGNORE INTO collection_images (collection_id, image_id) SELECT ?, id FROM images WHERE id = ?", collectionId, id).changes);
      return { changed: mode === "move" ? ids.length : changed };
    });
  }

  // ── Images ─────────────────────────────────────────────────────────────

  private rowOf(r: Row): ImageRow {
    const json = <T>(v: unknown): T | null => {
      if (!v) return null;
      try {
        return JSON.parse(String(v)) as T;
      } catch {
        return null;
      }
    };
    return {
      id: Number(r.id),
      kind: r.kind === "model" || r.kind === "video" ? r.kind : "image",
      path: String(r.path),
      name: String(r.name),
      folder: String(r.folder),
      ext: String(r.ext),
      bytes: Number(r.bytes),
      width: num(r.width),
      height: num(r.height),
      mtime: Number(r.mtime),
      created: String(r.created),
      addedAt: String(r.added_at),
      missing: Number(r.missing) === 1,
      prompt: (r.prompt as string | null) ?? null,
      model: (r.model as string | null) ?? null,
      usd: num(r.usd),
      tags: r.tags ? String(r.tags).split(SEP).sort((a, b) => a.localeCompare(b)) : [],
      tris: num(r.tris),
      mesh: json<MeshInfo>(r.mesh),
      video: json<VideoInfo>(r.video),
      views: Number(r.views ?? 0),
      viewedAt: (r.viewed_at as string | null) ?? null,
      stack: r.stack_id == null ? null : this.stackRef(Number(r.stack_id), Number(r.id)),
    };
  }

  private stackRef(id: number, me: number): StackRef | null {
    const ids = this.all("SELECT id FROM images WHERE stack_id = ? ORDER BY stack_pos, id", id).map((r) => Number(r.id));
    return ids.length > 1 ? { id, ids, front: ids[0] === me } : null;
  }

  private static COLS = `i.id, i.kind, i.path, i.name, i.folder, i.ext, i.bytes, i.width, i.height, i.mtime, i.created, i.added_at, i.missing, i.prompt, i.model, i.usd, i.tris, i.mesh, i.video, i.views, i.viewed_at, i.stack_id,
    (SELECT group_concat(t.name, char(31)) FROM image_tags it JOIN tags t ON t.id = it.tag_id WHERE it.image_id = i.id) tags`;

  search(q: SearchQuery = {}): SearchResult {
    const where: string[] = [];
    const args: unknown[] = [];
    let missing = q.missing ?? "hide";
    const hasTag = (neg: boolean, name: string) => {
      where.push(`${neg ? "NOT " : ""}EXISTS (SELECT 1 FROM image_tags it JOIN tags t ON t.id = it.tag_id WHERE it.image_id = i.id AND t.name = ? COLLATE NOCASE)`);
      args.push(name);
    };
    for (const t of terms(q.text ?? "")) {
      const like = `%${likeEscape(t.value)}%`;
      if (t.field === "tag") hasTag(t.neg, t.value);
      else if (t.field === "model") {
        where.push(`${t.neg ? "NOT " : ""}ifnull(i.model, '') LIKE ? ESCAPE '\\'`);
        args.push(like);
      } else if (t.field === "ext") {
        where.push(`i.ext ${t.neg ? "<>" : "="} ?`);
        args.push(t.value.replace(/^\./, "").toLowerCase());
      } else if (t.field === "is") {
        const v = t.value.toLowerCase();
        if (v === "starred" || v === "star" || v === OLD_STAR) hasTag(t.neg, STARRED);
        else if (KIND_WORDS[v]) {
          where.push(`i.kind ${t.neg ? "<>" : "="} ?`);
          args.push(KIND_WORDS[v]);
        }
        else if (v === "missing") missing = t.neg ? "hide" : "only";
        else if (v === "untagged") where.push(`${t.neg ? "" : "NOT "}EXISTS (SELECT 1 FROM image_tags it WHERE it.image_id = i.id)`);
        else if (v === "unfiled") where.push(`${t.neg ? "" : "NOT "}EXISTS (SELECT 1 FROM collection_images ci WHERE ci.image_id = i.id)`);
      } else if (t.field === "size") {
        const b = sizeTerm(t.value);
        if (b) {
          where.push(`${t.neg ? "NOT " : ""}i.bytes ${b.op} ?`);
          args.push(b.bytes);
        }
      } else if (t.field === "in") {
        let ids: number[] = [];
        try {
          ids = this.descendants(this.resolveCollection(t.value).id);
        } catch {}
        where.push(`${t.neg ? "NOT " : ""}EXISTS (SELECT 1 FROM collection_images ci WHERE ci.image_id = i.id AND ci.collection_id IN (${placeholders(ids)}))`);
        args.push(...ids);
      } else {
        where.push(
          `${t.neg ? "NOT " : ""}(i.name LIKE ?1 ESCAPE '\\' OR i.folder LIKE ?1 ESCAPE '\\' OR ifnull(i.prompt, '') LIKE ?1 ESCAPE '\\' OR ifnull(i.model, '') LIKE ?1 ESCAPE '\\' OR i.note LIKE ?1 ESCAPE '\\'
            OR EXISTS (SELECT 1 FROM image_tags it JOIN tags t ON t.id = it.tag_id WHERE it.image_id = i.id AND t.name LIKE ?1 ESCAPE '\\'))`.replace(/\?1/g, "?"),
        );
        args.push(like, like, like, like, like, like);
      }
    }
    if (missing === "hide") where.push("i.missing = 0");
    else if (missing === "only") where.push("i.missing = 1");
    if (q.collectionId != null) {
      const ids = q.includeSub === false ? [q.collectionId] : this.descendants(q.collectionId);
      where.push(`EXISTS (SELECT 1 FROM collection_images ci WHERE ci.image_id = i.id AND ci.collection_id IN (${placeholders(ids)}))`);
      args.push(...ids);
    }
    if (q.kind) {
      where.push("i.kind = ?");
      args.push(q.kind);
    }
    if (q.unfiled) where.push("NOT EXISTS (SELECT 1 FROM collection_images ci WHERE ci.image_id = i.id)");
    for (const t of q.tags ?? []) hasTag(false, t);
    for (const t of q.notTags ?? []) hasTag(true, t);
    if (q.untagged) where.push("NOT EXISTS (SELECT 1 FROM image_tags it WHERE it.image_id = i.id)");
    if (q.model) {
      where.push("ifnull(i.model, '') LIKE ? ESCAPE '\\'");
      args.push(`%${likeEscape(q.model)}%`);
    }
    if (q.from) {
      where.push("i.created >= ?");
      args.push(q.from);
    }
    if (q.to) {
      where.push("i.created <= ?");
      args.push(q.to.length === 10 ? `${q.to}T\uffff` : q.to);
    }
    if (q.minBytes != null) {
      where.push("i.bytes >= ?");
      args.push(q.minBytes);
    }
    if (q.maxBytes != null) {
      where.push("i.bytes <= ?");
      args.push(q.maxBytes);
    }
    if (q.ids) {
      where.push(`i.id IN (${placeholders(q.ids)})`);
      args.push(...q.ids);
    }
    const w = where.length ? `WHERE ${where.join(" AND ")}` : "";
    const order = {
      newest: "i.created DESC, i.id DESC",
      oldest: "i.created ASC, i.id ASC",
      added: "i.added_at DESC, i.id DESC",
      name: "i.name COLLATE NOCASE ASC, i.id ASC",
      size: "i.bytes DESC, i.id DESC",
      smallest: "i.bytes ASC, i.id ASC",
      cost: "i.usd DESC NULLS LAST, i.created DESC",
      views: "i.views DESC, i.viewed_at DESC NULLS LAST, i.created DESC, i.id DESC",
    }[q.sort ?? "newest"];
    const limit = Math.max(0, Math.min(q.limit ?? 200, 100_000));
    const offset = Math.max(0, q.offset ?? 0);
    // A collapsed stack is its first member that matches: the front, unless the search leaves it out.
    const open = [...new Set(q.openStacks ?? [])];
    const collapse = q.stacks !== "expand" && !q.ids;
    const key = `CASE WHEN i.stack_id IS NULL${open.length ? ` OR i.stack_id IN (${placeholders(open)})` : ""} THEN -i.id ELSE i.stack_id END`;
    const from = collapse ? `FROM images i JOIN (SELECT i.id, row_number() OVER (PARTITION BY ${key} ORDER BY i.stack_pos, i.id) rn FROM images i ${w}) hit ON hit.id = i.id AND hit.rn = 1` : `FROM images i ${w}`;
    const fargs = (collapse ? [...open, ...args] : args).map(p);
    const total = Number((this.db.prepare(`SELECT count(*) n ${from}`).get(...fargs) as Row).n);
    // The size on disk counts a closed stack's other members too: they're there, under the front's tile.
    const bytes = Number((this.db.prepare(`SELECT ifnull(sum(i.bytes), 0) b FROM images i ${w}`).get(...args.map(p)) as Row).b);
    const rows = this.db.prepare(`SELECT ${Library.COLS} ${from} ORDER BY ${order} LIMIT ? OFFSET ?`).all(...fargs, limit, offset) as Row[];
    const items = rows.map((r) => this.rowOf(r));
    return { total, bytes, items: open.length ? keepTogether(items, new Set(open)) : items };
  }

  /** An image by id, by path, or by a file: address. */
  find(ref: number | string): ImageRow | undefined {
    const r =
      typeof ref === "number" || /^\s*#?\d+\s*$/.test(ref)
        ? this.get(`SELECT ${Library.COLS} FROM images i WHERE i.id = ?`, typeof ref === "number" ? ref : Number(ref.replace(/\D/g, "")))
        : this.get(`SELECT ${Library.COLS} FROM images i WHERE i.path = ?`, normPath(ref));
    return r ? this.rowOf(r) : undefined;
  }

  async image(ref: number | string): Promise<ImageDetail> {
    const row = this.find(ref);
    if (!row) throw new LibraryError(`No image ${typeof ref === "number" ? `#${ref}` : ref} in the library.`);
    const extra = this.get("SELECT note, sidecar FROM images WHERE id = ?", row.id)!;
    const cols = this.listCollections();
    const inIds = this.all("SELECT collection_id id FROM collection_images WHERE image_id = ?", row.id).map((r) => Number(r.id));
    let sidecar = null;
    // A model's sidecar is trellis-client's own JSON; a picture's and a video's are gemini-image's shape.
    if (extra.sidecar && row.kind === "model") {
      try {
        sidecar = JSON.parse(String(extra.sidecar));
      } catch {}
    } else if (extra.sidecar) sidecar = parseSidecar(String(extra.sidecar));
    return {
      ...row,
      note: String(extra.note ?? ""),
      sidecar,
      collections: inIds.map((id) => ({ id, path: cols.find((c) => c.id === id)?.path ?? `#${id}` })).sort((a, b) => a.path.localeCompare(b.path)),
      concept: this.conceptOf(row),
      models: row.kind === "image" ? this.modelsOf(row) : [],
      companions: await this.companions(row),
      stacked: (row.stack?.ids ?? []).flatMap((id) => {
        const m = id === row.id ? row : this.find(id);
        return m ? [{ id: m.id, kind: m.kind, path: m.path, name: m.name, mtime: m.mtime, missing: m.missing, tris: m.tris, textures: m.mesh?.textures.length ?? 0, ...(m.video ? { duration: m.video.duration } : {}) }] : [];
      }),
    };
  }

  // ── Models and their concept art ───────────────────────────────────────

  /** The files that go with an item when it moves or goes to the Recycle Bin (never the item itself). */
  async companions(ref: number | ImageRow): Promise<string[]> {
    const row = typeof ref === "number" ? this.find(ref) : ref;
    if (!row) return [];
    if (row.kind === "model") return companionsOf(row.path);
    const sc = sidecarOf(row.path);
    return existsSync(sc) ? [sc] : [];
  }

  /**
   * The concept image a model came from: the one set by hand, else the one its sidecar names (by path, or
   * by file name, the nearest), else a picture that shares its name (ufo-px-textured.glb ↔ ufo.png) in
   * the same project (under the folder two above the model's).
   */
  conceptOf(ref: number | ImageRow): ConceptLink | null {
    const row = typeof ref === "number" ? this.find(ref) : ref;
    if (!row || row.kind !== "model") return null;
    const r = this.get("SELECT concept_id, concept_ref FROM images WHERE id = ?", row.id);
    const link = (c: ImageRow | undefined, how: ConceptLink["how"]): ConceptLink | null => (c ? { id: c.id, path: c.path, name: c.name, mtime: c.mtime, missing: c.missing, how } : null);
    if (r?.concept_id != null) {
      const hit = link(this.find(Number(r.concept_id)), "set");
      if (hit) return hit;
    }
    if (r?.concept_ref) {
      const hit = link(this.conceptByRef(String(r.concept_ref), row.path), "sidecar");
      if (hit) return hit;
    }
    for (const stem of conceptStems(row.name)) {
      const hit = link(this.pictureByStem(stem, row.path), "name");
      if (hit) return hit;
    }
    return null;
  }

  /** A picture by what a sidecar says: a path (absolute, or relative to the model), or a file name (the one nearest the model). */
  private conceptByRef(ref: string, near: string): ImageRow | undefined {
    if (/[\\/]/.test(ref)) {
      const p = /^([a-z]:|[\\/]{2}|\/)/i.test(ref) ? normPath(ref) : normPath(join(folderOf(near), ref));
      const hit = this.find(p);
      if (hit?.kind === "image") return hit;
      ref = nameOf(p);
    }
    const rows = this.all(`SELECT ${Library.COLS} FROM images i WHERE i.kind = 'image' AND i.name = ? COLLATE NOCASE`, ref).map((x) => this.rowOf(x));
    return nearest(rows, near);
  }

  private pictureByStem(stem: string, near: string): ImageRow | undefined {
    const root = folderOf(folderOf(folderOf(near)));
    const rows = this.all(`SELECT ${Library.COLS} FROM images i WHERE i.kind = 'image' AND i.name LIKE ? ESCAPE '\\'`, `${likeEscape(stem)}.%`)
      .map((x) => this.rowOf(x))
      .filter((x) => x.name.slice(0, x.name.length - x.ext.length - 1).toLowerCase() === stem.toLowerCase() && isUnder(x.path, root));
    return nearest(rows, near);
  }

  /** The models made from a picture (each model's own concept is this one). */
  private modelsOf(img: ImageRow): ImageDetail["models"] {
    const stem = img.name.replace(/\.[^.]+$/, "");
    const cands = this.all(
      `SELECT ${Library.COLS} FROM images i WHERE i.kind = 'model' AND i.missing = 0 AND (i.concept_id = ? OR i.concept_ref = ? COLLATE NOCASE OR i.concept_ref = ? COLLATE NOCASE OR i.concept_ref LIKE ? ESCAPE '\\' OR i.name LIKE ? ESCAPE '\\') ORDER BY i.name COLLATE NOCASE`,
      img.id,
      img.path,
      img.name,
      `%/${likeEscape(img.name)}`,
      `${likeEscape(stem)}%`,
    ).map((x) => this.rowOf(x));
    return cands.filter((m) => this.conceptOf(m)?.id === img.id).map((m) => ({ id: m.id, path: m.path, name: m.name, mtime: m.mtime, tris: m.tris }));
  }

  /** Links a model to its concept image by hand (null goes back to what its sidecar or name says). */
  setConcept(modelRef: number | string, imageRef: number | string | null): ConceptLink | null {
    const m = this.find(modelRef);
    if (!m || m.kind !== "model") throw new LibraryError(`${modelRef} isn't a 3D model in the library.`);
    let id: number | null = null;
    if (imageRef !== null && imageRef !== "") {
      const img = this.find(imageRef);
      if (!img || img.kind !== "image") throw new LibraryError(`${imageRef} isn't a picture in the library.`);
      id = img.id;
    }
    this.run("UPDATE images SET concept_id = ? WHERE id = ?", id, m.id);
    return this.conceptOf(m.id);
  }

  /** Ids for refs (ids or paths); throws naming the ones it can't find. */
  ids(refs: (number | string)[]): number[] {
    const out: number[] = [];
    const bad: string[] = [];
    for (const r of refs) {
      const hit = this.find(r);
      if (hit) out.push(hit.id);
      else bad.push(String(r));
    }
    if (bad.length) throw new LibraryError(`Not in the library: ${bad.join(", ")}`);
    return [...new Set(out)];
  }

  /** Counts a look at items (the Gallery page opening one large, once it's been up a moment). Gives back their counts now. */
  markViewed(ids: number[]): { id: number; views: number }[] {
    const uniq = [...new Set(ids)];
    if (!uniq.length) return [];
    this.tx(() => uniq.forEach((id) => this.run(`UPDATE images SET views = views + 1, viewed_at = ${NOW} WHERE id = ?`, id)));
    return (this.db.prepare(`SELECT id, views FROM images WHERE id IN (${placeholders(uniq)})`).all(...uniq) as Row[]).map((r) => ({ id: Number(r.id), views: Number(r.views) }));
  }

  setNote(id: number, note: string) {
    if (!this.find(id)) throw new LibraryError(`No image #${id}.`);
    this.run("UPDATE images SET note = ? WHERE id = ?", note, id);
  }

  /**
   * Reads one file into the library, or refreshes it when the file or its sidecar changed. A file that
   * turns up where a missing one of the same size and time was (renamed or moved outside Gallery)
   * takes over that row, so its tags and collections come with it. A video's facts come from ffprobe
   * (read again only when the file changes); a picture's size from its header.
   */
  async upsertFile(path: string, st?: Stats): Promise<{ id: number; isNew: boolean; changed: boolean }> {
    const fp = normPath(path);
    st ??= await stat(fp);
    if (isModel(fp) || /\.json$/i.test(fp)) return this.upsertModel(fp, st);
    const mtime = Math.round(st.mtimeMs);
    const bytes = st.size;
    const scPath = sidecarOf(fp);
    let scMtime = 0;
    try {
      scMtime = Math.round(statSync(scPath).mtimeMs);
    } catch {}
    const kind: ItemKind = isVideo(fp) ? "video" : "image";
    let row = this.get("SELECT id, mtime, bytes, width, height, sidecar_mtime, missing, video FROM images WHERE path = ?", fp);
    let relinked = false;
    if (!row) {
      const twin = this.all("SELECT id, path, mtime, bytes, width, height, sidecar_mtime, missing, video FROM images WHERE bytes = ? AND mtime = ? AND kind = ?", bytes, mtime, kind).find((r) => !existsSync(String(r.path)));
      if (twin) {
        row = twin;
        relinked = true;
      }
    }
    const same = row && Number(row.mtime) === mtime && Number(row.bytes) === bytes;
    if (row && same && Number(row.sidecar_mtime) === scMtime && Number(row.missing) === 0 && !relinked) return { id: Number(row.id), isNew: false, changed: false };
    let video: VideoInfo | null = null;
    let size: { width: number | null; height: number | null } | undefined;
    if (kind === "video") {
      if (same && row!.video) {
        try {
          video = JSON.parse(String(row!.video));
        } catch {}
      }
      video ??= await videoInfo(fp);
      size = { width: video.width, height: video.height };
    } else size = same && row!.width != null ? { width: Number(row!.width), height: Number(row!.height) } : await imageSize(fp).catch(() => undefined);
    const sc: Sidecar | null = scMtime ? await readSidecar(scPath) : null;
    const created = sc?.at && !Number.isNaN(Date.parse(sc.at)) ? new Date(sc.at).toISOString() : new Date(mtime).toISOString();
    const vals = [fp, nameOf(fp), folderOf(fp), extOf(fp), bytes, size?.width ?? null, size?.height ?? null, mtime, created, sc?.prompt ?? null, sc?.model ?? null, sc?.usd ?? null, sc ? JSON.stringify(sc) : null, scMtime, video ? JSON.stringify(video) : null, kind];
    if (row) {
      this.run(
        "UPDATE images SET path = ?, name = ?, folder = ?, ext = ?, bytes = ?, width = ?, height = ?, mtime = ?, created = ?, prompt = ?, model = ?, usd = ?, sidecar = ?, sidecar_mtime = ?, video = ?, kind = ?, missing = 0 WHERE id = ?",
        ...vals,
        row.id,
      );
      return { id: Number(row.id), isNew: false, changed: true };
    }
    const id = Number(
      this.run("INSERT INTO images (path, name, folder, ext, bytes, width, height, mtime, created, prompt, model, usd, sidecar, sidecar_mtime, video, kind) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)", ...vals).lastInsertRowid,
    );
    return { id, isNew: true, changed: true };
  }

  /**
   * A 3D model's side of upsertFile: what's in it (triangles, textures, parts), its sidecar (made, model,
   * the concept it came from) and, when that names a concept image not in the library yet, that image,
   * found under the model's project. A set is its <name>.json; its parts are read through it.
   */
  private async upsertModel(fp: string, st: Stats): Promise<{ id: number; isNew: boolean; changed: boolean }> {
    const mtime = Math.round(st.mtimeMs);
    const bytes = st.size;
    const meta = await readModelMeta(fp);
    let row = this.get("SELECT id, mtime, bytes, sidecar_mtime, missing, mesh FROM images WHERE path = ?", fp);
    let relinked = false;
    if (!row) {
      const twin = this.all("SELECT id, path, mtime, bytes, sidecar_mtime, missing, mesh FROM images WHERE kind = 'model' AND bytes = ? AND mtime = ?", bytes, mtime).find((r) => !existsSync(String(r.path)));
      if (twin) ((row = twin), (relinked = true));
    }
    // A set's parts can change under the same sidecar: they count toward its "sidecar" time.
    let scMtime = meta.mtime;
    const set = /\.json$/i.test(fp) ? await readSet(fp) : undefined;
    if (set) for (const f of set.parts) scMtime = Math.max(scMtime, mtimeOf(join(folderOf(fp), f)));
    const same = row && Number(row.mtime) === mtime && Number(row.bytes) === bytes;
    if (row && same && Number(row.sidecar_mtime) === scMtime && Number(row.missing) === 0 && !relinked) return { id: Number(row.id), isNew: false, changed: false };
    let mesh: MeshInfo | null = null;
    if (same && row!.mesh && !set) {
      try {
        mesh = JSON.parse(String(row!.mesh));
      } catch {}
    }
    mesh ??= await meshInfo(fp);
    if (meta.conceptRef && !/[\\/]/.test(meta.conceptRef) && !this.conceptByRef(meta.conceptRef, fp)) await this.fetchConcept(meta.conceptRef, fp);
    else if (meta.conceptRef && /[\\/]/.test(meta.conceptRef) && !this.conceptByRef(meta.conceptRef, fp)) {
      const p = normPath(/^([a-z]:|[\\/])/i.test(meta.conceptRef) ? meta.conceptRef : join(folderOf(fp), meta.conceptRef));
      if (existsSync(p) && isImage(p)) await this.upsertFile(p).catch(() => {});
    }
    const created = meta.made ? new Date(meta.made).toISOString() : new Date(mtime).toISOString();
    const vals = [fp, nameOf(fp), folderOf(fp), extOf(fp), bytes, mtime, created, meta.prompt ?? null, meta.model ?? null, meta.usd ?? null, meta.meta ? JSON.stringify(meta.meta) : null, scMtime, JSON.stringify(mesh), mesh.triangles, meta.conceptRef ?? null];
    const cols = "path = ?, name = ?, folder = ?, ext = ?, bytes = ?, mtime = ?, created = ?, prompt = ?, model = ?, usd = ?, sidecar = ?, sidecar_mtime = ?, mesh = ?, tris = ?, concept_ref = ?";
    if (row) {
      this.run(`UPDATE images SET ${cols}, width = NULL, height = NULL, kind = 'model', missing = 0 WHERE id = ?`, ...vals, row.id);
      return { id: Number(row.id), isNew: false, changed: true };
    }
    const id = Number(
      this.run("INSERT INTO images (path, name, folder, ext, bytes, mtime, created, prompt, model, usd, sidecar, sidecar_mtime, mesh, tris, concept_ref, kind) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'model')", ...vals).lastInsertRowid,
    );
    this.stackVariants([id]);
    return { id, isNew: true, changed: true };
  }

  /**
   * A concept image a model's sidecar names by file name only, not in the library yet: looked for under the
   * model's project (up to three folders above it, in folders whose path says "concept") and added.
   */
  private async fetchConcept(name: string, modelPath: string): Promise<void> {
    let dir = folderOf(modelPath);
    for (let up = 0; up < 3; up++) {
      const parent = folderOf(dir);
      if (parent === dir) break;
      dir = parent;
      const hit = await findFile(dir, name, (d) => /concept/i.test(d.slice(dir.length)), 4000);
      if (hit) {
        await this.upsertFile(hit).catch(() => {});
        return;
      }
    }
  }

  /** Adds files and folders (folders recursively) to the library, optionally filing and tagging them: pictures, 3D models and videos. */
  async addPaths(paths: string[], o: { collectionId?: number | null; tags?: string[]; recursive?: boolean } = {}): Promise<AddResult> {
    if (o.collectionId != null) this.collection(o.collectionId);
    const res: AddResult = { added: [], existing: [], skipped: [] };
    for (const raw of paths) {
      const fp = normPath(raw);
      let st: Stats;
      try {
        st = await stat(fp);
      } catch {
        res.skipped.push(`${fp} (not found)`);
        continue;
      }
      const set = !st.isDirectory() && /\.json$/i.test(fp) ? await readSet(fp) : undefined;
      const one = isImage(fp) || isModel(fp) || isVideo(fp) || !!set;
      const files = st.isDirectory() ? await walk(fp, o.recursive !== false) : one ? [set && meshBeside(fp) ? meshBeside(fp)! : fp] : [];
      if (!st.isDirectory() && !one) res.skipped.push(`${fp} (not a picture, a video or a 3D model)`);
      for (const f of files) {
        try {
          const r = await this.upsertFile(f);
          (r.isNew ? res.added : res.existing).push(r.id);
        } catch (e) {
          res.skipped.push(`${f} (${(e as Error).message})`);
        }
      }
    }
    const all = [...res.added, ...res.existing];
    if (o.collectionId != null) this.fileImages(all, o.collectionId, "add");
    if (o.tags?.length) this.tagImages(all, o.tags, []);
    return res;
  }

  /** Takes images out of the library. Their files stay where they are. */
  removeImages(ids: number[]): { removed: number } {
    if (!ids.length) return { removed: 0 };
    return { removed: Number(this.db.prepare(`DELETE FROM images WHERE id IN (${placeholders(ids)})`).run(...ids).changes) };
  }

  /** Moves image files (and their sidecars) into a folder on disk and updates the library to match. */
  async moveFiles(ids: number[], folder: string): Promise<MoveResult> {
    const dest = normPath(folder);
    await mkdir(dest, { recursive: true });
    const res: MoveResult = { moved: [], failed: [] };
    for (const id of ids) {
      const img = this.find(id);
      if (!img) {
        res.failed.push({ id, error: "not in the library" });
        continue;
      }
      if (img.folder.toLowerCase() === dest.toLowerCase()) continue;
      try {
        const going = await this.companions(img);
        const to = freeName(dest, img.name);
        await moveFile(img.path, to);
        // Its companions follow: one named after it takes its new name (a.json → a (2).json), the rest
        // (a set's parts, textures) keep theirs, and one whose name is taken there stays where it was.
        const oldStem = img.name.replace(/\.[^.]+$/, "").toLowerCase();
        const newStem = nameOf(to).replace(/\.[^.]+$/, "");
        for (const c of going) {
          const n = nameOf(c);
          const mine = n.toLowerCase().startsWith(oldStem + ".") || n.toLowerCase().startsWith(oldStem + "-");
          const target = normPath(join(dest, mine ? newStem + n.slice(oldStem.length) : n));
          if (existsSync(target)) {
            (res.warnings ??= []).push(`${n} stayed in ${folderOf(c)}: ${nameOf(target)} is already in ${dest}.`);
            continue;
          }
          await moveFile(c, target).catch((e: Error) => (res.warnings ??= []).push(`${n}: ${e.message}`));
        }
        this.run("UPDATE images SET path = ?, name = ?, folder = ?, missing = 0 WHERE id = ?", to, nameOf(to), folderOf(to), id);
        res.moved.push({ id, from: img.path, to });
      } catch (e) {
        res.failed.push({ id, error: (e as Error).message });
      }
    }
    return res;
  }

  /** Renames an image's file (and its sidecar). The extension stays unless the new name gives one. */
  async renameImage(id: number, newName: string): Promise<ImageRow> {
    const img = this.find(id);
    if (!img) throw new LibraryError(`No image #${id}.`);
    let name = newName.trim();
    if (!name || BAD_NAME.test(name) || name === "." || name === "..") throw new LibraryError(`"${newName}" can't be a file name.`);
    if (img.kind === "model" && img.ext === "json") throw new LibraryError(`${img.name} is a set: its parts are named after it. Rename it where it's made (Blender), then scan.`);
    if (img.kind === "model") return this.renameModel(img, isModel(name) ? name : `${name}.${img.ext}`);
    if (!(img.kind === "video" ? isVideo(name) : isImage(name))) name += "." + img.ext;
    const to = normPath(join(img.folder, name));
    if (to === img.path) return img;
    if (to.toLowerCase() !== img.path.toLowerCase() && existsSync(to)) throw new LibraryError(`${name} already exists in ${img.folder}.`);
    await rename(img.path, to);
    const sc = sidecarOf(img.path);
    if (existsSync(sc) && sidecarOf(to) !== sc) await rename(sc, sidecarOf(to)).catch(() => {});
    this.run("UPDATE images SET path = ?, name = ?, ext = ? WHERE id = ?", to, nameOf(to), extOf(to), id);
    return this.find(id)!;
  }

  /** A model's rename: the file and its sidecars named after it (a.json, a.meta.json, a-prompt.json); its parts keep their names (the sidecar lists them). */
  private async renameModel(img: ImageRow, name: string): Promise<ImageRow> {
    const to = normPath(join(img.folder, name));
    if (to === img.path) return img;
    if (to.toLowerCase() !== img.path.toLowerCase() && existsSync(to)) throw new LibraryError(`${name} already exists in ${img.folder}.`);
    const oldStem = img.name.replace(/\.[^.]+$/, "");
    const newStem = name.replace(/\.[^.]+$/, "");
    const named = [".json", ".meta.json", "-prompt.json"].map((x) => [join(img.folder, oldStem + x), join(img.folder, newStem + x)]).filter(([a, b]) => existsSync(a) && !existsSync(b));
    await rename(img.path, to);
    for (const [a, b] of named) await rename(a, b).catch(() => {});
    this.run("UPDATE images SET path = ?, name = ?, ext = ? WHERE id = ?", to, nameOf(to), extOf(to), img.id);
    return this.find(img.id)!;
  }

  markMissing(path: string): boolean {
    return Number(this.run("UPDATE images SET missing = 1 WHERE path = ? AND missing = 0", normPath(path)).changes) > 0;
  }

  /** Forgets every image whose file is gone. */
  purgeMissing(): { removed: number } {
    return { removed: Number(this.run("DELETE FROM images WHERE missing = 1").changes) };
  }

  /**
   * A change on disk under a watched folder (from fs.watch): an image, video or model appeared, changed or
   * went, or a sidecar was written. New items are filed into the watch's collection. True when the library changed.
   */
  async onDiskChange(path: string): Promise<boolean> {
    const fp = normPath(path);
    if (/\.json$/i.test(fp)) return this.onJsonChange(fp);
    if (!(isImage(fp) || isModel(fp) || isVideo(fp)) || /\.part$/i.test(fp)) return false;
    let st: Stats | undefined;
    try {
      st = await stat(fp);
    } catch {}
    if (!st || !st.isFile()) return this.markMissing(fp);
    // A set's part changed: the set (its .glb, or its sidecar) reads it again; the part is no item of its own.
    if (isModel(fp) && (await isPart(fp))) return this.refreshSetsOf(fp);
    const r = await this.upsertFile(fp, st);
    if (r.isNew) this.fileNew(r.id, fp);
    return r.changed;
  }

  /** A new item under a watched folder goes into the watch's collection. */
  private fileNew(id: number, path: string) {
    const w = this.watchFor(path);
    if (w?.collectionId != null) this.fileImages([id], w.collectionId, "add");
  }

  /**
   * A .json written or changed: a picture's gemini-image sidecar, a model's <name>.meta.json or stats, or
   * a set's sidecar. A set's parts stop being items of their own (taken out of the library; their files
   * stay), and the set comes in as one model: its .glb, or the sidecar itself.
   */
  private async onJsonChange(fp: string): Promise<boolean> {
    let changed = false;
    const refresh = async (p: string) => (changed = (await this.upsertFile(p).catch(() => ({ changed: false }))).changed || changed);
    const stem = fp.replace(/(\.meta)?\.json$/i, "");
    // Items whose sidecar this is: a picture's or a video's <name>.json, a model named after it (or a variant: brick-px-textured.glb).
    const hits = this.all("SELECT path, kind FROM images WHERE folder = ? AND path LIKE ? ESCAPE '\\' AND missing = 0", folderOf(fp), `${likeEscape(stem)}%`)
      .map((r) => ({ path: String(r.path), kind: String(r.kind) as ItemKind }))
      .filter((x) =>
        x.kind !== "model"
          ? sidecarOf(x.path).toLowerCase() === fp.toLowerCase()
          : x.path.toLowerCase() !== fp.toLowerCase() && sidecarStems(nameOf(x.path)).some((st) => `${folderOf(x.path)}/${st}`.toLowerCase() === stem.toLowerCase()),
      );
    for (const h of hits) await refresh(h.path);
    const set = /\.meta\.json$/i.test(fp) ? undefined : await readSet(fp);
    if (set) {
      const partPaths = set.parts.map((f) => normPath(join(folderOf(fp), f)));
      const gone = this.all(`SELECT id FROM images WHERE path IN (${placeholders(partPaths)})`, ...partPaths).map((r) => Number(r.id));
      if (gone.length) {
        changed = true;
        this.removeImages(gone);
      }
      const item = meshBeside(fp) ?? fp;
      const known = this.find(item);
      const r = await this.upsertFile(item).catch(() => undefined);
      if (r) {
        changed ||= r.changed;
        if (r.isNew && !known) this.fileNew(r.id, item);
      }
    } else if (existsSync(fp) && this.find(fp)?.kind === "model") await refresh(fp);
    return changed;
  }

  /** A part changed: every set whose sidecar names it reads again. */
  private async refreshSetsOf(part: string): Promise<boolean> {
    const dir = folderOf(part);
    const stem = nameOf(part).replace(/\.[^.]+$/, "");
    let changed = false;
    for (let i = stem.length - 1; i > 0; i--) {
      if (stem[i] !== "_" && stem[i] !== "-") continue;
      const json = `${dir}/${stem.slice(0, i)}.json`;
      if (!existsSync(json)) continue;
      const item = meshBeside(json) ?? json;
      if (this.find(item)) changed = (await this.upsertFile(item).catch(() => ({ changed: false }))).changed || changed;
    }
    return changed;
  }

  // ── Tags ───────────────────────────────────────────────────────────────

  listTags(): TagInfo[] {
    return this.all("SELECT t.id, t.name, count(i.id) n FROM tags t LEFT JOIN image_tags it ON it.tag_id = t.id LEFT JOIN images i ON i.id = it.image_id AND i.missing = 0 GROUP BY t.id ORDER BY t.name COLLATE NOCASE").map((r) => ({
      id: Number(r.id),
      name: String(r.name),
      count: Number(r.n),
    }));
  }

  tagImages(ids: number[], add: string[] = [], remove: string[] = []): { added: number; removed: number } {
    const clean = (xs: string[]) => [...new Set(xs.map((t) => t.trim().replace(/\s+/g, " ")).filter(Boolean))];
    const a = clean(add);
    const r = clean(remove);
    if (!ids.length) return { added: 0, removed: 0 };
    return this.tx(() => {
      let added = 0;
      let removed = 0;
      for (const name of a) {
        this.run("INSERT OR IGNORE INTO tags (name) VALUES (?)", name);
        const tid = Number(this.get("SELECT id FROM tags WHERE name = ?", name)!.id);
        for (const id of ids) added += Number(this.run("INSERT OR IGNORE INTO image_tags (image_id, tag_id) SELECT id, ? FROM images WHERE id = ?", tid, id).changes);
      }
      for (const name of r) {
        removed += Number(this.db.prepare(`DELETE FROM image_tags WHERE tag_id = (SELECT id FROM tags WHERE name = ?) AND image_id IN (${placeholders(ids)})`).run(name, ...ids).changes);
      }
      if (r.length) this.pruneTags();
      return { added, removed };
    });
  }

  /** Sets an image's tags to exactly these. */
  setTags(id: number, tags: string[]) {
    const row = this.find(id);
    if (!row) throw new LibraryError(`No image #${id}.`);
    const now = row.tags;
    const lower = new Set(tags.map((t) => t.toLowerCase()));
    this.tagImages([id], tags.filter((t) => !now.some((n) => n.toLowerCase() === t.toLowerCase())), now.filter((n) => !lower.has(n.toLowerCase())));
  }

  renameTag(from: string, to: string): { merged: boolean } {
    const name = to.trim();
    if (!name) throw new LibraryError("A tag needs a name.");
    const src = this.get("SELECT id FROM tags WHERE name = ?", from);
    if (!src) throw new LibraryError(`No tag "${from}".`);
    const dst = this.get("SELECT id FROM tags WHERE name = ?", name);
    if (dst && Number(dst.id) !== Number(src.id)) {
      this.tx(() => {
        this.run("INSERT OR IGNORE INTO image_tags (image_id, tag_id, at) SELECT image_id, ?, at FROM image_tags WHERE tag_id = ?", dst.id, src.id);
        this.run("DELETE FROM tags WHERE id = ?", src.id);
      });
      return { merged: true };
    }
    this.run("UPDATE tags SET name = ? WHERE id = ?", name, src.id);
    return { merged: false };
  }

  deleteTag(name: string): { removed: number } {
    const t = this.get("SELECT id FROM tags WHERE name = ?", name);
    if (!t) throw new LibraryError(`No tag "${name}".`);
    const n = Number(this.get("SELECT count(*) n FROM image_tags WHERE tag_id = ?", t.id)!.n);
    this.run("DELETE FROM tags WHERE id = ?", t.id);
    return { removed: n };
  }

  private pruneTags() {
    this.run("DELETE FROM tags WHERE name <> ? AND NOT EXISTS (SELECT 1 FROM image_tags it WHERE it.tag_id = tags.id)", PICKED);
  }

  // ── Stacks ─────────────────────────────────────────────────────────────

  /** A stack's members in order, the front first. */
  stackItems(id: number): ImageRow[] {
    return this.all(`SELECT ${Library.COLS} FROM images i WHERE i.stack_id = ? ORDER BY i.stack_pos, i.id`, id).map((r) => this.rowOf(r));
  }

  /**
   * Stacks items together: versions of one thing shown as one tile. Stacks they're already in join the
   * new one. The front is `frontId`, else the front of the first one already stacked, else the first one.
   */
  stackImages(ids: number[], frontId?: number): ImageRow[] {
    const rows = this.ids(frontId == null ? ids : [...ids, frontId]).map((id) => this.find(id)!);
    const inStack = rows.filter((r) => r.stack);
    const order = [...new Set([frontId ?? inStack[0]?.stack!.ids[0] ?? rows[0]?.id, ...rows.map((r) => r.id), ...inStack.flatMap((r) => r.stack!.ids)])].filter((x): x is number => x != null);
    if (order.length < 2) throw new LibraryError("A stack needs two or more items.");
    const sid = inStack[0]?.stack!.id ?? Number(this.get("SELECT coalesce(max(stack_id), 0) + 1 n FROM images")!.n);
    this.tx(() => order.forEach((id, pos) => this.run("UPDATE images SET stack_id = ?, stack_pos = ?, stack_apart = 0 WHERE id = ?", sid, pos, id)));
    return this.stackItems(sid);
  }

  /**
   * Takes items out of their stacks (`whole`: breaks up every stack they're in). A stack left with one item is
   * no stack. What's taken out stays apart: the textured/untextured pairing doesn't stack it again.
   */
  unstackImages(ids: number[], whole = false): { unstacked: number } {
    const rows = this.ids(ids).map((id) => this.find(id)!);
    const sids = [...new Set(rows.flatMap((r) => (r.stack ? [r.stack.id] : [])))];
    if (!sids.length) return { unstacked: 0 };
    return this.tx(() => {
      let n = whole
        ? Number(this.db.prepare(`UPDATE images SET stack_id = NULL, stack_pos = 0, stack_apart = 1 WHERE stack_id IN (${placeholders(sids)})`).run(...sids).changes)
        : Number(this.db.prepare(`UPDATE images SET stack_id = NULL, stack_pos = 0, stack_apart = 1 WHERE stack_id IS NOT NULL AND id IN (${placeholders(rows.map((r) => r.id))})`).run(...rows.map((r) => r.id)).changes);
      for (const sid of sids) {
        const left = this.all("SELECT id FROM images WHERE stack_id = ? ORDER BY stack_pos, id", sid).map((r) => Number(r.id));
        if (left.length === 1) n += Number(this.run("UPDATE images SET stack_id = NULL, stack_pos = 0 WHERE id = ?", left[0]).changes);
        else left.forEach((id, pos) => this.run("UPDATE images SET stack_pos = ? WHERE id = ?", pos, id));
      }
      return { unstacked: n };
    });
  }

  /** Makes an item the front of its stack (the tile the stack shows). */
  setStackFront(id: number): ImageRow[] {
    const row = this.find(id);
    if (!row) throw new LibraryError(`No image #${id}.`);
    if (!row.stack) throw new LibraryError(`${row.name} is in no stack.`);
    const sid = row.stack.id;
    this.tx(() => [id, ...row.stack!.ids.filter((x) => x !== id)].forEach((m, pos) => this.run("UPDATE images SET stack_pos = ? WHERE id = ?", pos, m)));
    return this.stackItems(sid);
  }

  /**
   * Stacks each textured model with its untextured twin (brick-textured.glb with brick.glb, in one folder),
   * the textured one in front. Only models in no stack that weren't taken out of one by hand; with `onlyIds`,
   * only pairs that include one of them. New models do this as they come in, and the whole library on opening
   * and after each scan (twins an older copy of the package let in). Gives back how many stacks it made.
   */
  stackVariants(onlyIds?: number[]): number {
    if (onlyIds && !onlyIds.length) return 0;
    const rows = this.all("SELECT id, name, folder, ext FROM images WHERE kind = 'model' AND stack_id IS NULL AND stack_apart = 0 AND missing = 0");
    const keyOf = (folder: unknown, stem: string, ext: unknown) => `${String(folder)}|${stem}|${String(ext)}`.toLowerCase();
    const plain = new Map(rows.map((r) => [keyOf(r.folder, String(r.name).replace(/\.[^.]+$/, ""), r.ext), Number(r.id)]));
    const only = onlyIds && new Set(onlyIds);
    let made = 0;
    for (const r of rows) {
      const base = /^(.+)[-_]textured$/i.exec(String(r.name).replace(/\.[^.]+$/, ""))?.[1];
      const twin = base && plain.get(keyOf(r.folder, base, r.ext));
      if (!twin || (only && !only.has(Number(r.id)) && !only.has(twin))) continue;
      this.stackImages([Number(r.id), twin]);
      made++;
    }
    return made;
  }

  // ── Picks ──────────────────────────────────────────────────────────────

  /**
   * Records a pick as a tag (default the star, "starred"). Takes an id, a path, or the Benhäus panel's own
   * "Picked 2 of 4: <alt> (<path>)" text. A picked file that isn't in the library yet is added.
   */
  async pick(o: { id?: number; path?: string; text?: string; tag?: string; unpick?: boolean }): Promise<ImageDetail> {
    let ref: number | string | undefined = o.id ?? o.path;
    if (ref === undefined && o.text) {
      const pk = parsePick(o.text);
      if (!pk) throw new LibraryError(`"${o.text}" isn't a pick ("Picked N of M: … (path)").`);
      ref = pk.ref ?? pk.id;
      if (ref === undefined) throw new LibraryError(`"${o.text}" doesn't name an image (no path or #id).`);
    }
    if (ref === undefined) throw new LibraryError("Say which image: id, path or the pick's text.");
    let img = this.find(ref);
    if (!img && typeof ref === "string" && !/^\s*#?\d+\s*$/.test(ref)) {
      const fp = normPath(ref);
      if (!existsSync(fp)) throw new LibraryError(`${fp} isn't there.`);
      await this.upsertFile(fp);
      img = this.find(fp);
    }
    if (!img) throw new LibraryError(`No image ${ref} in the library.`);
    const tag = o.tag?.trim() || STARRED;
    if (o.unpick) this.tagImages([img.id], [], [tag]);
    else this.tagImages([img.id], [tag], []);
    return this.image(img.id);
  }

  // ── Watched folders ────────────────────────────────────────────────────

  listWatches(): WatchInfo[] {
    const cols = this.listCollections();
    return this.all("SELECT id, folder, collection_id, recursive, enabled, last_scan FROM watches ORDER BY folder COLLATE NOCASE").map((r) => ({
      id: Number(r.id),
      folder: String(r.folder),
      collectionId: num(r.collection_id),
      collectionPath: r.collection_id == null ? null : (cols.find((c) => c.id === Number(r.collection_id))?.path ?? null),
      recursive: Number(r.recursive) === 1,
      enabled: Number(r.enabled) === 1,
      lastScan: (r.last_scan as string | null) ?? null,
      exists: existsSync(String(r.folder)),
    }));
  }

  watch(id: number): WatchInfo {
    const w = this.listWatches().find((x) => x.id === id);
    if (!w) throw new LibraryError(`No watched folder #${id}.`);
    return w;
  }

  /** The enabled watch that covers a path (the deepest, if they nest). */
  watchFor(path: string): WatchInfo | undefined {
    const fp = normPath(path);
    return this.listWatches()
      .filter((w) => w.enabled && isUnder(fp, w.folder) && (w.recursive || folderOf(fp).toLowerCase() === w.folder.toLowerCase()))
      .sort((a, b) => b.folder.length - a.folder.length)[0];
  }

  addWatch(o: { folder: string; collectionId?: number | null; recursive?: boolean }): WatchInfo {
    const folder = normPath(o.folder);
    if (o.collectionId != null) this.collection(o.collectionId);
    try {
      const id = Number(this.run("INSERT INTO watches (folder, collection_id, recursive) VALUES (?, ?, ?)", folder, o.collectionId ?? null, o.recursive !== false).lastInsertRowid);
      return this.watch(id);
    } catch (e) {
      if (/UNIQUE/i.test(String(e))) throw new LibraryError(`${folder} is already watched.`);
      throw e;
    }
  }

  updateWatch(id: number, o: { collectionId?: number | null; recursive?: boolean; enabled?: boolean }): WatchInfo {
    const w = this.watch(id);
    if (o.collectionId != null) this.collection(o.collectionId);
    this.run(
      "UPDATE watches SET collection_id = ?, recursive = ?, enabled = ? WHERE id = ?",
      o.collectionId === undefined ? w.collectionId : o.collectionId,
      o.recursive ?? w.recursive,
      o.enabled ?? w.enabled,
      id,
    );
    return this.watch(id);
  }

  removeWatch(id: number) {
    this.watch(id);
    this.run("DELETE FROM watches WHERE id = ?", id);
  }

  /** Reads a watched folder: new images come in (filed into its collection), changed ones refresh, gone ones are marked missing. */
  async scanWatch(id: number): Promise<ScanResult> {
    const w = this.watch(id);
    const res: ScanResult = { seen: 0, added: 0, updated: 0, missing: 0, errors: [] };
    if (!w.exists) {
      res.errors.push(`${w.folder} isn't there (yet).`);
      return res;
    }
    const files = await walk(w.folder, w.recursive);
    const seen = new Set<string>();
    const fresh: number[] = [];
    for (const f of files) {
      seen.add(f.toLowerCase());
      res.seen++;
      try {
        const r = await this.upsertFile(f);
        if (r.isNew) {
          res.added++;
          fresh.push(r.id);
        } else if (r.changed) res.updated++;
      } catch (e) {
        res.errors.push(`${f}: ${(e as Error).message}`);
      }
    }
    if (w.collectionId != null && fresh.length) this.fileImages(fresh, w.collectionId, "add");
    const under = this.all("SELECT id, path, kind FROM images WHERE missing = 0 AND path LIKE ? ESCAPE '\\'", `${likeEscape(w.folder)}/%`);
    const partCache = new Map<string, string[] | null>();
    const parts: number[] = [];
    for (const r of under) {
      const path = String(r.path);
      if (!w.recursive && folderOf(path).toLowerCase() !== w.folder.toLowerCase()) continue;
      if (!seen.has(path.toLowerCase()) && !existsSync(path)) {
        this.run("UPDATE images SET missing = 1 WHERE id = ?", r.id);
        res.missing++;
      } else if (!seen.has(path.toLowerCase()) && r.kind === "model" && (await isPart(path, partCache))) parts.push(Number(r.id));
    }
    // Parts that came in on their own before their set's sidecar was written: the set speaks for them now.
    if (parts.length) {
      this.removeImages(parts);
      res.updated += parts.length;
    }
    this.stackVariants();
    this.run(`UPDATE watches SET last_scan = ${NOW} WHERE id = ?`, id);
    return res;
  }

  async scanAll(): Promise<ScanResult> {
    const total: ScanResult = { seen: 0, added: 0, updated: 0, missing: 0, errors: [] };
    for (const w of this.listWatches().filter((x) => x.enabled)) {
      const r = await this.scanWatch(w.id);
      total.seen += r.seen;
      total.added += r.added;
      total.updated += r.updated;
      total.missing += r.missing;
      total.errors.push(...r.errors);
    }
    return total;
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────

interface Term {
  neg: boolean;
  field?: "tag" | "model" | "is" | "in" | "ext" | "size";
  value: string;
}

/** `is:` words for a kind of item. */
const KIND_WORDS: Record<string, ItemKind | undefined> = { image: "image", images: "image", picture: "image", pictures: "image", model: "model", models: "model", "3d": "model", video: "video", videos: "video" };

/** Search words: plain, "quoted phrases", -negated, and tag: model: is: in: ext: size: fields. */
export function terms(text: string): Term[] {
  const out: Term[] = [];
  for (const m of text.matchAll(/(-)?(?:(tag|model|is|in|ext|size):)?(?:"([^"]*)"|(\S+))/gi)) {
    const value = (m[3] ?? m[4] ?? "").trim();
    if (!value) continue;
    out.push({ neg: !!m[1], field: m[2]?.toLowerCase() as Term["field"], value });
  }
  return out;
}

const UNITS: Record<string, number> = { b: 1, k: 1024, m: 1024 ** 2, g: 1024 ** 3, t: 1024 ** 4 };

/** "500mb", "1.5 GB", "200k" → bytes (1024s, as Windows counts them; a bare number is megabytes). */
export function parseBytes(text: string): number | undefined {
  const m = /^\s*(\d+(?:\.\d+)?)\s*([bkmgt]?)i?b?\s*$/i.exec(text);
  return m ? Math.round(Number(m[1]) * UNITS[(m[2] || "m").toLowerCase()]) : undefined;
}

/** A size: term's value, ">100mb", "<=2gb", "5mb" (at least), as a comparison on i.bytes. */
function sizeTerm(value: string): { op: string; bytes: number } | undefined {
  const m = /^(>=|<=|>|<)?(.+)$/.exec(value.trim());
  const bytes = m ? parseBytes(m[2]) : undefined;
  return bytes === undefined ? undefined : { op: m![1] ?? ">=", bytes };
}

/** 5_860_000_000 → "5.46 GB". */
export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const i = Math.min(4, Math.floor(Math.log(n) / Math.log(1024)));
  const v = n / 1024 ** i;
  return `${v >= 100 ? Math.round(v) : v.toFixed(v >= 10 ? 1 : 2)} ${["B", "KB", "MB", "GB", "TB"][i]}`;
}

/** "Picked 2 of 4: #12 front-v2 (D:/…/front-v2.png)" → its parts. */
export function parsePick(text: string): { at?: number; of?: number; alt?: string; ref?: string; id?: number } | undefined {
  const t = text.trim();
  const head = /^picked\s+#?(\d+)(?:\s+of\s+(\d+))?/i.exec(t);
  const tail = /\(([^()]+)\)\s*$/.exec(t);
  if (!head && !tail) return undefined;
  const ref = tail?.[1].trim();
  const colon = t.indexOf(":");
  const altEnd = tail ? tail.index : t.length;
  const alt = colon >= 0 && colon < altEnd ? t.slice(colon + 1, altEnd).trim() : undefined;
  const idm = alt ? /#(\d+)/.exec(alt) : undefined;
  return { at: head ? Number(head[1]) : undefined, of: head?.[2] ? Number(head[2]) : undefined, alt: alt || undefined, ref: ref && /[/\\:]/.test(ref) ? ref : undefined, id: idm ? Number(idm[1]) : undefined };
}

/** The panel's carousel: one markdown image per line, alt "#<id> <name>", so a pick names its image both ways. */
export function markdownImages(rows: ImageRow[]): string {
  return rows
    .map((r) => {
      const stem = r.name.replace(/\.[^.]+$/, "");
      const alt = `#${r.id} ${stem}${r.tags.some((t) => t.toLowerCase() === STARRED) ? " · starred" : ""}`.replace(/[[\]\n\r]/g, " ");
      return `![${alt}](${markdownSrc(r.path)})`;
    })
    .join("\n");
}

/** The old "picked" tag, wherever it's still being added, folds into the star. */
function foldOldStar(db: DatabaseSync) {
  const old = db.prepare("SELECT id FROM tags WHERE name = ? COLLATE NOCASE").get(OLD_STAR) as Row | undefined;
  if (!old) return;
  transaction(db, () => {
    db.prepare("INSERT OR IGNORE INTO tags (name) VALUES (?)").run(STARRED);
    const star = db.prepare("SELECT id FROM tags WHERE name = ?").get(STARRED) as Row;
    db.prepare("INSERT OR IGNORE INTO image_tags (image_id, tag_id, at) SELECT image_id, ?, at FROM image_tags WHERE tag_id = ?").run(Number(star.id), Number(old.id));
    db.prepare("DELETE FROM tags WHERE id = ?").run(Number(old.id));
  });
}

/** An open stack's members side by side, in stack order, where the first of them falls in the results. */
function keepTogether(items: ImageRow[], open: Set<number>): ImageRow[] {
  const groups = new Map<number, ImageRow[]>();
  for (const r of items) if (r.stack && open.has(r.stack.id)) groups.set(r.stack.id, [...(groups.get(r.stack.id) ?? []), r]);
  if (!groups.size) return items;
  const out: ImageRow[] = [];
  for (const r of items) {
    if (!r.stack || !open.has(r.stack.id)) out.push(r);
    else if (groups.has(r.stack.id)) {
      const ids = r.stack.ids;
      out.push(...groups.get(r.stack.id)!.sort((a, b) => ids.indexOf(a.id) - ids.indexOf(b.id)));
      groups.delete(r.stack.id);
    }
  }
  return out;
}

/** The row whose path shares the most folders with `near`. */
function nearest(rows: ImageRow[], near: string): ImageRow | undefined {
  const parts = near.toLowerCase().split("/");
  const shared = (p: string) => {
    const q = p.toLowerCase().split("/");
    let n = 0;
    while (n < q.length && n < parts.length && q[n] === parts[n]) n++;
    return n;
  };
  return [...rows].sort((a, b) => Number(a.missing) - Number(b.missing) || shared(b.path) - shared(a.path) || a.id - b.id)[0];
}

/**
 * Every picture, video and 3D model under a folder (normalized paths), skipping dot-folders and node_modules. A
 * set's OBJ parts aren't items of their own: the .glb beside their sidecar is the model, or, without one,
 * the sidecar itself (a Blender export's <name>.json).
 */
export async function walk(folder: string, recursive = true): Promise<string[]> {
  const out: string[] = [];
  const visit = async (dir: string) => {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    const files = entries.filter((e) => e.isFile() && !e.name.startsWith(".")).map((e) => e.name);
    const lower = new Set(files.map((f) => f.toLowerCase()));
    const stems = new Set(files.filter((f) => isImage(f) || isVideo(f)).map((f) => f.replace(/\.[^.]+$/, "").toLowerCase()));
    const parts = new Set<string>();
    const sets: string[] = [];
    // A .json is a set's sidecar when it names OBJ parts that are here. A picture's or a video's own sidecar isn't read.
    if (files.some((f) => /\.obj$/i.test(f)))
      for (const f of files) {
        if (!/\.json$/i.test(f) || /\.meta\.json$/i.test(f) || stems.has(f.slice(0, -5).toLowerCase())) continue;
        const set = await readSet(`${dir}/${f}`);
        if (!set) continue;
        set.parts.forEach((p) => parts.add(p.toLowerCase()));
        const stem = f.slice(0, -5).toLowerCase();
        if (!lower.has(`${stem}.glb`) && !lower.has(`${stem}.gltf`)) sets.push(f);
      }
    for (const f of files) if (isImage(f) || isVideo(f) || (isModel(f) && !parts.has(f.toLowerCase()))) out.push(normPath(`${dir}/${f}`));
    for (const f of sets) out.push(normPath(`${dir}/${f}`));
    if (recursive) for (const e of entries) if (e.isDirectory() && !e.name.startsWith(".") && !SKIP_DIRS.has(e.name)) await visit(`${dir}/${e.name}`);
  };
  await visit(normPath(folder));
  return out;
}

/** A file called `name` under `dir`, in folders `want` accepts (by path), looking at no more than `budget` entries. */
async function findFile(dir: string, name: string, want: (dir: string) => boolean, budget: number): Promise<string | undefined> {
  const target = name.toLowerCase();
  const queue = [dir];
  while (queue.length && budget > 0) {
    const d = queue.shift()!;
    let entries;
    try {
      entries = await readdir(d, { withFileTypes: true });
    } catch {
      continue;
    }
    budget -= entries.length;
    for (const e of entries) {
      if (e.name.startsWith(".")) continue;
      const full = `${d}/${e.name}`;
      if (e.isFile() && e.name.toLowerCase() === target && want(d)) return normPath(full);
      if (e.isDirectory() && !SKIP_DIRS.has(e.name)) queue.push(full);
    }
  }
  return undefined;
}

const mtimeOf = (p: string) => {
  try {
    return Math.round(statSync(p).mtimeMs);
  } catch {
    return 0;
  }
};

/** A name in `dir` that isn't taken: a.png, a (2).png, a (3).png… */
function freeName(dir: string, name: string): string {
  const dot = name.lastIndexOf(".");
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : "";
  let to = normPath(join(dir, name));
  for (let n = 2; existsSync(to) || existsSync(sidecarOf(to)); n++) to = normPath(join(dir, `${stem} (${n})${ext}`));
  return to;
}

async function moveFile(from: string, to: string) {
  try {
    await rename(from, to);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "EXDEV") throw e;
    await copyFile(from, to);
    await unlink(from);
  }
}
