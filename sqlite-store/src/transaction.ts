import type { SqliteHandle } from "./types.js";

export type TransactionMode = "deferred" | "immediate" | "exclusive";

export interface TransactionOptions {
  /**
   * How the outermost transaction begins. Default `"immediate"`: the write lock is taken up
   * front, so two processes on one WAL file (an app and its worker, an ingest and a harvest)
   * wait on `busy_timeout` instead of failing with SQLITE_BUSY when a read upgrades to a
   * write. Ignored for a nested call, which is a savepoint.
   */
  mode?: TransactionMode;
}

/** Our own nesting depth, for a handle that reports neither `inTransaction` nor `isTransaction`. */
const depth = new WeakMap<object, number>();
let savepoints = 0;

/**
 * Whether the connection is inside a transaction right now: better-sqlite3's `inTransaction`,
 * node:sqlite's `isTransaction` (Node 22.16+), or failing both, whether `transaction()` is
 * running on it. Both native flags read SQLite's autocommit state, so they also see a
 * transaction the app opened itself (better-sqlite3's `db.transaction()`, a raw `BEGIN`).
 */
export function inTransaction(db: SqliteHandle): boolean {
  const flags = db as { inTransaction?: unknown; isTransaction?: unknown };
  if (typeof flags.inTransaction === "boolean") return flags.inTransaction;
  if (typeof flags.isTransaction === "boolean") return flags.isTransaction;
  return (depth.get(db) ?? 0) > 0;
}

function isThenable(v: unknown): boolean {
  return (typeof v === "object" || typeof v === "function") && v !== null && typeof (v as { then?: unknown }).then === "function";
}

/**
 * Run `fn` in a transaction and return what it returns. Commits when `fn` returns, rolls back
 * and rethrows when it throws. A call inside another transaction (this helper's, better-sqlite3's
 * `db.transaction()`, or a raw `BEGIN`) becomes a savepoint, so only its own work is undone.
 *
 * `fn` must be synchronous: both drivers are, and a promise would commit before the work
 * it stands for. Returning one rolls back and throws, as better-sqlite3's own helper does.
 */
export function transaction<T>(db: SqliteHandle, fn: () => T, options: TransactionOptions = {}): T {
  const nested = inTransaction(db);
  const name = nested ? `sqlite_store_sp${++savepoints}` : "";
  if (nested) db.exec(`SAVEPOINT ${name}`);
  else db.exec(`BEGIN ${(options.mode ?? "immediate").toUpperCase()}`);
  depth.set(db, (depth.get(db) ?? 0) + 1);

  const undo = () => {
    try {
      if (nested) {
        db.exec(`ROLLBACK TO ${name}`);
        db.exec(`RELEASE ${name}`);
      } else {
        db.exec("ROLLBACK");
      }
    } catch {
      // SQLite already rolled the transaction back itself (SQLITE_FULL, SQLITE_IOERR, …):
      // there is nothing left to undo, and the original error is the one worth seeing.
    }
  };

  try {
    let out: T;
    try {
      out = fn();
    } catch (e) {
      undo();
      throw e;
    }
    if (isThenable(out)) {
      undo();
      throw new TypeError("transaction() callback returned a promise; it must be synchronous (the work would land after the commit)");
    }
    try {
      db.exec(nested ? `RELEASE ${name}` : "COMMIT");
    } catch (e) {
      undo();
      throw e;
    }
    return out;
  } finally {
    const d = (depth.get(db) ?? 1) - 1;
    if (d > 0) depth.set(db, d);
    else depth.delete(db);
  }
}
