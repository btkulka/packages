import { createHash } from "node:crypto";
import { quoteIdent, type SqliteHandle } from "@btkulka/sqlite-store";

/** A database as text: what travels between machines, and the sha that says whether two hold the same rows. */
export interface Dump {
  sql: string;
  /** sha256 of `sql`. */
  sha: string;
  /** Rows per table carried. */
  rows: Record<string, number>;
  total: number;
  /** `PRAGMA user_version`. */
  schemaVersion: number;
}

export interface DumpOptions {
  /** Tables that stay on each machine (caches, this machine's own settings). Their schema still travels. */
  exclude?: readonly string[];
}

const SEQ = "sqlite_sequence";

function literal(v: unknown): string {
  if (v === null || v === undefined) return "NULL";
  if (typeof v === "bigint") return String(v);
  if (typeof v === "number") return Number.isFinite(v) ? String(v) : "NULL";
  if (typeof v === "boolean") return v ? "1" : "0";
  // better-sqlite3 hands BLOBs back as Buffers, node:sqlite as Uint8Arrays.
  if (v instanceof Uint8Array) return `X'${Buffer.from(v.buffer, v.byteOffset, v.byteLength).toString("hex")}'`;
  return `'${String(v).replace(/'/g, "''")}'`;
}

const scalar = (db: SqliteHandle, sql: string): unknown => {
  const row = db.prepare(sql).get() as Record<string, unknown> | undefined;
  return row === undefined ? undefined : Object.values(row)[0];
};

export const shaOf = (sql: string): string => createHash("sha256").update(sql, "utf8").digest("hex");

/**
 * The whole database as SQL: schema, every row in primary-key order, the AUTOINCREMENT counters, then
 * indexes, triggers and views (after the rows, so no trigger fires on a restore), then user_version.
 * Nothing time-, path- or machine-dependent goes in: two machines holding the same rows write the same
 * bytes, which is what lets the sha stand for the data.
 *
 * Run it on the app's own connection; it reads inside one transaction so a write mid-dump can't tear it.
 */
export function dumpDatabase(db: SqliteHandle, options: DumpOptions = {}): Dump {
  const exclude = new Set(options.exclude ?? []);
  db.exec("BEGIN");
  try {
    const tables = db
      .prepare(`SELECT name, sql FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND sql IS NOT NULL ORDER BY name`)
      .all() as { name: string; sql: string }[];
    const virtual = tables.filter((t) => /^\s*CREATE\s+VIRTUAL\s+TABLE/i.test(t.sql));
    if (virtual.length)
      throw new Error(`data-sync can't carry virtual tables yet (${virtual.map((t) => t.name).join(", ")}): rebuild them on each machine and list them, and their shadow tables, in exclude.`);
    const later = db
      .prepare(`SELECT sql FROM sqlite_master WHERE type IN ('index', 'trigger', 'view') AND name NOT LIKE 'sqlite_%' AND sql IS NOT NULL ORDER BY type, name`)
      .all() as { sql: string }[];

    const out: string[] = ["PRAGMA foreign_keys=OFF;", "BEGIN TRANSACTION;"];
    const rows: Record<string, number> = {};
    for (const t of tables) out.push(`${t.sql.trim()};`);

    for (const t of tables) {
      if (exclude.has(t.name)) continue;
      const cols = (db.prepare(`PRAGMA table_info(${quoteIdent(t.name)})`).all() as { name: string; pk: number }[]).map((c) => ({ name: c.name, pk: c.pk }));
      const pk = cols.filter((c) => c.pk > 0).sort((a, b) => a.pk - b.pk);
      // Primary-key order, not rowid: a text-keyed table's insertion order differs per machine for the same content.
      const order = (pk.length ? pk : cols).map((c) => quoteIdent(c.name)).join(", ");
      const list = cols.map((c) => quoteIdent(c.name)).join(", ");
      const data = db.prepare(`SELECT ${list} FROM ${quoteIdent(t.name)} ORDER BY ${order}`).all() as Record<string, unknown>[];
      rows[t.name] = data.length;
      for (const r of data) out.push(`INSERT INTO ${quoteIdent(t.name)} (${list}) VALUES (${cols.map((c) => literal(r[c.name])).join(", ")});`);
    }

    // The counters travel too, or the other machine reuses an id a deleted row still owns here.
    if (db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = '${SEQ}'`).get()) {
      const seq = (db.prepare(`SELECT name, seq FROM ${SEQ} ORDER BY name`).all() as { name: string; seq: number }[]).filter((s) => !exclude.has(s.name));
      if (seq.length) {
        out.push(`DELETE FROM ${SEQ};`);
        for (const s of seq) out.push(`INSERT INTO ${SEQ} (name, seq) VALUES (${literal(s.name)}, ${literal(s.seq)});`);
      }
    }

    for (const l of later) out.push(`${l.sql.trim()};`);
    out.push("COMMIT;");
    const schemaVersion = Number(scalar(db, "PRAGMA user_version") ?? 0);
    out.push(`PRAGMA user_version = ${schemaVersion};`);
    const sql = `${out.join("\n")}\n`;
    return { sql, sha: shaOf(sql), rows, total: Object.values(rows).reduce((a, b) => a + b, 0), schemaVersion };
  } finally {
    db.exec("COMMIT");
  }
}
