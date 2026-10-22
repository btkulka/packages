import { parseJson } from "./json.js";
import { quoteIdent } from "./schema.js";
import type { SqliteHandle, SqliteStatement } from "./types.js";

export interface KeyValueStore {
  /** The stored text, or `null` when the key is missing. */
  get(key: string): string | null;
  /** Store text under `key`, replacing what was there. */
  set(key: string, value: string): void;
  /** The stored value parsed as JSON; `fallback` when missing, malformed or JSON `null`. */
  getJson<T>(key: string, fallback: T): T;
  /** Store `JSON.stringify(value)` (`undefined` is stored as `null`). */
  setJson(key: string, value: unknown): void;
  has(key: string): boolean;
  /** Remove a key. Returns whether it was there. */
  delete(key: string): boolean;
  /** Every key and its stored text, ordered by key. */
  all(): Record<string, string>;
  /** Remove every key. */
  clear(): void;
}

export interface KeyValueOptions {
  /**
   * `CREATE TABLE IF NOT EXISTS <table> (key TEXT PRIMARY KEY, value TEXT NOT NULL)` on first
   * use. Default `true`. An app whose schema already creates the table (with extra columns,
   * an index) can leave it on: an existing table is not touched.
   */
  create?: boolean;
}

/**
 * A key/value table: settings, app state, migration markers. The table needs `key` (primary
 * key) and `value` TEXT columns; any other column must have a default. A write replaces the
 * row (`INSERT OR REPLACE`), so a column such as `updated_at … DEFAULT (datetime('now'))` is
 * refreshed by its own default on every write.
 *
 * ```ts
 * const settings = keyValueStore(db, "settings");
 * settings.setJson("targets", { floor: 1500 });
 * const targets = settings.getJson("targets", DEFAULT_TARGETS);
 * ```
 */
export function keyValueStore(db: SqliteHandle, table = "settings", options: KeyValueOptions = {}): KeyValueStore {
  const t = quoteIdent(table);
  let ready = false;
  const cache = new Map<string, SqliteStatement>();
  const stmt = (sql: string): SqliteStatement => {
    if (!ready) {
      if (options.create !== false) db.exec(`CREATE TABLE IF NOT EXISTS ${t} (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);
      ready = true;
    }
    let s = cache.get(sql);
    if (!s) {
      s = db.prepare(sql);
      cache.set(sql, s);
    }
    return s;
  };

  const get = (key: string): string | null => {
    const row = stmt(`SELECT value FROM ${t} WHERE key = ?`).get(key) as { value: unknown } | undefined;
    if (!row || row.value === null || row.value === undefined) return null;
    return typeof row.value === "string" ? row.value : String(row.value);
  };
  const set = (key: string, value: string): void => {
    if (typeof value !== "string") throw new TypeError(`keyValueStore.set(${JSON.stringify(key)}): value must be a string; use setJson for anything else`);
    stmt(`INSERT OR REPLACE INTO ${t} (key, value) VALUES (?, ?)`).run(key, value);
  };

  return {
    get,
    set,
    getJson: <T>(key: string, fallback: T): T => parseJson(get(key), fallback),
    setJson: (key: string, value: unknown): void => set(key, JSON.stringify(value) ?? "null"),
    has: (key: string): boolean => stmt(`SELECT 1 AS found FROM ${t} WHERE key = ?`).get(key) !== undefined,
    delete: (key: string): boolean => Number(stmt(`DELETE FROM ${t} WHERE key = ?`).run(key).changes) > 0,
    all: (): Record<string, string> => {
      const rows = stmt(`SELECT key, value FROM ${t} ORDER BY key`).all() as { key: string; value: unknown }[];
      // fromEntries, not assignment, so a key named "__proto__" is an ordinary entry.
      return Object.fromEntries(rows.map((r) => [r.key, typeof r.value === "string" ? r.value : String(r.value)]));
    },
    clear: (): void => {
      stmt(`DELETE FROM ${t}`).run();
    },
  };
}
