import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { addColumn, getUserVersion, migrate, openDatabase, rebuildTable, runOnce, setUserVersion, tableSql, transaction } from "./index.js";
import { Database, drivers, rows, sandbox, scalar } from "./testing/drivers.js";
import type { SqliteHandle } from "./types.js";

for (const { name, driver } of drivers) {
  describe(`migrate (${name})`, () => {
    const open = (t: Parameters<typeof sandbox>[0]) => {
      const box = sandbox(t);
      return { box, db: box.track(openDatabase(driver, box.file("a.db"))) };
    };
    const STEPS = [
      "CREATE TABLE releases (id INTEGER PRIMARY KEY, title TEXT NOT NULL)",
      "ALTER TABLE releases ADD COLUMN notes TEXT NOT NULL DEFAULT ''",
    ];

    test("a dense array: index i takes the database to version i + 1, once", (t) => {
      const { db } = open(t);
      assert.deepEqual(migrate(db, { steps: STEPS }), { from: 0, to: 2, applied: [1, 2] });
      assert.equal(getUserVersion(db), 2);
      assert.deepEqual(migrate(db, { steps: STEPS }), { from: 2, to: 2, applied: [] }, "nothing re-runs");
      const more = [...STEPS, "CREATE INDEX releases_title ON releases (title)"];
      assert.deepEqual(migrate(db, { steps: more }), { from: 2, to: 3, applied: [3] }, "only the appended step runs");
    });

    test("a failing step is rolled back whole and leaves the version where it was", (t) => {
      const { db } = open(t);
      migrate(db, { steps: STEPS.slice(0, 1) });
      const bad = [...STEPS.slice(0, 1), "CREATE TABLE extra (a); INSERT INTO nowhere VALUES (1)"];
      assert.throws(() => migrate(db, { steps: bad }), /nowhere/);
      assert.equal(getUserVersion(db), 1);
      assert.equal(tableSql(db, "extra"), undefined, "the step's first statement was undone too");
      const fixed = [...STEPS.slice(0, 1), "CREATE TABLE extra (a)"];
      assert.deepEqual(migrate(db, { steps: fixed }).applied, [2], "and runs again once fixed");
    });

    test("function steps get the app's own handle", (t) => {
      const { db } = open(t);
      let got: unknown;
      migrate(db, {
        steps: [
          (d) => {
            got = d;
            d.exec("CREATE TABLE t (a)");
          },
        ],
      });
      assert.equal(got, db);
    });

    test("a sparse record with a schema and a target version (schema file + patches)", (t) => {
      const { db } = open(t);
      const SCHEMA = "CREATE TABLE IF NOT EXISTS apps (id INTEGER PRIMARY KEY, status TEXT, found_via TEXT, comp_ote INTEGER)";
      let schemaRuns = 0;
      const ran: number[] = [];
      const options = {
        version: 21,
        schema: (d: SqliteHandle) => {
          schemaRuns++;
          d.exec(SCHEMA);
        },
        steps: {
          13: (d: SqliteHandle) => {
            ran.push(13);
            addColumn(d, "apps", "found_via", "TEXT");
            addColumn(d, "apps", "comp_ote", "INTEGER");
          },
          2: () => ran.push(2),
          19: () => ran.push(19),
        },
      };
      assert.deepEqual(migrate(db, options), { from: 0, to: 21, applied: [2, 13, 19] }, "a new file runs the schema, then every step in order");
      assert.deepEqual(ran, [2, 13, 19]);
      assert.equal(schemaRuns, 1);
      assert.deepEqual(migrate(db, options), { from: 21, to: 21, applied: [] });
      assert.equal(schemaRuns, 1, "no schema run when current");

      setUserVersion(db, 15);
      ran.length = 0;
      assert.deepEqual(migrate(db, options), { from: 15, to: 21, applied: [19] });
      assert.equal(schemaRuns, 2, "the schema runs whenever the file is behind");
    });

    test("a schema file that still sets PRAGMA journal_mode is harmless (job-searcher's schema.sql)", (t) => {
      const { db } = open(t);
      migrate(db, { version: 1, schema: "PRAGMA journal_mode = WAL;\nCREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);", steps: {} });
      assert.equal(getUserVersion(db), 1);
      assert.equal(scalar(db, "PRAGMA journal_mode"), "wal");
      assert.ok(tableSql(db, "settings"));
    });

    test("no steps and no version: nothing to do", (t) => {
      const { db } = open(t);
      assert.deepEqual(migrate(db, { steps: [] }), { from: 0, to: 0, applied: [] });
    });

    test("bad step keys and a version below the highest step are refused", (t) => {
      const { db } = open(t);
      assert.throws(() => migrate(db, { steps: { 0: "SELECT 1" } }), /version number/);
      assert.throws(() => migrate(db, { steps: { 1.5: "SELECT 1" } as never }), /version number/);
      assert.throws(() => migrate(db, { steps: STEPS, version: 1 }), /below the highest step/);
      assert.equal(getUserVersion(db), 0);
    });

    test("a file newer than the code is left alone", (t) => {
      const { db } = open(t);
      setUserVersion(db, 9);
      assert.deepEqual(migrate(db, { steps: STEPS }), { from: 9, to: 9, applied: [] });
      assert.equal(tableSql(db, "releases"), undefined);
    });

    test("a step another process already applied is skipped (checked again under the write lock)", (t) => {
      const { db } = open(t);
      migrate(db, { steps: STEPS });
      // This connection read user_version before the other process committed: the first
      // read says 0. The step (a plain CREATE TABLE) would fail if it ran again.
      let first = true;
      const stale: SqliteHandle = {
        exec: (sql) => db.exec(sql),
        close: () => db.close(),
        prepare: (sql) => {
          if (first && /^PRAGMA user_version$/i.test(sql.trim())) {
            first = false;
            return { get: () => ({ user_version: 0 }), all: () => [], run: () => ({ changes: 0, lastInsertRowid: 0 }) };
          }
          return db.prepare(sql);
        },
      };
      const out = migrate(stale, { steps: STEPS });
      assert.deepEqual(out.applied, []);
      assert.equal(out.to, 2);
    });

    test("every step runs with foreign keys off: rebuilding a parent table doesn't cascade into its children", (t) => {
      const { db } = open(t);
      const RELEASES = (types: string) => `CREATE TABLE releases (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        type TEXT NOT NULL CHECK (type IN (${types}))
      )`;
      migrate(db, {
        steps: [
          `${RELEASES("'flip'")};
           CREATE TABLE tasks (id INTEGER PRIMARY KEY, release_id INTEGER NOT NULL REFERENCES releases (id) ON DELETE CASCADE);
           INSERT INTO releases (type) VALUES ('flip');
           INSERT INTO tasks (release_id) VALUES (1);`,
        ],
      });
      const steps = ["SELECT 1", (d: SqliteHandle) => rebuildTable(d, "releases", RELEASES("'flip', 'set'"))];
      assert.deepEqual(migrate(db, { steps }).applied, [2]);
      assert.equal(scalar(db, "SELECT count(*) FROM tasks"), 1, "the child rows survived");
      assert.equal(scalar(db, "PRAGMA foreign_keys"), 1, "enforcement is back on");
      db.exec("INSERT INTO releases (type) VALUES ('set')");
    });

    test("a hand-rolled rebuild that toggles foreign_keys itself is safe too (the toggle is moot)", (t) => {
      const { db } = open(t);
      migrate(db, {
        steps: [
          `CREATE TABLE p (id INTEGER PRIMARY KEY, kind TEXT CHECK (kind IN ('a')));
           CREATE TABLE c (id INTEGER PRIMARY KEY, p_id INTEGER REFERENCES p (id) ON DELETE CASCADE);
           INSERT INTO p VALUES (1, 'a'); INSERT INTO c VALUES (1, 1);`,
        ],
      });
      const steps = [
        "SELECT 1",
        (d: SqliteHandle) => {
          d.exec("PRAGMA foreign_keys = OFF");
          d.exec(`CREATE TABLE p_new (id INTEGER PRIMARY KEY, kind TEXT CHECK (kind IN ('a', 'b')));
                  INSERT INTO p_new SELECT * FROM p; DROP TABLE p; ALTER TABLE p_new RENAME TO p;`);
          d.exec("PRAGMA foreign_keys = ON");
        },
      ];
      migrate(db, { steps });
      assert.equal(scalar(db, "SELECT count(*) FROM c"), 1);
    });

    test("a step that leaves dangling references is rolled back, cascade-reliant deletes included", (t) => {
      const { db } = open(t);
      migrate(db, {
        steps: [
          `CREATE TABLE p (id INTEGER PRIMARY KEY);
           CREATE TABLE c (id INTEGER PRIMARY KEY, p_id INTEGER REFERENCES p (id) ON DELETE CASCADE);
           INSERT INTO p VALUES (1); INSERT INTO c VALUES (1, 1);`,
        ],
      });
      assert.throws(() => migrate(db, { steps: ["SELECT 1", "DELETE FROM p"] }), /foreign key check failed/);
      assert.equal(getUserVersion(db), 1);
      assert.equal(scalar(db, "SELECT count(*) FROM p"), 1);
      assert.equal(scalar(db, "PRAGMA foreign_keys"), 1);
      assert.deepEqual(migrate(db, { steps: ["SELECT 1", "DELETE FROM c; DELETE FROM p"] }).applied, [2], "deleting the children first works");
    });

    test("migrate inside the app's own transaction refuses (steps need foreign keys off)", (t) => {
      const { db } = open(t);
      transaction(db, () => {
        assert.throws(() => migrate(db, { steps: STEPS }), /outside transaction/);
      });
      assert.equal(getUserVersion(db), 0);
    });

    test("a step that isn't SQL or a function is refused", (t) => {
      const { db } = open(t);
      assert.throws(() => migrate(db, { steps: [{ up: "SELECT 1" } as never] }), TypeError);
    });
  });

  describe(`runOnce (${name})`, () => {
    test("runs a named step once and records it in migrations_applied", (t) => {
      const box = sandbox(t);
      const db = box.track(openDatabase(driver, box.file("a.db")));
      db.exec("CREATE TABLE tags (id INTEGER PRIMARY KEY, name TEXT); INSERT INTO tags (name) VALUES ('Big Tag')");
      let runs = 0;
      const step = (d: SqliteHandle) => {
        runs++;
        d.exec("UPDATE tags SET name = lower(replace(name, ' ', '-'))");
      };
      const before = Date.now();
      assert.equal(runOnce(db, "normalize_tag_names_v1", step), true);
      assert.equal(runOnce(db, "normalize_tag_names_v1", step), false);
      assert.equal(runs, 1);
      assert.equal(scalar(db, "SELECT name FROM tags"), "big-tag");
      const marker = rows(db, "SELECT name, applied_at FROM migrations_applied")[0];
      assert.equal(marker.name, "normalize_tag_names_v1");
      assert.ok(Number(marker.applied_at) >= before, "applied_at is in ms");
    });

    test("honours markers an app already wrote, and a custom table", (t) => {
      const box = sandbox(t);
      const db = box.track(openDatabase(driver, box.file("a.db")));
      db.exec("CREATE TABLE migrations_applied (name TEXT PRIMARY KEY, applied_at INTEGER NOT NULL); INSERT INTO migrations_applied VALUES ('old_one', 1)");
      assert.equal(runOnce(db, "old_one", "SELECT nonsense FROM nowhere"), false);
      assert.equal(runOnce(db, "x", "CREATE TABLE made (a)", { table: "my_markers" }), true);
      assert.equal(scalar(db, "SELECT count(*) FROM my_markers WHERE name = 'x'"), 1);
    });

    test("a failing step leaves no marker and runs again next time", (t) => {
      const box = sandbox(t);
      const db = box.track(openDatabase(driver, box.file("a.db")));
      assert.throws(() => runOnce(db, "fix", "CREATE TABLE half (a); INSERT INTO nowhere VALUES (1)"));
      assert.equal(tableSql(db, "half"), undefined);
      assert.equal(scalar(db, "SELECT count(*) FROM migrations_applied"), 0);
      assert.equal(runOnce(db, "fix", "CREATE TABLE half (a)"), true);
    });

    test("a run-once step can rebuild a parent table", (t) => {
      const box = sandbox(t);
      const db = box.track(openDatabase(driver, box.file("a.db")));
      db.exec(`CREATE TABLE p (id INTEGER PRIMARY KEY, a TEXT);
               CREATE TABLE c (id INTEGER PRIMARY KEY, p_id INTEGER REFERENCES p (id) ON DELETE CASCADE);
               INSERT INTO p VALUES (1, 'x'); INSERT INTO c VALUES (1, 1);`);
      runOnce(db, "widen_p", (d) => rebuildTable(d, "p", "CREATE TABLE p (id INTEGER PRIMARY KEY, a TEXT, b TEXT)"));
      assert.equal(scalar(db, "SELECT count(*) FROM c"), 1);
    });
  });
}

describe("migrate with better-sqlite3's own transactions inside a step", () => {
  test("db.transaction() in a step nests as a savepoint", (t) => {
    const box = sandbox(t);
    const db = box.track(openDatabase(Database, box.file("a.db")));
    migrate(db, {
      steps: [
        (d) => {
          d.exec("CREATE TABLE t (a)");
          d.transaction(() => d.prepare("INSERT INTO t VALUES (1)").run())();
          assert.equal(d.pragma("user_version", { simple: true }), 0, "the version moves with the step's commit");
        },
      ],
    });
    assert.equal(db.pragma("user_version", { simple: true }), 1);
    assert.equal(scalar(db, "SELECT count(*) FROM t"), 1);
  });
});
