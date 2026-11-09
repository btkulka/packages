// Test-only: both real drivers, and temp directories that clean up after themselves.
// Excluded from the CommonJS build and never imported by src/index.ts.
import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SqliteDriver, SqliteHandle } from "@btkulka/sqlite-store";

export const drivers: { name: string; driver: SqliteDriver<SqliteHandle> }[] = [
  { name: "better-sqlite3", driver: Database as unknown as SqliteDriver<SqliteHandle> },
  { name: "node:sqlite", driver: DatabaseSync as unknown as SqliteDriver<SqliteHandle> },
];

export interface Sandbox {
  dir: string;
  file(...parts: string[]): string;
  /** Close this handle when the test ends (before the directory goes). */
  track<D extends SqliteHandle>(db: D): D;
}

export function sandbox(t: { after(fn: () => void): void }): Sandbox {
  const dir = mkdtempSync(join(tmpdir(), "data-sync-"));
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

/** A small app schema: AUTOINCREMENT ids, a text-keyed table, a foreign key, an index and a trigger. */
export const SCHEMA = `
CREATE TABLE habits (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, goal REAL, icon BLOB);
CREATE TABLE checkins (id INTEGER PRIMARY KEY AUTOINCREMENT, habit_id INTEGER NOT NULL REFERENCES habits(id) ON DELETE CASCADE, day TEXT NOT NULL, value INTEGER);
CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE cache (key TEXT PRIMARY KEY, value TEXT);
CREATE INDEX checkins_day ON checkins(day);
CREATE TRIGGER habits_touch AFTER UPDATE ON habits BEGIN UPDATE settings SET value = 'touched' WHERE key = 'touch'; END;
PRAGMA user_version = 3;
`;
