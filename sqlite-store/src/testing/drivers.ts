// Test-only: both real drivers, and temp directories that clean up after themselves.
// Excluded from the CommonJS build and never imported by src/index.ts.
import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SqliteDriver, SqliteHandle } from "../types.js";

export interface TestDriver {
  name: string;
  driver: SqliteDriver<SqliteHandle>;
}

export const drivers: TestDriver[] = [
  { name: "better-sqlite3", driver: Database as unknown as SqliteDriver<SqliteHandle> },
  { name: "node:sqlite", driver: DatabaseSync as unknown as SqliteDriver<SqliteHandle> },
];

export { Database, DatabaseSync };

export interface Sandbox {
  dir: string;
  /** A path inside the sandbox. */
  file(...parts: string[]): string;
  /** Close this handle when the test ends (before the directory goes). */
  track<D extends SqliteHandle>(db: D): D;
}

/**
 * A fresh temp directory, removed when the test ends after every tracked handle is closed:
 * Windows won't delete a file SQLite still has open.
 */
export function sandbox(t: { after(fn: () => void): void }): Sandbox {
  const dir = mkdtempSync(join(tmpdir(), "sqlite-store-"));
  const handles: SqliteHandle[] = [];
  t.after(() => {
    for (const h of handles) {
      try {
        h.close();
      } catch {
        // already closed
      }
    }
    rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
  });
  return {
    dir,
    file: (...parts) => join(dir, ...parts),
    track: (db) => {
      handles.push(db);
      return db;
    },
  };
}

/** First column of a one-row query. */
export function scalar(db: SqliteHandle, sql: string, ...params: unknown[]): unknown {
  const row = db.prepare(sql).get(...params) as Record<string, unknown> | undefined;
  return row === undefined ? undefined : Object.values(row)[0];
}

/** Plain objects, whatever prototype the driver gave its rows (node:sqlite's have none). */
export function rows(db: SqliteHandle, sql: string, ...params: unknown[]): Record<string, unknown>[] {
  return (db.prepare(sql).all(...params) as Record<string, unknown>[]).map((r) => ({ ...r }));
}
