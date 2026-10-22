import { readPragma } from "./pragma.js";
import { transaction } from "./transaction.js";
import type { SqliteHandle } from "./types.js";

/** Quote an identifier for SQL: `my "table"` → `"my ""table"""`. */
export function quoteIdent(name: string): string {
  return `"${String(name).replace(/"/g, '""')}"`;
}

/**
 * `?, ?, ?` for an `IN (…)` list: `WHERE id IN (${placeholders(ids)})` then `.all(...ids)`.
 * An empty list gives `""`; SQLite accepts `IN ()` and matches nothing.
 */
export function placeholders(values: readonly unknown[] | number): string {
  const n = typeof values === "number" ? values : values.length;
  if (!Number.isInteger(n) || n < 0) throw new Error(`placeholders: ${n} is not a count`);
  return Array.from({ length: n }, () => "?").join(", ");
}

/** User tables, by name, without SQLite's own (`sqlite_sequence`, `sqlite_stat1`…). */
export function listTables(db: SqliteHandle): string[] {
  const rows = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\' ORDER BY name")
    .all() as { name: string }[];
  return rows.map((r) => r.name);
}

/** The `CREATE TABLE` statement SQLite stored for a table, or `undefined` when there is no such table. */
export function tableSql(db: SqliteHandle, table: string): string | undefined {
  const row = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?").get(table) as { sql: string | null } | undefined;
  return row?.sql ?? undefined;
}

function columnNames(db: SqliteHandle, table: string): string[] {
  return (db.prepare("SELECT name FROM pragma_table_info(?)").all(table) as { name: string }[]).map((r) => r.name);
}

/** Whether `table` has `column`. False when the table does not exist. */
export function hasColumn(db: SqliteHandle, table: string, column: string): boolean {
  return db.prepare("SELECT 1 AS found FROM pragma_table_info(?) WHERE name = ?").get(table, column) !== undefined;
}

/**
 * `ALTER TABLE … ADD COLUMN` when the column is missing; nothing when it is there. SQLite has
 * no `ADD COLUMN IF NOT EXISTS`, and swallowing the ALTER's error (the old way) also swallows
 * real failures. `decl` is everything after the name: `"TEXT NOT NULL DEFAULT '[]'"`.
 * Returns whether it added the column. Throws when the table does not exist.
 */
export function addColumn(db: SqliteHandle, table: string, column: string, decl: string): boolean {
  if (hasColumn(db, table, column)) return false;
  try {
    db.exec(`ALTER TABLE ${quoteIdent(table)} ADD COLUMN ${quoteIdent(column)} ${decl}`);
  } catch (e) {
    // Another process on the same file (an app and its worker both migrating at startup)
    // added it between the check and the ALTER: that's the outcome we wanted.
    if (hasColumn(db, table, column)) return false;
    throw e;
  }
  return true;
}

function foreignKeysOn(db: SqliteHandle): boolean {
  return Number(readPragma(db, "foreign_keys")) === 1;
}

function violations(db: SqliteHandle): number {
  return db.prepare("PRAGMA foreign_key_check").all().length;
}

/**
 * Run `fn` in a transaction with foreign-key enforcement off, then check that it left no new
 * dangling references (`PRAGMA foreign_key_check`, compared with before, so rows that were
 * already broken don't block it). New violations roll everything back and throw. Enforcement
 * is restored afterwards, however `fn` ends.
 *
 * This is what dropping and recreating a parent table needs: with enforcement on, `DROP TABLE`
 * deletes the rows first and every `ON DELETE CASCADE` child goes with them.
 *
 * SQLite ignores `PRAGMA foreign_keys` inside a transaction, so this must be called outside
 * one, or from a `migrate`/`runOnce` step (those already run this way, so it nests). Called
 * inside a transaction with enforcement on, it throws rather than run unprotected.
 */
export function withForeignKeysOff<T>(db: SqliteHandle, fn: () => T): T {
  const wasOn = foreignKeysOn(db);
  if (wasOn) {
    db.exec("PRAGMA foreign_keys = OFF");
    if (foreignKeysOn(db)) {
      throw new Error(
        "withForeignKeysOff: foreign keys can't be turned off inside a transaction (SQLite ignores the pragma there). " +
          "Call it outside transaction(), or from a migrate()/runOnce() step, which already runs with them off.",
      );
    }
  }
  try {
    return transaction(db, () => {
      const before = violations(db);
      const out = fn();
      const after = violations(db);
      if (after > before) throw new Error(`foreign key check failed: ${after - before} new dangling reference(s); nothing was changed`);
      return out;
    });
  } finally {
    if (wasOn) db.exec("PRAGMA foreign_keys = ON");
  }
}

