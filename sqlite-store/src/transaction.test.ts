import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { openDatabase, transaction } from "./index.js";
import { Database, drivers, sandbox, scalar } from "./testing/drivers.js";
import type { SqliteHandle, SqliteStatement } from "./types.js";

for (const { name, driver } of drivers) {
  describe(`transaction (${name})`, () => {
    const setup = (t: Parameters<typeof sandbox>[0]) => {
      const box = sandbox(t);
      const db = box.track(openDatabase(driver, box.file("a.db")));
      db.exec("CREATE TABLE t (a INTEGER)");
      return { box, db, count: () => scalar(db, "SELECT count(*) FROM t") };
    };

    test("commits and returns the callback's value", (t) => {
      const { db, count } = setup(t);
      const out = transaction(db, () => {
        db.prepare("INSERT INTO t VALUES (?)").run(1);
        return "done";
      });
      assert.equal(out, "done");
      assert.equal(count(), 1);
    });

    test("rolls back and rethrows the same error", (t) => {
      const { db, count } = setup(t);
      const boom = new Error("boom");
      assert.throws(
        () =>
          transaction(db, () => {
            db.prepare("INSERT INTO t VALUES (?)").run(1);
            throw boom;
          }),
        (e) => e === boom,
      );
      assert.equal(count(), 0);
      transaction(db, () => db.prepare("INSERT INTO t VALUES (?)").run(2));
      assert.equal(count(), 1, "the connection is usable afterwards");
    });

    test("a nested call is a savepoint: its failure undoes only its own work", (t) => {
      const { db } = setup(t);
      transaction(db, () => {
        db.prepare("INSERT INTO t VALUES (?)").run(1);
        assert.throws(() =>
          transaction(db, () => {
            db.prepare("INSERT INTO t VALUES (?)").run(2);
            throw new Error("inner");
          }),
        );
        transaction(db, () => db.prepare("INSERT INTO t VALUES (?)").run(3));
      });
      assert.deepEqual(
        (db.prepare("SELECT a FROM t ORDER BY a").all() as { a: number }[]).map((r) => r.a),
        [1, 3],
      );
    });

    test("an outer failure undoes committed savepoints too", (t) => {
      const { db, count } = setup(t);
      assert.throws(() =>
        transaction(db, () => {
          transaction(db, () => db.prepare("INSERT INTO t VALUES (?)").run(1));
          throw new Error("outer");
        }),
      );
      assert.equal(count(), 0);
    });

    test("a callback that returns a promise is rolled back and refused", async (t) => {
      const { db, count } = setup(t);
      assert.throws(
        () =>
          transaction(db, async () => {
            db.prepare("INSERT INTO t VALUES (?)").run(1);
          }),
        TypeError,
      );
      assert.equal(count(), 0);
    });

    test("immediate (the default) takes the write lock up front; deferred waits for the first write", (t) => {
      const { box, db } = setup(t);
      const other = box.track(openDatabase(driver, box.file("a.db"), { busyTimeout: 0 }));
      transaction(db, () => {
        assert.throws(() => other.exec("INSERT INTO t VALUES (9)"), /locked|busy/i);
      });
      transaction(
        db,
        () => {
          other.exec("INSERT INTO t VALUES (9)");
        },
        { mode: "deferred" },
      );
      assert.equal(scalar(db, "SELECT count(*) FROM t"), 1);
    });
  });
}

describe("transaction with better-sqlite3's own db.transaction()", () => {
  test("ours inside theirs, and theirs inside ours, nest as savepoints", (t) => {
    const box = sandbox(t);
    const db = box.track(openDatabase(Database, box.file("a.db")));
    db.exec("CREATE TABLE t (a INTEGER)");
    const insert = db.prepare("INSERT INTO t VALUES (?)");
    db.transaction(() => {
      insert.run(1);
      assert.throws(() =>
        transaction(db, () => {
          insert.run(2);
          throw new Error("inner");
        }),
      );
    })();
    transaction(db, () => {
      insert.run(3);
      assert.throws(() =>
        db.transaction(() => {
          insert.run(4);
          throw new Error("inner");
        })(),
      );
    });
    assert.deepEqual(
      (db.prepare("SELECT a FROM t ORDER BY a").all() as { a: number }[]).map((r) => r.a),
      [1, 3],
    );
  });
});

describe("transaction on a handle without native transaction flags", () => {
  test("tracks nesting itself", () => {
    const log: string[] = [];
    const stmt: SqliteStatement = { run: () => ({ changes: 0, lastInsertRowid: 0 }), get: () => undefined, all: () => [] };
    const fake: SqliteHandle = { exec: (sql: string) => log.push(sql), prepare: () => stmt, close: () => undefined };
    transaction(fake, () => {
      transaction(fake, () => undefined);
      assert.throws(() =>
        transaction(fake, () => {
          throw new Error("x");
        }),
      );
    });
    transaction(fake, () => undefined, { mode: "exclusive" });
    assert.deepEqual(
      log.map((s) => s.replace(/sqlite_store_sp\d+/, "SP")),
      ["BEGIN IMMEDIATE", "SAVEPOINT SP", "RELEASE SP", "SAVEPOINT SP", "ROLLBACK TO SP", "RELEASE SP", "COMMIT", "BEGIN EXCLUSIVE", "COMMIT"],
    );
  });
});
