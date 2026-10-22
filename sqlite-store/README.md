# @btkulka/sqlite-store

The SQLite layer Ben's apps kept rewriting: open a file with the right pragmas, create its folder, open read-only or must-exist, share one lazy connection, run transactions, migrate the schema (`user_version`, run-once markers, idempotent ALTERs, table rebuilds), read JSON columns safely, and keep a key/value table.

It works on the app's own driver. The app imports **better-sqlite3** (`Database`) or **node:sqlite** (`DatabaseSync`) and hands it in; the package never imports either, so an Electron app keeps its Electron-ABI build of better-sqlite3 and nothing native resolves from `packages/node_modules`. Every function returns or takes the driver's own handle, so the rest of the app's queries don't change.

ESM and CommonJS builds. Node 22+ (node:sqlite needs 22.5+; Node 22 prints an `ExperimentalWarning` when node:sqlite loads, which is Node's, not this package's).

```json
"dependencies": { "@btkulka/sqlite-store": "file:../packages/sqlite-store" }
```

```ts
import Database from "better-sqlite3";                 // or: import { DatabaseSync } from "node:sqlite";
import { openDatabase, lazyDatabase, migrate, addColumn } from "@btkulka/sqlite-store";

const store = lazyDatabase(() =>
  openDatabase(Database, DB_PATH, {
    init: (db) => migrate(db, { steps: MIGRATIONS }),
  }),
);
export const getDb = store.get;     // Database.Database, typed as the driver's own
export const closeDb = store.close;
```

## API

### `openDatabase(driver, path, options?) → handle`

