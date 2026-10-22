import { existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { readPragma, setPragma } from "./pragma.js";
import type { SqliteDriver, SqliteHandle } from "./types.js";

export type JournalMode = "wal" | "delete" | "truncate" | "persist" | "memory" | "off";
export type Synchronous = "off" | "normal" | "full" | "extra";
const JOURNAL_MODES: readonly string[] = ["wal", "delete", "truncate", "persist", "memory", "off"];
const SYNCHRONOUS: readonly string[] = ["off", "normal", "full", "extra"];

export interface ConfigureOptions {
  /**
   * `PRAGMA journal_mode`. Default `"wal"`. `false` leaves the file's mode as it is. Never
   * applied to a read-only connection (it cannot change the mode) or an in-memory database.
   */
  journalMode?: JournalMode | false;
  /** `PRAGMA foreign_keys`. Default `true`. Both drivers already default to on; this makes it explicit. */
  foreignKeys?: boolean;
  /**
   * `PRAGMA busy_timeout` in ms: how long a statement waits for another connection's lock
   * before failing with SQLITE_BUSY. Default 5000, better-sqlite3's own default (node:sqlite's
   * is 0, which fails at once). `false` leaves it alone.
   */
  busyTimeout?: number | false;
  /**
   * `PRAGMA synchronous`. Default: `"normal"` when the connection ends up in WAL (SQLite's
   * documented pairing: safe across app crashes, only an OS crash or power cut can lose the
   * last commits), otherwise left alone. `false` always leaves it alone.
   */
  synchronous?: Synchronous | false;
  /**
   * Any other pragmas, applied last in the order given: `{ cache_size: -32000,
   * mmap_size: 268435456, temp_store: "MEMORY" }`. Booleans become ON/OFF.
   */
  pragmas?: Readonly<Record<string, string | number | boolean>>;
}

export interface OpenOptions<D extends SqliteHandle = SqliteHandle> extends ConfigureOptions {
  /** Open read-only. The file must exist; no directory is created. */
  readOnly?: boolean;
  /** Fail with a clear error instead of creating a new empty database. Implied by `readOnly`. */
  fileMustExist?: boolean;
  /** Create the file's directory first. Default `true` for a writable file path. */
  mkdir?: boolean;
  /**
   * Runs after the pragmas: schema, migrations, seed rows. When it throws, the handle is
   * closed before the error is rethrown, so a failed open never leaves the file locked
   * (which on Windows blocks a rename or delete of it).
   */
  init?: (db: D) => void;
}

/** `:memory:`, `""` (a private temp database) or a `file:` URI: nothing on disk to prepare. */
function isSpecialPath(path: string): boolean {
  return path === "" || path === ":memory:" || path.startsWith("file:");
}

function isBetterSqlite3(driver: SqliteDriver<SqliteHandle>): boolean {
  // better-sqlite3's Database has `pragma` and `transaction` on its prototype; DatabaseSync has neither.
  const proto = (driver as { prototype?: Record<string, unknown> }).prototype;
  return typeof proto?.pragma === "function" && typeof proto?.transaction === "function";
}

function memoryLike(db: SqliteHandle, path: string): boolean {
  if (path === "" || path === ":memory:") return true;
  return /^file::memory:|[?&]mode=memory(&|$)/.test(path) || readPragma(db, "journal_mode") === "memory";
}

/** Apply the open options' pragmas to a freshly constructed handle. */
function configureDatabase<D extends SqliteHandle>(db: D, options: ConfigureOptions & { readOnly?: boolean; path?: string } = {}): D {
  const { journalMode = "wal", foreignKeys = true, busyTimeout = 5000, synchronous, pragmas } = options;
  // busy_timeout first, so switching the journal mode waits for another process's lock.
  if (busyTimeout !== false) {
    if (!Number.isInteger(busyTimeout) || busyTimeout < 0) throw new Error(`busyTimeout must be a non-negative integer of ms, got ${busyTimeout}`);
    setPragma(db, "busy_timeout", busyTimeout);
  }
  if (journalMode !== false && !options.readOnly && !memoryLike(db, options.path ?? "")) {
    if (!JOURNAL_MODES.includes(journalMode)) throw new Error(`journalMode must be one of ${JOURNAL_MODES.join(", ")} or false, got ${JSON.stringify(journalMode)}`);
    // journal_mode answers with a row (the mode it ended up in), so it is read, not exec'd.
    db.prepare(`PRAGMA journal_mode = ${journalMode.toUpperCase()}`).get();
  }
  const sync = synchronous ?? (String(readPragma(db, "journal_mode")).toLowerCase() === "wal" ? "normal" : false);
  if (sync !== false) {
    if (!SYNCHRONOUS.includes(sync)) throw new Error(`synchronous must be one of ${SYNCHRONOUS.join(", ")} or false, got ${JSON.stringify(sync)}`);
    setPragma(db, "synchronous", sync.toUpperCase());
  }
  setPragma(db, "foreign_keys", foreignKeys);
  for (const [name, value] of Object.entries(pragmas ?? {})) setPragma(db, name, value);
  return db;
}

function notFound(path: string): Error {
  return Object.assign(new Error(`SQLite database not found: ${path}`), { code: "SQLITE_CANTOPEN" });
}

/**
 * Open a SQLite file with the driver the app hands in, and return the driver's own handle
 * (a better-sqlite3 `Database` or a node:sqlite `DatabaseSync`) with the pragmas applied.
 *
 * ```ts
 * import Database from "better-sqlite3";
 * const db = openDatabase(Database, join(app.getPath("userData"), "candybar.db"));
 *
 * import { DatabaseSync } from "node:sqlite";
 * const ro = openDatabase(DatabaseSync, file, { readOnly: true });
 * ```
 */
export function openDatabase<D extends SqliteHandle>(driver: SqliteDriver<D>, path: string, options: OpenOptions<D> = {}): D {
  if (typeof path !== "string") throw new TypeError("openDatabase(driver, path): path must be a string");
  const special = isSpecialPath(path);
  const readOnly = options.readOnly === true;
  const mustExist = readOnly || options.fileMustExist === true;
  if (mustExist && !special && !existsSync(path)) throw notFound(path);
  if (!readOnly && !special && options.mkdir !== false) mkdirSync(dirname(path), { recursive: true });

  const db = isBetterSqlite3(driver)
    ? new driver(path, { readonly: readOnly, fileMustExist: mustExist && !special })
    : new driver(path, { readOnly });
  try {
    configureDatabase(db, { ...options, readOnly, path });
    options.init?.(db);
  } catch (e) {
    try {
      db.close();
    } catch {
      // the original error is the one worth seeing
    }
    throw e;
  }
  return db;
}

export interface LazyDatabase<D extends SqliteHandle> {
  /** The handle, opened by the factory on the first call and shared after that. */
  get(): D;
  /** Close it if open. Safe to call twice or before any `get()`; the next `get()` opens again. */
  close(): void;
  /** Whether a handle is open right now. */
  readonly isOpen: boolean;
}

/**
 * One shared connection, opened on first use. The factory usually is `openDatabase` plus the
 * app's migrations. A factory that throws caches nothing, so the next `get()` tries again
 * rather than handing out a half-migrated handle.
 *
 * ```ts
 * const store = lazyDatabase(() => openDatabase(Database, DB_PATH, { init: (db) => migrate(db, { steps: MIGRATIONS }) }));
 * export const getDb = store.get;
 * export const closeDb = store.close;
 * ```
 */
export function lazyDatabase<D extends SqliteHandle>(open: () => D): LazyDatabase<D> {
  let db: D | null = null;
  return {
    get(): D {
      if (db) return db;
      const opened = open();
      db = opened;
      return opened;
    },
    close(): void {
      const current = db;
      db = null;
      current?.close();
    },
    get isOpen(): boolean {
      return db !== null;
    },
  };
}
