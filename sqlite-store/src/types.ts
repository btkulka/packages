/**
 * The slice of a SQLite connection this package uses. A better-sqlite3 `Database` and a
 * node:sqlite `DatabaseSync` both match it structurally, so every helper takes the app's own
 * handle and hands it back untouched. Nothing here names either driver's types, so an app
 * on older `@types/node` (no `node:sqlite`) or without `@types/better-sqlite3` still compiles.
 *
 * Bind parameters are `any[]` because the two drivers type them differently; anything
 * narrower stops one of them matching.
 */
export interface SqliteStatement {
  run(...params: any[]): { changes: number | bigint; lastInsertRowid: number | bigint };
  get(...params: any[]): unknown;
  all(...params: any[]): unknown[];
}

export interface SqliteHandle {
  exec(sql: string): unknown;
  prepare(sql: string): SqliteStatement;
  close(): unknown;
}

/**
 * The class the app imports and hands in: better-sqlite3's default export
 * (`import Database from "better-sqlite3"`) or `DatabaseSync` from `node:sqlite`. The package
 * constructs it only to translate the options; it never imports either driver.
 */
export type SqliteDriver<D extends SqliteHandle = SqliteHandle> = new (path: string, options?: any) => D;