Constructs `driver` (better-sqlite3's `Database` or node:sqlite's `DatabaseSync`; told apart by better-sqlite3's `prototype.pragma`), applies the pragmas, runs `init`, returns the handle typed as the driver's own (`Database.Database` / `DatabaseSync`).

| Option | Default | What it does |
|---|---|---|
| `journalMode` | `"wal"` | `PRAGMA journal_mode`. `false` leaves the file's mode alone. Skipped for read-only and in-memory. |
| `synchronous` | `"normal"` when the file ends up in WAL, else untouched | `PRAGMA synchronous`. `false` leaves it alone. |
| `foreignKeys` | `true` | `PRAGMA foreign_keys`. |
| `busyTimeout` | `5000` | `PRAGMA busy_timeout` (ms). `false` leaves the driver's own. |
| `pragmas` | — | Any others, applied last: `{ cache_size: -32000, mmap_size: 268435456, temp_store: "MEMORY" }`. Booleans become ON/OFF; strings must be bare keywords. |
| `readOnly` | `false` | Read-only connection. The file must exist; no directory is made. |
| `fileMustExist` | `false` | Throw instead of creating an empty database. Implied by `readOnly`. |
| `mkdir` | `true` | `mkdir -p` the file's folder (not for `:memory:`, `""`, `file:` URIs or read-only). |
| `init` | — | `(db) => void`, run after the pragmas (schema, `migrate`). If it throws, the handle is **closed** before the error is rethrown, so a failed open never leaves the file locked (Windows won't rename or delete a file SQLite holds). |

A missing file with `readOnly`/`fileMustExist` throws `Error("SQLite database not found: <path>")` with `code: "SQLITE_CANTOPEN"`, the same on both drivers.

Defaults, compared with what the drivers do on their own:

| | better-sqlite3 alone | node:sqlite alone | `openDatabase` |
|---|---|---|---|
| foreign_keys | **on** (compiled with `SQLITE_DEFAULT_FOREIGN_KEYS=1`) | on (`enableForeignKeyConstraints`) | on |
| busy_timeout | 5000 | **0** (fails at once) | 5000 |
| journal_mode | delete | delete | wal |
| synchronous | FULL, NORMAL on reopening a WAL file | FULL | NORMAL in WAL |

### `lazyDatabase(open) → { get(), close(), isOpen }`

One shared connection, opened by `open()` on the first `get()`. `close()` is safe twice or before any `get()`, and the next `get()` opens again (tests, tools that finish a batch, `will-quit`). A factory that throws caches nothing; the next `get()` retries. `get`/`close` work detached (`export const getDb = store.get`).

### `transaction(db, fn, { mode? }) → fn's result`

Commits when `fn` returns, rolls back and rethrows when it throws. Nested calls become savepoints, including inside better-sqlite3's own `db.transaction()` or a raw `BEGIN` (it reads `inTransaction` / `isTransaction`). `mode` is `"immediate"` (default: takes the write lock up front, so two processes on one WAL file wait on `busy_timeout` instead of failing with SQLITE_BUSY), `"deferred"` or `"exclusive"`. `fn` must be synchronous; returning a promise rolls back and throws a `TypeError`. better-sqlite3 apps can keep `db.transaction(fn)()`; node:sqlite has no helper of its own, so this is it.

### `migrate(db, { steps, version?, schema? }) → { from, to, applied }`

Tracks progress in `PRAGMA user_version`. Each pending step runs once, in order.

- `steps` as an **array** is dense: `steps[0]` takes 0 → 1, `steps[1]` 1 → 2 (append only). As a **record** it is sparse: `{ 2: fn, 6: fn, 13: fn }`, with `version` naming the current version when it is above the last key.
- A step is SQL text (`exec`'d) or `(db) => void` (given the app's own handle).
- `schema` (SQL or function) runs in its own transaction before the steps whenever the file is behind `version`, a new file included: for apps whose schema file is always the current shape (`CREATE TABLE IF NOT EXISTS`) and whose steps only patch older files.
- A file whose `user_version` is above `version` (newer code wrote it) is left alone: `to === from`.

How every step runs (the way SQLite documents for schema changes):

1. **One transaction with its version bump.** A step that throws leaves nothing behind and runs again next open.
2. **Foreign-key enforcement off**, and `PRAGMA foreign_key_check` after: new dangling references roll the step back with `foreign key check failed: N new dangling reference(s)`. Dropping and recreating a parent table therefore never cascades into its children, and a step's own `PRAGMA foreign_keys = OFF/ON` is moot (SQLite ignores it inside a transaction anyway). A step that deletes parent rows *expecting* `ON DELETE CASCADE` now fails loudly; delete the children explicitly.
3. **Re-checked under the write lock**: when two processes open the same file at once (an app and its worker), the second skips a step the first just committed.

Call `migrate` outside any transaction. A `PRAGMA journal_mode`/`foreign_keys` in a step or in `schema` does nothing (SQLite silently ignores both inside a transaction); `openDatabase` sets them.

```ts
migrate(db, { steps: [
  `CREATE TABLE releases (id INTEGER PRIMARY KEY AUTOINCREMENT, type TEXT NOT NULL CHECK (type IN ('flip')))`,
  (db) => addColumn(db, "releases", "sc_url", "TEXT NOT NULL DEFAULT ''"),
  (db) => rebuildTable(db, "releases", RELEASES_SQL),       // widen the CHECK
] });

// job-searcher shape: schema file + sparse patches
migrate(db, { version: 21, schema: readFileSync(SCHEMA, "utf8"), steps: { 2: (db) => addColumn(…), 13: (db) => { … } } });
```

### `runOnce(db, name, step, { table? }) → boolean`

A named one-time step for apps without a version number (idempotent schema on every open, plus data fixes that must happen once). Marker table default `migrations_applied (name TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)`, `applied_at` in ms: clipdrift's exact table, so its markers carry over. The step and its marker commit together, under the same rules as a `migrate` step. Returns whether it ran.

### `getUserVersion(db)`, `setUserVersion(db, n)`

`PRAGMA user_version` on either driver (node:sqlite has no `db.pragma`).

### `addColumn(db, table, column, decl) → boolean`, `hasColumn(db, table, column)`

`ALTER TABLE … ADD COLUMN` only when the column is missing (SQLite has no `ADD COLUMN IF NOT EXISTS`). `decl` is everything after the name: `"TEXT NOT NULL DEFAULT '[]'"`. Returns whether it added it. A real failure throws (unlike the `try { ALTER } catch {}` copies); a column another process added between the check and the ALTER counts as present. Throws when the table doesn't exist. Names are quoted.

### `rebuildTable(db, table, createSql, { map?, indexes? })`

SQLite's documented rebuild for what `ALTER TABLE` can't do (a CHECK list, NOT NULL, a type): create the new table under a temporary name from `createSql` (the full `CREATE TABLE [IF NOT EXISTS] <table> (…)`, usually the app's own schema text), copy every column the old and new shapes share by name, drop, rename, recreate the old table's indexes and triggers, keep the AUTOINCREMENT high-water mark (deleted ids are never reused), all with foreign keys off and checked, in one transaction.

- `map: { kind: "CASE kind WHEN 'Demo' THEN 'Presentation' ELSE kind END" }` transforms a column on the way across (or fills a new one).
- `indexes: [...]` replaces the old indexes/triggers when the new shape would break one.
- Views and other tables' triggers that name the table keep working (the rename uses `legacy_alter_table` so SQLite ≥3.26 doesn't reject it).
- Call it outside a transaction or from a `migrate`/`runOnce` step. Inside a transaction with foreign keys on it throws rather than let `DROP TABLE` cascade.

To widen a CHECK list in place, rebuild from the stored statement: `rebuildTable(db, t, tableSql(db, t)!.replace(OLD_LIST, NEW_LIST))`.

### `withForeignKeysOff(db, fn) → fn's result`

The FK-off transaction `rebuildTable` and the migration steps use, for hand-written table swaps outside `migrate`. Enforcement is restored afterwards however `fn` ends; rows that were already dangling don't block it.

### `tableSql(db, table)`, `listTables(db)`, `quoteIdent(name)`, `placeholders(values | n)`

The stored `CREATE TABLE` text (or `undefined`: doubles as "does it exist"); user tables by name (no `sqlite_*`, no views); `"name"` with quotes doubled; `"?, ?, ?"` for `IN (…)` (empty list → `""`, which SQLite accepts and matches nothing).

### `parseJson(value, fallback)`, `parseJsonArray(value, fallback = [])`, `parseJsonObject(value, fallback)`

Read a JSON TEXT column without throwing: `null`/`undefined`/blank, malformed JSON and a stored JSON `null` give `fallback`. `parseJsonArray` also falls back on a non-array, `parseJsonObject` on a non-object (arrays included). Writing stays `JSON.stringify`.

### `keyValueStore(db, table = "settings", { create? })`

`get(key) → string | null`, `set(key, string)`, `getJson(key, fallback)`, `setJson(key, value)`, `has`, `delete → boolean`, `all() → Record<string, string>` (ordered by key), `clear()`. Creates `<table> (key TEXT PRIMARY KEY, value TEXT NOT NULL)` on first use unless `create: false`; an existing table (extra columns, indexes) is used as it is. Writes are `INSERT OR REPLACE`, so a column like `updated_at … DEFAULT (datetime('now'))` is refreshed by its own default; any extra column needs a default. Statements are prepared once per store, so make one store per open handle.

## Replaces

| Repo | File | Function / lines | Replaced by |
|---|---|---|---|
| job-searcher | `src/db.ts` | `openDb` (22–33) | `openDatabase(Database, path, { init })` + `migrate` |
| job-searcher | `src/db.ts` | `migrate(db, from)` (36–103) | `migrate(db, { version: SCHEMA_VERSION, schema, steps: { 2: …, 21: … } })` |
| job-searcher | `src/db.ts` | `widenStatusCheck` (140–167) | `rebuildTable(db, t, tableSql(db, t)!.replace(…))` in step 17 |
| job-searcher | `src/db.ts` | `settleInterviewKinds` (113–131) | `rebuildTable(db, "interviews", create, { map: { kind: … }, indexes })` in steps 19 and 21 |
| job-searcher | `src/db.ts` | `addColumn` (237–240) | `addColumn` |
| job-searcher | `src/db.ts` | `getSetting`/`setSetting`/`listSettings` (242–268) | `keyValueStore(db, "settings")` `getJson`/`setJson`/`all` |
| job-searcher | `src/sync.ts` | `quoteIdent` (73–75), `db.pragma('user_version')` (132, 325) | `quoteIdent`, `getUserVersion` |
| job-searcher | `scripts/linkedin-send.mjs` | `loadJob` open (48–50) | `openDatabase(Database, path, { readOnly: true })` |
| candybar-manager | `src/lib/db.ts` | `initDatabase`/`getDatabase`/`closeDatabase`/`getDb` (9, 18–175) | `lazyDatabase(() => openDatabase(Database, path, { init: createTables }))` |
| candybar-manager | `src/lib/db.ts` | `ensureDismissedDuplicatesTable`, `ensureDismissedIssuesTable`, `ensureAutopopulatedTable` (298–309, 369–380, 426–433) | delete: `init` creates every table on open |
| candybar-manager | `src/lib/db.ts` | `getAutopopulatedPaths` placeholders (450) | `placeholders(paths)` |
| nhi-dashboard | `src/db.js` | `openDb` (652–659) | `openDatabase(Database, file, { init: migrate })` |
| nhi-dashboard | `src/db.js` | `migrate` (636–650) and the FK-off function step (587–617) | `migrate(db, { steps: MIGRATIONS })`; the function step loses its pragma/transaction/check code |
| nhi-dashboard | `src/db.js` | `getSetting`/`setSetting`/`targets` (661–674) | `keyValueStore(db, "settings")` `get`/`set`/`getJson` |
| clipdrift | `src/main/services/database/core/connection.ts` | `applyPerformancePragmas` (35–44), `initDatabaseAt` (46–70) | `openDatabase(Database, dbPath, { pragmas, init: runMigrations })` |
| clipdrift | `src/main/services/database/core/connection.ts` | `initDatabase`/`getDatabase` singleton (72–100) | `lazyDatabase` |
| clipdrift | `src/main/services/database/core/migrations.ts` | `columnExists`/`addColumnIfNotExists` (6–23) | `hasColumn`/`addColumn` |
| clipdrift | `src/main/services/database/core/migrations.ts` | the 7 `migrations_applied` blocks (322–347, 351–363, 413–437, 440–483, 592–733, 739–768, 816–826) | `runOnce(db, name, fn)` |
| clipdrift | `src/mcp-server/utils/database.ts` | `getDatabase`/`closeDatabase` (21–41) | `lazyDatabase(() => openDatabase(Database, path, { fileMustExist: true }))` |
| clipdrift | `src/mcp-server/utils/database.ts` | `isDatabaseAvailable` open (67–69) | `openDatabase(Database, path, { readOnly: true })` |
| clipdrift | `scripts/faststart-remux.mjs` | `new DatabaseSync(…, { readOnly: true })` (100) | `openDatabase(DatabaseSync, DB_PATH, { readOnly: true })` |
| clipdrift | `src/mcp-server/tools/clip-upscale.tools.ts` | placeholders (228) | `placeholders` |
| orson | `src/db/character-db.ts` | constructor (285–293) | `openDatabase(Database, path, { init })` |
| orson | `src/db/character-db.ts` | `migrate` ALTER try/catch list + rename guard (300–366) | `addColumn` per column, `hasColumn` for the rename |
| orson | `src/db/character-db.ts` | `parseStringArray`, `parseSpellSlots`, `parseSkillProfs`, `rowToItem` tags (154–179, 253–257, 272–280) | `parseJsonArray` / `parseJsonObject` (+ the app's own element filter) |
| orson | `src/db/image-jobs-db.ts` | constructor (245–251) | `openDatabase` |
| orson | `src/db/image-jobs-db.ts` | ALTER try/catch list (312–321), `subject_kind` CHECK rebuild (328–385) | `addColumn`; `rebuildTable(db, "image_jobs", CREATE_IMAGE_JOBS)` |
| orson | `src/db/image-db.ts` | constructor (176–181), `parseArtistStyleRefs` parse (108–125) | `openDatabase`; `parseJsonArray` |
| orson | `src/db/notifications-db.ts` | constructor (100–106) | `openDatabase` |
| orson | `src/civitai/assets-db.ts` | constructor (89–92), `rowToAsset` trained words (261–265) | `openDatabase`; `parseJsonArray` |
| orson | `scripts/orson/mine-negatives.ts` | existsSync + read-only open (77–83) | `openDatabase(Database, args.db, { readOnly: true })` |
| starfall | `server/tagIntel.ts` | `getDb` (247–262), `closeDb` (265), `json` (269–272) | `lazyDatabase` + `migrate`, `.close`, `parseJsonArray` |
| starfall | `server/loraConfig.ts` | `getDb` (160–170), `parseJson` (172–174), `parseSettings` (195–) | `lazyDatabase` + `migrate`, `parseJsonArray`, `parseJsonObject` |
| starfall | `server/stores/chronicleStore.ts` | `getDb` (39–59), `parseJson` (61–64) | `lazyDatabase`, `parseJson` |
| starfall | `server/inventoryStore.ts` | `getDb` (45–58), `parseJson` (60–63) | `lazyDatabase`, `parseJson` |
| starfall | `server/costumeConfig.ts` | `getDb` (85–108) incl. ALTER try/catch (106), `parseObj` (110–113) | `lazyDatabase`, `addColumn`, `parseJson` |
| starfall | `tools/harvest-danbooru-tags.mts` (96–97), `tools/orphan-audit.mts` (119) | read-only opens | `openDatabase(Database, path, { readOnly: true })` |
| nhi/nhi-album-art-gen | `src/lib/db/client.ts` | `getDb` (10–24), `runMigrations` (26–74) | `lazyDatabase` + `migrate` with a 2-step array |
| nhi/nhi-album-art-gen | `src/lib/db/queries/settings.ts` | `getSetting`/`setSetting`/`getJsonSetting`/`setJsonSetting` | `keyValueStore(getDb(), "settings")` |
| norf-hampton-electron | `packages/main/src/services/storage/SqliteAdapter.ts` | `initialize` (21–46), `get`/`set`/`delete`/`has`/`clear`/`close` (48–120) | `openDatabase` + `keyValueStore(db, "kv_store")` inside the adapter |
| nhi/lilith | `src/main/library.js` | `open` (43–51), `migrate` (53–113), `getSetting`/`setSetting` (349–362) | `lazyDatabase` + `openDatabase` + `migrate`, `keyValueStore` |
| ableton-extensions-store | `server/src/db.js` | open + pragmas (11–15), `addColumn` (138–141) | `openDatabase(Database, …)`, `addColumn` |
| benhaus | `src/main/db.ts` | `openReadOnly` (11–14), table listing in `dbState` (29–35) | `openDatabase(DatabaseSync, path, { readOnly: true, busyTimeout: 0 })`, `listTables` + `quoteIdent` |
| the-and-digital | `server/src/db.ts` | DDL pragmas (21–24), `open`/`handle`/`close` (193–214), `tx` (222–233) | `openDatabase(DatabaseSync, …)`, `lazyDatabase`, `transaction` |
| the-and-digital | `server/src/db.ts` + `store.ts` | `meta` table reads/writes (`schema_version`, `migrated_from_json`) | `keyValueStore(db, "meta")` |

Also `IN (${xs.map(() => '?').join(',')})` across job-searcher (≈20 sites), nhi-dashboard `src/queries.js:257`, `src/backup.js:86`: `placeholders(xs)` for new code; rewriting the existing one-liners is optional.

## Per-app migration notes

Common to all: add the dependency, build this package (`npm run build` here), import the driver yourself and pass it in. Keep each app's DB path logic (`app.getPath('userData')`, env overrides, `PKG_ROOT`) in the app.

**Everyone on better-sqlite3 who never set `foreign_keys`** (clipdrift, starfall, orson's assets-db, norf): enforcement was already on (better-sqlite3 compiles with `SQLITE_DEFAULT_FOREIGN_KEYS=1`). clipdrift's comment that its `ON DELETE CASCADE`s are "decorative" is wrong: they cascade today. Keep the default `foreignKeys: true`; passing `false` would *change* behaviour.

**Migrations, all apps:** every step now runs in a transaction with foreign keys **off** and checked afterwards. Delete any `PRAGMA foreign_keys = OFF/ON`, `foreign_key_check` and `BEGIN/COMMIT` an app wrapped around a table swap; use `rebuildTable` or plain SQL. A step that deletes parent rows relying on `ON DELETE CASCADE` must delete the children itself, or it fails with `foreign key check failed`. Errors in steps now propagate (no more swallowed `catch {}`) and roll the step back.

### job-searcher
- `openDb(path)`: `openDatabase(Database, path, { init: (db) => migrate(db, { version: SCHEMA_VERSION, schema: readFileSync(join(PKG_ROOT, 'schema.sql'), 'utf8'), steps: STEPS }) })`. Keep `defaultDbPath()`, `PKG_ROOT`, `SCHEMA_VERSION`. `:memory:` works as before (no mkdir, no WAL).
- The file is already WAL (`schema.sql` line 4 set it). `openDatabase` now sets WAL on every open; the `PRAGMA journal_mode = WAL;` line in `schema.sql` becomes a silent no-op inside the schema's transaction and can be deleted.
- `STEPS` is a record keyed by the versions `migrate(db, from)` branches on today: `2, 3, 6, 8, 11, 12, 13, 14, 15, 17, 19, 21`; each body is the `if (from < N)` block. 17 → `for (const t of ['applications', 'status_events']) { const sql = tableSql(db, t); if (sql && !sql.includes(list)) rebuildTable(db, t, sql.replace(/\(\s*'Draft'\s*,[^)]*\)/g, list)); }` (the `CREATE TABLE <name>` rename is done for you; drop the `__v${SCHEMA_VERSION}` temp naming). 19 and 21 → `settleInterviewKinds` becomes `rebuildTable(db, 'interviews', create, { map: { kind: CASE_EXPR }, indexes })` with `create`/`indexes` cut from `schema.sql` exactly as today; keep its "already settled" early return.
- Steps that used `db.transaction(() => …)()` internally (`splitStoredOte`, `foundViaFromResearch`, `settleStoredChannels`) still work (they nest as savepoints); the wrappers can go.
- Behaviour change: before, the whole migration ran and then `user_version` jumped to 21. Now each step commits with its own version, so a failure at 15 leaves the file at the last good version and resumes there.
- `getSetting`/`requireSetting`/`setSetting`/`listSettings` keep their signatures, implemented with `keyValueStore(db, 'settings')`: `getJson(key, null)`, `setJson`, and `listSettings` = `Object.fromEntries(Object.entries(kv.all()).map(([k, v]) => [k, parseJson(v, null)]))`. A malformed row now reads as missing instead of throwing.
- `sync.ts`: `quoteIdent` from the package; `dumpDb`, `restoreDump`, `backupDb` stay (see "Not shared"). `restoreDump`/`backupDb` open raw `new Database()` on purpose (temp file, VACUUM INTO); leave them.
- `scripts/linkedin-send.mjs` is plain ESM that `require`s better-sqlite3 from the app's `node_modules`: `openDatabase(Database, path, { readOnly: true })` is optional there.
- Tests (`test/db.test.ts`) build old-shaped files with raw `new Database` and then call `openDb`: they should pass unchanged; re-run them.

### candybar-manager (CommonJS, Electron)
- `const store = lazyDatabase(() => openDatabase(Database, path.join(app.getPath('userData'), 'candybar.db'), { init: createTables }))`, where `createTables` is today's `db.exec` block. `getDatabase = store.get`, `closeDatabase` = `store.close` wrapped in its try/log (keep the `will-quit` call).
- Behaviour change: `getDb()` used to throw "Database not initialized" before `initDatabase()`; `store.get()` opens on demand instead. `initDatabase()` can stay as `store.get()` at startup so failures still surface there.
- Delete the three `ensure*Table` functions and their calls: `init` creates those tables on every open.
- New: `synchronous=NORMAL` and `busy_timeout` explicit (the same values better-sqlite3 already used on reopen).

### nhi-dashboard (CommonJS JS)
- `openDb(file = DEFAULT_DB)` → `openDatabase(Database, file, { init: migrateDb })`; `:memory:` still skips WAL and mkdir.
- Keep exporting `migrate(db)` (tests call it after `pragma('user_version = 8')`): `const migrateDb = (db) => migrate(db, { steps: MIGRATIONS })`. The array keeps its order; `user_version` is still its index.
- The function entry (587–617) becomes `(db) => db.exec(\`CREATE TABLE releases_new … CREATE INDEX releases_drop_date …\`)` with its `foreign_keys` pragmas, `db.transaction` and `foreign_key_check` removed (the runner does all three), or `(db) => rebuildTable(db, 'releases', RELEASES_SQL)`. **Don't keep its `db.pragma('foreign_keys = OFF')`**: inside the step's transaction SQLite ignores it (harmless now, because the runner already turned enforcement off, but it reads as if it mattered).
- Behaviour change: string steps used to run with foreign keys **on**; their `DROP TABLE pipeline_tasks`/`outreach`/`content_posts` rebuilds now run with them off (what SQLite recommends; nothing cascades on the drop).
- `getSetting(db, key, fallback)` → `keyValueStore(db, 'settings').get(key) ?? fallback`; `setSetting(db, key, value)` → `.set(key, String(value))` (it takes strings only; callers pass numbers today); `targets(db)` → `.getJson('targets', DEFAULT_TARGETS)`.

### clipdrift (CommonJS, Electron + worker + MCP server)
- `initDatabaseAt(dbPath, busyTimeout)` → `openDatabase(Database, dbPath, { busyTimeout: 5000, pragmas: { cache_size: -32000, mmap_size: 268435456, temp_store: 'MEMORY' }, init: runMigrations })` (WAL and `synchronous = NORMAL` are defaults; `applyPerformancePragmas` goes). The worker passed 5000 and main passed 0, which left better-sqlite3's 5000: same value either way.
- `initDatabase`/`getDatabase` → `lazyDatabase(() => openDatabase(…clipdrift.db…))`; keep `getDataPath()`, `getThumbnailPath()` and the thumbnails `mkdir` in the app.
- `migrations.ts`: `columnExists`/`addColumnIfNotExists` → `hasColumn`/`addColumn` (same argument order); each `migrations_applied` block → `runOnce(db, 'randomize_tag_colors_v1', (db) => { … })` with the body minus its own marker `INSERT` and `SELECT 1` check. Names must stay byte-identical so existing markers match. The `CREATE TABLE migrations_applied` block can go (runOnce creates it, same shape).
- Behaviour change: each one-time migration is now atomic with its marker, and main + worker starting together can't both run it.
- MCP server `utils/database.ts`: `lazyDatabase(() => openDatabase(Database, getDatabasePath(), { fileMustExist: true }))`; catch `code === 'SQLITE_CANTOPEN'` to keep the "Run ClipDrift first" message. `isDatabaseAvailable` → `openDatabase(Database, dbPath, { readOnly: true })` then close.
- `scripts/faststart-remux.mjs`: `openDatabase(DatabaseSync, DB_PATH, { readOnly: true })`, and close it after reading (today it never closes).
- Leave `pyDb.ts`/`run-upscale.ts` (Python, by instruction), `core/cache.ts`, and the `StaleWorkDb`/`DownloadRecoveryDb` slices (both drivers satisfy them; `SqliteHandle` could replace them later).

### orson (ESM, Electron; better-sqlite3 built by electron-rebuild)
- Each class constructor: `this.db = openDatabase(Database, path, { init: (db) => … })` (mkdir, WAL, FK come with it). `assets-db.ts` never set `foreign_keys`; it was on anyway (see above).
- `character-db.ts` `migrate()`: every `ALTER TABLE x ADD COLUMN y decl` → `addColumn(this.db, 'x', 'y', 'decl')`; the `landscape_path` rename block keeps its logic with `hasColumn`. Keep the rarity `UPDATE`s' try/catch (it's for an old CHECK, not a missing column).
- `image-jobs-db.ts`: the ALTER list → `addColumn`; the CHECK swap → `if (!sql.includes("'location'")) rebuildTable(this.db, 'image_jobs', CREATE_IMAGE_JOBS)`; keep the surrounding try/catch-warn if a failed swap should stay non-fatal. Its indexes are recreated by `rebuildTable` (old ones) and by the `CREATE INDEX IF NOT EXISTS` block after it.
- JSON helpers: `parseStringArray(raw)` → `parseJsonArray(raw).filter((s): s is string => typeof s === 'string')`; `parseSpellSlots` keeps its integer filter over `parseJsonObject(raw, {})`.
- `ImageDB` and `CharacterDB` open the same file: still two handles, as today.
- `mine-negatives.ts`: `openDatabase(Database, args.db, { readOnly: true })`; the `existsSync` pre-check can become a catch on `SQLITE_CANTOPEN`.

### starfall (ESM; leave `server/docstore/` alone)
- Each `getDb()` → a module-level `lazyDatabase(() => openDatabase(Database, DB_PATH, { … }))` and `getDb = store.get`. tagIntel: `busyTimeout: 10000` (the ingest/harvest overlap) and `closeDb = store.close`. `DB_PATH` stays module-level, read from env as now (the tests set env first).
- tagIntel and loraConfig `MIGRATIONS` arrays → `init: (db) => migrate(db, { steps: MIGRATIONS })`. **Keep the arrays exactly as they are**: `user_version` counts elements (tagIntel's indexes are elements of their own), and the "v5"-style comments don't match the numbers.
- Behaviour change: the `try { exec } catch {}` around each element is gone; a failing element now throws and stays pending. For the `ALTER TABLE … ADD COLUMN` elements, use `(db) => addColumn(db, 'tag', 'replacements', "TEXT NOT NULL DEFAULT '[]'")` to keep the "already there" tolerance honestly.
- chronicleStore/inventoryStore: schema `db.exec` goes in `init`. costumeConfig: `init` runs the CREATE then `addColumn(db, 'costume_config', 'tags', "TEXT NOT NULL DEFAULT '[]'")`.
- `parseJson`/`parseObj` → `parseJson(s, fallback)` (same semantics: null/malformed/JSON null → fallback); tagIntel `json(s, fb)` and loraConfig `parseJson` → `parseJsonArray`; `parseSettings` → `parseJson<RecommendedSettings | null>(s, null)` plus its object check; `parseAxis`/`parseSlotTags` keep their validation on top of `parseJson`.

### nhi/nhi-album-art-gen (Next.js, server side)
- `getDb()` → `lazyDatabase(() => openDatabase(Database, DB_PATH, { init: (db) => migrate(db, { steps: [V1_SQL, V2_SQL] }) }))`. Existing files are at `user_version` 2: nothing reruns.
- `queries/settings.ts`: `keyValueStore(getDb(), 'settings')`: `get`, `set`, `getJson(key, fallback)`, `setJson`. `updated_at` keeps refreshing via its `DEFAULT (datetime('now'))`.

### norf-hampton-electron
- Keep the async `StorageAdapter` surface. `initialize()` → `this.db = openDatabase(Database, path.join(app.getPath('userData'), this.filename), { init: (db) => db.exec(KV_TABLE_AND_INDEX) })` and `this.kv = keyValueStore(this.db, 'kv_store')`. `get` → `this.kv.getJson<T | null>(key, null)` (a parse error is `null`, as today; keep the debug logging around it), `set` → `setJson`, `delete`, `has`, `clear` direct, `close` closes the handle.
- `updated_at` keeps refreshing: `INSERT OR REPLACE` re-applies its `DEFAULT (strftime('%s','now'))`.
- New: foreign keys on (no FKs in `kv_store`), `synchronous=NORMAL`, `busy_timeout` 5000.

### nhi/lilith (CommonJS JS, Electron)
- `open()` → `lazyDatabase(() => openDatabase(Database, path.join(dataDir(), 'library.db'), { init: (db) => migrate(db, { steps: [BASE_SQL, ASSETS_SQL] }) }))`. Both are `IF NOT EXISTS`, so existing files (at `user_version` 0, with `schema_meta.version = '2'`) run them again harmlessly and land at 2. `schema_meta` can stay unused or be dropped in a third step.
- `getSetting(key, fallback)` → `kv.getJson(key, fallback)`; `setSetting` → `kv.setJson`.

### ableton-extensions-store (ESM server)
- `export const db = openDatabase(Database, path.join(DATA_DIR, 'store.db'))` (still eager at import). Keep `fs.mkdirSync(FILES_DIR, …)`: `openDatabase` only makes `DATA_DIR`.
- `addColumn('users', 'plan', "plan TEXT NOT NULL DEFAULT 'free'")` → `addColumn(db, 'users', 'plan', "TEXT NOT NULL DEFAULT 'free'")`: the package's `decl` excludes the column name.

### benhaus (node:sqlite, Electron main)
- `openReadOnly(path)` → `openDatabase(load().DatabaseSync, path, { readOnly: true, busyTimeout: 0 })`. Keep the lazy `require("node:sqlite")` (it defers Node's experimental warning). **Keep `busyTimeout: 0`** (node:sqlite's default, what benhaus has today): these reads run on the Electron main thread for other apps' files, and failing fast into the panel's error beats freezing the window for up to 5 s when one of them is locked.
- `dbState`: `listTables(db).slice(0, 24)` and `quoteIdent(t)` in the count query. `listTables` escapes `_` in its `sqlite_%` filter, so a user table named like `sqliteX` is no longer hidden.

### the-and-digital (node:sqlite)
- Remove the four `PRAGMA` lines from `DDL` (`openDatabase` sets the same: WAL, NORMAL, foreign keys, 5000).
- `open(dataDir)`: `db ??= openDatabase(DatabaseSync, join(dataDir, 'the-and.db'), { init: (d) => { d.exec(DDL); const meta = keyValueStore(d, 'meta'); if (!meta.has('schema_version')) meta.set('schema_version', String(SCHEMA_VERSION)); } })` (keep INSERT-OR-IGNORE semantics with `has`). `handle()`/`close()` as today, or a `lazyDatabase` whose factory reads `DATA_DIR`.
- `tx(fn)` → `transaction(handle(), fn)`: `BEGIN IMMEDIATE` by default, as now. Difference: a nested `tx` used to throw ("cannot start a transaction within a transaction"); now it is a savepoint.
- `store.ts` `migrated_from_json`: `keyValueStore(db, 'meta').get/set`.

## Not shared

- **job-searcher `sync.ts` `dumpDb`/`restoreDump`/`backupDb`** (byte-stable SQL dump, rebuild-and-swap, `VACUUM INTO` backup): one app.
- **SQL literal quoting** (`nhi-dashboard` `sqlText`, job-searcher `literal`): two different jobs (one quotes a string for migration text, one writes a dump with hex blobs and bigints); bound parameters are the answer everywhere else.
- **clipdrift `core/cache.ts` `QueryCache`**: a TTL map, not SQLite, one app.
- **benhaus `dbState`** (record counts for the UI): one app; it uses `listTables`/`quoteIdent`.
- **Electron ABI handling** (orson `scripts/ensure-native-abi.ts`, `src/training/node-abi-launcher.ts`, norf `storageService.ts`'s JSON fallback): build tooling; the package sidesteps it by never loading a driver.
- **Close on process exit**: no app hooks `process.on('exit')`; they close explicitly (candybar on `will-quit`, job-searcher in its CLI `finally`, tests). `lazyDatabase().close()` covers that. Exiting without closing loses nothing (SQLite replays the WAL on the next open).
- **Row mappers, repositories, the orson `*DB` classes, app schemas**: app code.
- **A JSON string-array filter** (`parseStringArray` in orson): one app; it's `parseJsonArray(...).filter(isString)`.

### Python copies

- `clipdrift/src/mcp-server/utils/pyDb.ts` (used by `run-upscale.ts`) shells out to Python's `sqlite3` with parameterized SQL, to avoid loading the Electron-ABI better-sqlite3 from a plain Node runner. Left as is by instruction. (node:sqlite would remove the Python dependency: `openDatabase(DatabaseSync, path)` loads under any Node 22, no ABI involved.)
- No `.py` file in the in-scope repos opens SQLite.

## Developing

```
npm run build       # ESM (dist/esm) + CommonJS (dist/cjs)
npm run typecheck
npm test            # builds, then node --test; every suite runs on both drivers
```

better-sqlite3 and its types are dev dependencies for the tests only (`src/testing/drivers.ts`, excluded from the CommonJS build and never imported by `src/index.ts`).
