import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { openDatabase, quoteIdent, type SqliteDriver, type SqliteHandle } from "@btkulka/sqlite-store";
import { shaOf, type Dump } from "./dump.js";

// A snapshot is one file, so Syncthing can never deliver half of it: a header line with the manifest, then
// the dump. The manifest's sha is checked against the body on every read, so a file cut short reads as
// missing rather than as data.

const MAGIC = "-- data-sync 1 ";

export interface Manifest {
  app: string;
  /** sha256 of the SQL after the header line. */
  sha: string;
  /** The machine that wrote it (its host name). */
  machine: string;
  createdAt: string;
  schemaVersion: number;
  rows: Record<string, number>;
  total: number;
}

export interface Snapshot {
  manifest: Manifest;
  sql: string;
}

export const snapshotName = "snapshot.sql";

/** Write atomically: a temp name Syncthing never picks up, then a rename. */
export function writeSnapshot(file: string, app: string, machine: string, dump: Dump): Manifest {
  const manifest: Manifest = { app, sha: dump.sha, machine, createdAt: new Date().toISOString(), schemaVersion: dump.schemaVersion, rows: dump.rows, total: dump.total };
  mkdirSync(dirname(file), { recursive: true });
  const tmp = join(dirname(file), `.syncthing.${basename(file)}.tmp`);
  writeFileSync(tmp, `${MAGIC}${JSON.stringify(manifest)}\n${dump.sql}`, "utf8");
  renameSync(tmp, file);
  return manifest;
}

/** The snapshot in `file`, or null when there is none or it doesn't check out (cut short, edited, not ours). */
export function readSnapshot(file: string): Snapshot | null {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return null;
  }
  return parseSnapshot(text);
}

export function parseSnapshot(text: string): Snapshot | null {
  if (!text.startsWith(MAGIC)) return null;
  const nl = text.indexOf("\n");
  if (nl < 0) return null;
  try {
    const manifest = JSON.parse(text.slice(MAGIC.length, nl)) as Manifest;
    const sql = text.slice(nl + 1);
    if (typeof manifest?.sha !== "string" || shaOf(sql) !== manifest.sha) return null;
    return { manifest, sql };
  } catch {
    return null;
  }
}

/** The manifest alone, without hashing the body: for status lines. */
export function peekManifest(file: string): Manifest | null {
  try {
    const head = readFileSync(file, "utf8").split("\n", 1)[0];
    return head.startsWith(MAGIC) ? (JSON.parse(head.slice(MAGIC.length)) as Manifest) : null;
  } catch {
    return null;
  }
}

/** Syncthing's conflict copies of the snapshot ("snapshot.sync-conflict-20261109-151500-ABCDEFG.sql"): two machines wrote at once. */
export function conflictCopies(file: string): string[] {
  const dir = dirname(file);
  const stem = basename(file).replace(/\.sql$/, "");
  try {
    return readdirSync(dir)
      .filter((n) => n.startsWith(`${stem}.sync-conflict-`))
      .sort()
      .map((n) => join(dir, n));
  } catch {
    return [];
  }
}

const stamp = () => new Date().toISOString().replace(/[:.]/g, "-");

/** A complete copy of the live file, WAL folded in (VACUUM INTO), in `dir`. */
export function backupDatabase<D extends SqliteHandle>(driver: SqliteDriver<D>, dbPath: string, dir: string, why: string): string {
  mkdirSync(dir, { recursive: true });
  const dest = join(dir, `${basename(dbPath).replace(/\.(db|sqlite3?)$/i, "")}-${why}-${stamp()}.db`);
  const db = openDatabase(driver, dbPath, { fileMustExist: true, journalMode: false });
  try {
    db.prepare("VACUUM INTO ?").run(dest);
  } finally {
    db.close();
  }
  return dest;
}

const columns = (db: SqliteHandle, schema: string, table: string): string[] =>
  (db.prepare(`PRAGMA ${schema}.table_info(${quoteIdent(table)})`).all() as { name: string }[]).map((c) => c.name);

/**
 * Rebuild `sql` into a fresh file and move it over `dbPath`, which must not be open (Windows won't
 * replace an open file). The replay and its checks run in a temp file, so a bad snapshot fails before
 * the live database is touched. Tables in `keep` hold this machine's own rows: they're copied across
 * from the old file. The old file is backed up first.
 */
export function restoreSnapshot<D extends SqliteHandle>(
  driver: SqliteDriver<D>,
  sql: string,
  dbPath: string,
  options: { backupDir: string; keep?: readonly string[] },
): { backup: string | null } {
  const incoming = `${dbPath}.incoming`;
  for (const f of [incoming, `${incoming}-wal`, `${incoming}-shm`]) rmSync(f, { force: true });
  const had = existsSync(dbPath);

  const fresh = openDatabase(driver, incoming, { journalMode: "delete" });
  try {
    fresh.exec(sql);
    if (had && options.keep?.length) {
      fresh.prepare("ATTACH DATABASE ? AS old").run(dbPath);
      try {
        const oldTables = new Set((fresh.prepare(`SELECT name FROM old.sqlite_master WHERE type = 'table'`).all() as { name: string }[]).map((t) => t.name));
        for (const t of options.keep) {
          if (!oldTables.has(t)) continue;
          const theirs = new Set(columns(fresh, "old", t));
          const cols = columns(fresh, "main", t).filter((c) => theirs.has(c));
          if (!cols.length) continue;
          const list = cols.map(quoteIdent).join(", ");
          fresh.exec(`DELETE FROM main.${quoteIdent(t)}; INSERT INTO main.${quoteIdent(t)} (${list}) SELECT ${list} FROM old.${quoteIdent(t)};`);
        }
      } finally {
        fresh.exec("DETACH DATABASE old");
      }
    }
    const integrity = Object.values((fresh.prepare("PRAGMA integrity_check").get() as Record<string, unknown>) ?? {})[0];
    if (integrity !== "ok") throw new Error(`the snapshot didn't rebuild cleanly: integrity_check said "${String(integrity)}"`);
    const broken = fresh.prepare("PRAGMA foreign_key_check").all();
    if (broken.length) throw new Error(`the snapshot has ${broken.length} broken foreign-key reference(s), so it wasn't restored`);
  } catch (e) {
    fresh.close();
    rmSync(incoming, { force: true });
    throw e;
  }
  fresh.close();

  const backup = had ? backupDatabase(driver, dbPath, options.backupDir, "before-sync") : null;
  for (const suffix of ["", "-wal", "-shm"]) rmSync(`${dbPath}${suffix}`, { force: true });
  renameSync(incoming, dbPath);
  return { backup };
}
