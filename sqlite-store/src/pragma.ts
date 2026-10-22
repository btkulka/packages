import type { SqliteHandle } from "./types.js";

/**
 * Read a pragma's single value (`PRAGMA user_version` → 7). Works the same on both drivers,
 * where better-sqlite3's own `db.pragma(name, { simple: true })` exists on only one.
 */
export function readPragma(db: SqliteHandle, name: string): unknown {
  checkName(name);
  const row = db.prepare(`PRAGMA ${name}`).get() as Record<string, unknown> | undefined;
  if (!row) return undefined;
  const values = Object.values(row);
  return values[0];
}

/** Set a pragma. Numbers and booleans go in as is; a string must be a bare keyword (`NORMAL`, `MEMORY`). */
export function setPragma(db: SqliteHandle, name: string, value: string | number | boolean): void {
  checkName(name);
  db.exec(`PRAGMA ${name} = ${pragmaLiteral(name, value)}`);
}

function checkName(name: string): void {
  if (!/^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)?$/.test(name)) throw new Error(`not a pragma name: ${JSON.stringify(name)}`);
}

function pragmaLiteral(name: string, value: string | number | boolean): string {
  if (typeof value === "boolean") return value ? "ON" : "OFF";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error(`PRAGMA ${name}: ${value} is not a finite number`);
    return String(value);
  }
  if (!/^-?[A-Za-z0-9_.]+$/.test(value)) throw new Error(`PRAGMA ${name}: ${JSON.stringify(value)} is not a bare keyword or number`);
  return value;
}

/** `PRAGMA user_version`: the schema version the versioned migrations track. 0 on a new file. */
export function getUserVersion(db: SqliteHandle): number {
  return Number(readPragma(db, "user_version") ?? 0);
}

/** Set `PRAGMA user_version`. Transactional: inside a transaction it commits or rolls back with it. */
export function setUserVersion(db: SqliteHandle, version: number): void {
  if (!Number.isInteger(version) || version < 0 || version > 0x7fffffff) throw new Error(`user_version must be a non-negative 32-bit integer, got ${version}`);
  db.exec(`PRAGMA user_version = ${version}`);
}