export interface RebuildOptions {
  /**
   * Column → SQL expression over the old table, for a column whose values change on the way
   * across (`{ kind: "CASE kind WHEN 'Demo' THEN 'Presentation' ELSE kind END" }`) or a new
   * column to fill. Every other column the old and new table share is copied by name; a new
   * column not named here gets its default.
   */
  map?: Readonly<Record<string, string>>;
  /**
   * The `CREATE INDEX` / `CREATE TRIGGER` statements to run after the swap. Default: the old
   * table's own, as SQLite stored them. Pass them when the new shape would break an old one.
   */
  indexes?: readonly string[];
}

const CREATE_TABLE = /^\s*CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:"(?:[^"]|"")+"|`[^`]+`|\[[^\]]+\]|[A-Za-z_][\w$]*)/i;

/**
 * Rebuild `table` from a new `CREATE TABLE` statement, the way SQLite documents for changes
 * `ALTER TABLE` can't make (a CHECK list, NOT NULL, a column type): create the new table under
 * a temporary name, copy the rows, drop the old one, rename, recreate its indexes and
 * triggers, keep the AUTOINCREMENT high-water mark (so deleted ids are never reused). Runs
 * with foreign keys off and checks them afterwards (see `withForeignKeysOff`), all in one
 * transaction: if anything fails, the old table is untouched.
 *
 * `create` is the table's full statement under its real name (`CREATE TABLE [IF NOT EXISTS] releases (…)`),
 * usually the same text the app's schema has.
 */
export function rebuildTable(db: SqliteHandle, table: string, create: string, options: RebuildOptions = {}): void {
  if (!tableSql(db, table)) throw new Error(`rebuildTable: no table ${table}`);
  if (!CREATE_TABLE.test(create)) throw new Error(`rebuildTable: expected a CREATE TABLE statement for ${table}`);
  const tmp = `${table}__rebuild`;
  withForeignKeysOff(db, () => {
    const extras =
      options.indexes ??
      (
        db
          .prepare("SELECT sql FROM sqlite_master WHERE tbl_name = ? AND type IN ('index', 'trigger') AND sql IS NOT NULL ORDER BY type, name")
          .all(table) as { sql: string }[]
      ).map((r) => r.sql);
    const hasSequence = tableSql(db, "sqlite_sequence") !== undefined;
    const seq = hasSequence ? (db.prepare("SELECT seq FROM sqlite_sequence WHERE name = ?").get(table) as { seq: number } | undefined) : undefined;

    db.exec(create.replace(CREATE_TABLE, `CREATE TABLE ${quoteIdent(tmp)}`));
    const oldCols = new Set(columnNames(db, table));
    const map = options.map ?? {};
    for (const col of Object.keys(map)) {
      if (!columnNames(db, tmp).includes(col)) throw new Error(`rebuildTable: map names ${col}, which the new ${table} doesn't have`);
    }
    const mapped = (c: string) => Object.prototype.hasOwnProperty.call(map, c);
    const cols = columnNames(db, tmp).filter((c) => mapped(c) || oldCols.has(c));
    if (cols.length) {
      const target = cols.map(quoteIdent).join(", ");
      const source = cols.map((c) => (mapped(c) ? map[c] : quoteIdent(c))).join(", ");
      db.exec(`INSERT INTO ${quoteIdent(tmp)} (${target}) SELECT ${source} FROM ${quoteIdent(table)}`);
    }
    db.exec(`DROP TABLE ${quoteIdent(table)}`);
    // Since SQLite 3.26 a rename re-checks every view and trigger, and one that names the
    // table just dropped fails it ("error in view v: no such table"). The legacy rename skips
    // that check; once the rename lands, those views and triggers resolve to the new table.
    const legacy = Number(readPragma(db, "legacy_alter_table")) === 1;
    if (!legacy) db.exec("PRAGMA legacy_alter_table = ON");
    try {
      db.exec(`ALTER TABLE ${quoteIdent(tmp)} RENAME TO ${quoteIdent(table)}`);
    } finally {
      if (!legacy) db.exec("PRAGMA legacy_alter_table = OFF");
    }
    for (const sql of extras) db.exec(sql);

    if (seq && tableSql(db, "sqlite_sequence") !== undefined && /\bAUTOINCREMENT\b/i.test(create)) {
      const kept = db.prepare("UPDATE sqlite_sequence SET seq = max(seq, ?) WHERE name = ?").run(seq.seq, table);
      if (Number(kept.changes) === 0) db.prepare("INSERT INTO sqlite_sequence (name, seq) VALUES (?, ?)").run(table, seq.seq);
    }
  });
}

