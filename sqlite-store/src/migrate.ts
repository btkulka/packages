import { getUserVersion, setUserVersion } from "./pragma.js";
import { quoteIdent, withForeignKeysOff } from "./schema.js";
import { transaction } from "./transaction.js";
import type { SqliteHandle } from "./types.js";

/**
 * One migration: SQL to `exec`, or a function given the app's own handle.
 *
 * Every step runs the way SQLite documents for schema changes: in one transaction with its
 * bookkeeping (the `user_version` bump or the run-once marker), with foreign-key enforcement
 * off, and a `PRAGMA foreign_key_check` afterwards (see `withForeignKeysOff`). So:
 * - a step that throws leaves nothing half-applied, and runs again on the next open;
 * - dropping and recreating a parent table (`rebuildTable`, or by hand) can't cascade into its
 *   children;
 * - a step that leaves rows pointing at nothing is rolled back with an error, including one
 *   that deleted parent rows expecting `ON DELETE CASCADE` to clear the children: delete the
 *   children explicitly in the step.
 *
 * A step's own `PRAGMA foreign_keys = …` or `PRAGMA journal_mode = …` does nothing: SQLite
 * silently ignores both inside a transaction. Enforcement is already off, and `openDatabase`
 * sets the journal mode.
 */
export type MigrationStep<D extends SqliteHandle = SqliteHandle> = string | ((db: D) => void);

export interface MigrateOptions<D extends SqliteHandle = SqliteHandle> {
  /**
   * The steps, by the `user_version` each one brings the database to. An array is dense:
   * `steps[0]` takes 0 → 1, `steps[1]` takes 1 → 2, and so on (append only: a step inserted in
   * the middle is skipped on every existing database). A record is sparse: `{ 2: …, 6: …, 13: … }`
   * for versions that need code, with `version` naming the current one.
   */
  steps: readonly MigrationStep<D>[] | Readonly<Record<number, MigrationStep<D>>>;
  /** The version a fully migrated database has. Default: the highest step's. */
  version?: number;
  /**
   * Idempotent schema (`CREATE TABLE IF NOT EXISTS …`) run, in its own transaction, before the
   * steps whenever the database is behind `version`, a brand-new one included. For apps whose
   * schema file is always the current shape and whose steps only patch older databases.
   */
  schema?: string | ((db: D) => void);
}

export interface MigrateResult {
  /** `user_version` before. */
  from: number;
  /** `user_version` after. Equal to `from` when nothing was pending (or the file is newer than this code). */
  to: number;
  /** The versions whose steps ran, in order. */
  applied: number[];
}

/**
 * Run a step and its bookkeeping in one transaction, foreign keys off and checked after.
 * `done` is asked again once the transaction holds the write lock: two processes opening the
 * same file at once (an app and its worker) both see the step as pending, and the second must
 * not run it again after the first commits. Returns whether the step ran.
 */
function runStep<D extends SqliteHandle>(db: D, step: MigrationStep<D>, done: () => boolean, after: () => void): boolean {
  if (typeof step !== "string" && typeof step !== "function") throw new TypeError("a migration step is SQL text or a function of the handle");
  return withForeignKeysOff(db, (): boolean => {
    if (done()) return false;
    if (typeof step === "string") db.exec(step);
    else step(db);
    after();
    return true;
  });
}

function orderedSteps<D extends SqliteHandle>(steps: MigrateOptions<D>["steps"]): [number, MigrationStep<D>][] {
  if (Array.isArray(steps)) return (steps as readonly MigrationStep<D>[]).map((s, i) => [i + 1, s]);
  return Object.entries(steps as Record<string, MigrationStep<D>>)
    .map(([k, s]): [number, MigrationStep<D>] => {
      const v = Number(k);
      if (!Number.isInteger(v) || v < 1) throw new Error(`migrate: step key ${JSON.stringify(k)} is not a version number (1 or more)`);
      return [v, s];
    })
    .sort((a, b) => a[0] - b[0]);
}

/**
 * Bring the database up to date, tracking progress in `PRAGMA user_version`. Each pending step
 * runs once, in order, in a transaction with its version bump (see `MigrationStep`). Call it
 * outside any transaction: steps need to turn foreign-key enforcement off.
 *
 * ```ts
 * migrate(db, { steps: [
 *   `CREATE TABLE releases (…)`,                                             // 0 → 1
 *   (db) => addColumn(db, "releases", "sc_url", "TEXT NOT NULL DEFAULT ''"), // 1 → 2
 *   (db) => rebuildTable(db, "releases", RELEASES_SQL),                      // 2 → 3
 * ] });
 * ```
 */
export function migrate<D extends SqliteHandle>(db: D, options: MigrateOptions<D>): MigrateResult {
  const steps = orderedSteps(options.steps);
  const highest = steps.length ? steps[steps.length - 1][0] : 0;
  const target = options.version ?? highest;
  if (!Number.isInteger(target) || target < 0) throw new Error(`migrate: version must be a non-negative integer, got ${target}`);
  if (target < highest) throw new Error(`migrate: version ${target} is below the highest step (${highest})`);

  const from = getUserVersion(db);
  const applied: number[] = [];
  if (from >= target) return { from, to: from, applied };

  const { schema } = options;
  if (schema !== undefined) {
    transaction(db, () => {
      if (typeof schema === "string") db.exec(schema);
      else schema(db);
    });
  }
  for (const [version, step] of steps) {
    if (version <= from) continue;
    const ran = runStep(
      db,
      step,
      () => getUserVersion(db) >= version,
      () => setUserVersion(db, version),
    );
    if (ran) applied.push(version);
  }
  transaction(db, () => {
    if (getUserVersion(db) < target) setUserVersion(db, target);
  });
  return { from, to: getUserVersion(db), applied };
}

export interface RunOnceOptions {
  /**
   * The table that records which named steps have run: `(name TEXT PRIMARY KEY, applied_at
   * INTEGER NOT NULL)`, `applied_at` in ms. Created when missing. Default `migrations_applied`,
   * clipdrift's table, so its existing markers carry over.
   */
  table?: string;
}

/**
 * Run a named one-time step (a backfill, a data fix) unless its marker says it already ran.
 * The step and its marker commit together. Returns whether it ran.
 *
 * For apps without a version number: their schema is idempotent and runs on every open,
 * and only data changes need to happen once.
 */
export function runOnce<D extends SqliteHandle>(db: D, name: string, step: MigrationStep<D>, options: RunOnceOptions = {}): boolean {
  const table = quoteIdent(options.table ?? "migrations_applied");
  db.exec(`CREATE TABLE IF NOT EXISTS ${table} (name TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)`);
  const done = () => db.prepare(`SELECT 1 AS done FROM ${table} WHERE name = ?`).get(name) !== undefined;
  if (done()) return false;
  return runStep(db, step, done, () => {
    db.prepare(`INSERT INTO ${table} (name, applied_at) VALUES (?, ?)`).run(name, Date.now());
  });
}
