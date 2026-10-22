import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { addColumn, hasColumn, listTables, openDatabase, placeholders, quoteIdent, rebuildTable, tableSql, transaction, withForeignKeysOff } from "./index.js";
import { drivers, rows, sandbox, scalar } from "./testing/drivers.js";

describe("quoteIdent and placeholders", () => {
  test("quoteIdent doubles embedded quotes", () => {
    assert.equal(quoteIdent("plain"), '"plain"');
    assert.equal(quoteIdent('my "table"'), '"my ""table"""');
  });

  test("placeholders for a list or a count", () => {
    assert.equal(placeholders([1, 2, 3]), "?, ?, ?");
    assert.equal(placeholders(2), "?, ?");
    assert.equal(placeholders([]), "");
    assert.throws(() => placeholders(-1));
    assert.throws(() => placeholders(1.5));
  });
});

for (const { name, driver } of drivers) {
  describe(`schema helpers (${name})`, () => {
    const open = (t: Parameters<typeof sandbox>[0], options = {}) => {
      const box = sandbox(t);
      return box.track(openDatabase(driver, box.file("a.db"), options));
    };

    test("placeholders binds an IN list", (t) => {
      const db = open(t);
      db.exec("CREATE TABLE t (a); INSERT INTO t VALUES (1), (2), (3)");
      const ids = [1, 3];
      assert.equal(scalar(db, `SELECT count(*) FROM t WHERE a IN (${placeholders(ids)})`, ...ids), 2);
      assert.equal(scalar(db, `SELECT count(*) FROM t WHERE a IN (${placeholders([])})`), 0, "an empty list matches nothing");
    });

    test("listTables and tableSql", (t) => {
      const db = open(t);
      db.exec("CREATE TABLE b (id INTEGER PRIMARY KEY AUTOINCREMENT); CREATE TABLE a (x); INSERT INTO b DEFAULT VALUES; CREATE VIEW v AS SELECT * FROM a");
      assert.deepEqual(listTables(db), ["a", "b"], "sqlite_sequence and views are not listed");
      assert.equal(tableSql(db, "a"), "CREATE TABLE a (x)");
      assert.equal(tableSql(db, "missing"), undefined);
      assert.equal(tableSql(db, "v"), undefined, "a view is not a table");
    });

    test("addColumn adds once, reports whether it did, and fails on a missing table", (t) => {
      const db = open(t);
      db.exec("CREATE TABLE videos (id TEXT PRIMARY KEY)");
      assert.equal(hasColumn(db, "videos", "score"), false);
      assert.equal(addColumn(db, "videos", "score", "REAL DEFAULT 1000"), true);
      assert.equal(addColumn(db, "videos", "score", "REAL DEFAULT 1000"), false);
      assert.equal(hasColumn(db, "videos", "score"), true);
      db.exec("INSERT INTO videos (id) VALUES ('v')");
      assert.equal(scalar(db, "SELECT score FROM videos"), 1000);
      assert.equal(hasColumn(db, "missing", "x"), false);
      assert.throws(() => addColumn(db, "missing", "x", "TEXT"), /no such table/);
    });

    test("addColumn: a column another process added between the check and the ALTER is fine", (t) => {
      const db = open(t);
      db.exec("CREATE TABLE videos (id TEXT PRIMARY KEY, score REAL)");
      let first = true;
      const stale = {
        exec: (sql: string) => db.exec(sql),
        close: () => db.close(),
        prepare: (sql: string) => {
          if (first && sql.includes("pragma_table_info")) {
            first = false;
            return { get: () => undefined, all: () => [], run: () => ({ changes: 0, lastInsertRowid: 0 }) };
          }
          return db.prepare(sql);
        },
      };
      assert.equal(addColumn(stale, "videos", "score", "REAL"), false);
      assert.throws(() => addColumn(db, "videos", "bad", "NOT A TYPE ((("), /syntax|error/i, "a real failure still throws");
    });

    test("addColumn with names that need quoting", (t) => {
      const db = open(t);
      db.exec('CREATE TABLE "odd table" (id INTEGER)');
      assert.equal(addColumn(db, "odd table", "group", "TEXT NOT NULL DEFAULT ''"), true);
      assert.equal(hasColumn(db, "odd table", "group"), true);
    });

    test("withForeignKeysOff: drop and recreate a parent without cascading, enforcement restored", (t) => {
      const db = open(t);
      db.exec(`CREATE TABLE p (id INTEGER PRIMARY KEY);
               CREATE TABLE c (id INTEGER PRIMARY KEY, p_id INTEGER REFERENCES p (id) ON DELETE CASCADE);
               INSERT INTO p VALUES (1); INSERT INTO c VALUES (1, 1);`);
      const out = withForeignKeysOff(db, () => {
        db.exec("CREATE TABLE p2 (id INTEGER PRIMARY KEY); INSERT INTO p2 SELECT * FROM p; DROP TABLE p; ALTER TABLE p2 RENAME TO p");
        return "ok";
      });
      assert.equal(out, "ok");
      assert.equal(scalar(db, "SELECT count(*) FROM c"), 1);
      assert.equal(scalar(db, "PRAGMA foreign_keys"), 1);
    });

    test("withForeignKeysOff: new dangling references roll back; old ones don't block", (t) => {
      const db = open(t, { foreignKeys: false });
      db.exec(`CREATE TABLE p (id INTEGER PRIMARY KEY);
               CREATE TABLE c (id INTEGER PRIMARY KEY, p_id INTEGER REFERENCES p (id));
               INSERT INTO p VALUES (1), (2); INSERT INTO c VALUES (1, 1), (2, 2), (3, 99);`);
      withForeignKeysOff(db, () => db.exec("UPDATE c SET id = id + 10"));
      assert.throws(() => withForeignKeysOff(db, () => db.exec("DELETE FROM p WHERE id = 1")), /1 new dangling/);
      assert.equal(scalar(db, "SELECT count(*) FROM p"), 2, "rolled back");
      assert.equal(scalar(db, "PRAGMA foreign_keys"), 0, "a connection that had them off keeps them off");
    });

    test("withForeignKeysOff inside a transaction with enforcement on refuses, and enforcement stays on", (t) => {
      const db = open(t);
      db.exec("CREATE TABLE p (id INTEGER PRIMARY KEY)");
      transaction(db, () => {
        assert.throws(() => withForeignKeysOff(db, () => undefined), /outside transaction/);
      });
      assert.equal(scalar(db, "PRAGMA foreign_keys"), 1);
    });

    test("withForeignKeysOff restores enforcement when the callback throws", (t) => {
      const db = open(t);
      assert.throws(() =>
        withForeignKeysOff(db, () => {
          throw new Error("x");
        }),
      );
      assert.equal(scalar(db, "PRAGMA foreign_keys"), 1);
    });

    describe("rebuildTable", () => {
      const SCHEMA = `
        CREATE TABLE applications (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          status TEXT NOT NULL CHECK (status IN ('Draft','Applied')),
          kind TEXT,
          legacy TEXT
        );
        CREATE INDEX applications_status ON applications (status);
        CREATE TABLE events (id INTEGER PRIMARY KEY, application_id INTEGER NOT NULL REFERENCES applications (id) ON DELETE CASCADE);
        CREATE TABLE log (msg TEXT);
        CREATE TRIGGER applications_log AFTER UPDATE ON applications BEGIN INSERT INTO log VALUES (new.status); END;
        CREATE TRIGGER events_log AFTER INSERT ON events BEGIN INSERT INTO log SELECT status FROM applications WHERE id = new.application_id; END;
        CREATE VIEW drafts AS SELECT * FROM applications WHERE status = 'Draft';
        INSERT INTO applications (status, kind, legacy) VALUES ('Draft', 'Demo', 'x'), ('Applied', 'Technical', 'y'), ('Draft', NULL, 'z');
        INSERT INTO events (application_id) VALUES (1), (2), (3);
        DELETE FROM applications WHERE id = 3;
      `;
      const NEW = `CREATE TABLE IF NOT EXISTS applications (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          status TEXT NOT NULL CHECK (status IN ('Draft','Applied','Closed')),
          kind TEXT,
          found_via TEXT NOT NULL DEFAULT 'unknown'
        )`;

      test("widens a CHECK, keeps rows, children, indexes, triggers, views and the AUTOINCREMENT mark", (t) => {
        const db = open(t);
        db.exec(SCHEMA);
        db.exec("INSERT INTO log VALUES ('start')");
        rebuildTable(db, "applications", NEW, { map: { kind: "CASE kind WHEN 'Demo' THEN 'Presentation' ELSE kind END" } });

        assert.deepEqual(rows(db, "SELECT id, status, kind, found_via FROM applications ORDER BY id"), [
          { id: 1, status: "Draft", kind: "Presentation", found_via: "unknown" },
          { id: 2, status: "Applied", kind: "Technical", found_via: "unknown" },
        ]);
        assert.equal(scalar(db, "SELECT count(*) FROM events"), 2, "children kept (3 went with its parent before the rebuild)");
        assert.equal(hasColumn(db, "applications", "legacy"), false, "a column the new shape drops is gone");
        db.exec("UPDATE applications SET status = 'Closed' WHERE id = 2");
        assert.equal(scalar(db, "SELECT msg FROM log ORDER BY rowid DESC LIMIT 1"), "Closed", "trigger on the table recreated");
        db.exec("INSERT INTO events (application_id) VALUES (1)");
        assert.equal(scalar(db, "SELECT msg FROM log ORDER BY rowid DESC LIMIT 1"), "Draft", "trigger on another table still reads it");
        assert.equal(scalar(db, "SELECT count(*) FROM drafts"), 1, "view still works");
        assert.ok(scalar(db, "SELECT sql FROM sqlite_master WHERE name = 'applications_status'"), "index recreated");
        db.exec("INSERT INTO applications (status) VALUES ('Draft')");
        assert.equal(scalar(db, "SELECT max(id) FROM applications"), 4, "id 3 is never reused");
        assert.equal(scalar(db, "PRAGMA foreign_keys"), 1);
        assert.equal(scalar(db, "PRAGMA legacy_alter_table"), 0);
        assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
        assert.equal(scalar(db, "PRAGMA integrity_check"), "ok");
        assert.equal(tableSql(db, "applications__rebuild"), undefined);
        assert.match(String(tableSql(db, "applications")), /'Closed'/);
      });

      test("keeps the AUTOINCREMENT mark of a table whose rows were all deleted", (t) => {
        const db = open(t);
        db.exec("CREATE TABLE q (id INTEGER PRIMARY KEY AUTOINCREMENT, a TEXT); INSERT INTO q (a) VALUES ('x'), ('y'); DELETE FROM q");
        rebuildTable(db, "q", "CREATE TABLE q (id INTEGER PRIMARY KEY AUTOINCREMENT, a TEXT, b TEXT)");
        db.exec("INSERT INTO q (a) VALUES ('z')");
        assert.equal(scalar(db, "SELECT id FROM q"), 3);
      });

      test("explicit indexes replace the old ones", (t) => {
        const db = open(t);
        db.exec(SCHEMA);
        rebuildTable(db, "applications", NEW, { indexes: ["CREATE INDEX applications_kind ON applications (kind)"] });
        assert.equal(scalar(db, "SELECT count(*) FROM sqlite_master WHERE name = 'applications_status'"), 0);
        assert.equal(scalar(db, "SELECT count(*) FROM sqlite_master WHERE name = 'applications_kind'"), 1);
      });

      test("a rebuild that would break references changes nothing", (t) => {
        const db = open(t);
        db.exec(SCHEMA);
        const before = rows(db, "SELECT * FROM applications ORDER BY id");
        assert.throws(() => rebuildTable(db, "applications", NEW, { map: { id: "id + 100" } }), /dangling/);
        assert.deepEqual(rows(db, "SELECT * FROM applications ORDER BY id"), before);
        assert.match(String(tableSql(db, "applications")), /legacy/);
        assert.equal(tableSql(db, "applications__rebuild"), undefined);
        assert.equal(scalar(db, "PRAGMA foreign_keys"), 1);
      });

      test("refuses a missing table, a non-CREATE statement and a map to an unknown column", (t) => {
        const db = open(t);
        db.exec(SCHEMA);
        assert.throws(() => rebuildTable(db, "nope", NEW), /no table nope/);
        assert.throws(() => rebuildTable(db, "applications", "DROP TABLE applications"), /CREATE TABLE/);
        assert.throws(() => rebuildTable(db, "applications", NEW, { map: { nope: "1" } }), /nope/);
        assert.match(String(tableSql(db, "applications")), /legacy/);
      });

      test("refuses inside a transaction while foreign keys are on", (t) => {
        const db = open(t);
        db.exec(SCHEMA);
        transaction(db, () => {
          assert.throws(() => rebuildTable(db, "applications", NEW), /outside transaction/);
        });
        assert.equal(scalar(db, "SELECT count(*) FROM events"), 2);
      });
    });
  });
}
