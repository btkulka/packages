import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { describe, test } from "node:test";
import { lazyDatabase, openDatabase } from "./index.js";
import { drivers, sandbox, scalar } from "./testing/drivers.js";
import type { SqliteDriver, SqliteHandle } from "./types.js";

for (const { name, driver } of drivers) {
  describe(`openDatabase (${name})`, () => {
    test("creates the directory, applies WAL, foreign keys, busy timeout and synchronous=NORMAL", (t) => {
      const box = sandbox(t);
      const file = box.file("nested", "deeper", "app.db");
      const db = box.track(openDatabase(driver, file));
      assert.ok(db instanceof driver, "returns the driver's own handle");
      assert.ok(existsSync(file));
      assert.equal(scalar(db, "PRAGMA journal_mode"), "wal");
      assert.equal(scalar(db, "PRAGMA foreign_keys"), 1);
      assert.equal(scalar(db, "PRAGMA busy_timeout"), 5000);
      assert.equal(scalar(db, "PRAGMA synchronous"), 1);
    });

    test("a path with spaces and non-ASCII characters (%APPDATA%\\Benhäus)", (t) => {
      const box = sandbox(t);
      const file = box.file("Benhäus data", "tëst db.db");
      const db = box.track(openDatabase(driver, file));
      db.exec("CREATE TABLE t (a)");
      assert.ok(existsSync(file));
      assert.ok(existsSync(`${file}-wal`), "WAL sidecar beside it");
    });

    test("in-memory: no directory, no WAL, foreign keys on", (t) => {
      const box = sandbox(t);
      const db = box.track(openDatabase(driver, ":memory:"));
      assert.equal(scalar(db, "PRAGMA journal_mode"), "memory");
      assert.equal(scalar(db, "PRAGMA foreign_keys"), 1);
      db.exec("CREATE TABLE t (a)");
    });

    test("journalMode false leaves the file's mode, and synchronous with it", (t) => {
      const box = sandbox(t);
      const db = box.track(openDatabase(driver, box.file("a.db"), { journalMode: false }));
      assert.equal(scalar(db, "PRAGMA journal_mode"), "delete");
      assert.equal(scalar(db, "PRAGMA synchronous"), 2, "FULL, SQLite's default outside WAL");
    });

    test("explicit journal mode, synchronous, busy timeout, foreign keys and extra pragmas", (t) => {
      const box = sandbox(t);
      const db = box.track(
        openDatabase(driver, box.file("a.db"), {
          journalMode: "truncate",
          synchronous: "full",
          busyTimeout: 10000,
          foreignKeys: false,
          pragmas: { cache_size: -32000, temp_store: "MEMORY", recursive_triggers: true },
        }),
      );
      assert.equal(scalar(db, "PRAGMA journal_mode"), "truncate");
      assert.equal(scalar(db, "PRAGMA synchronous"), 2);
      assert.equal(scalar(db, "PRAGMA busy_timeout"), 10000);
      assert.equal(scalar(db, "PRAGMA foreign_keys"), 0);
      assert.equal(scalar(db, "PRAGMA cache_size"), -32000);
      assert.equal(scalar(db, "PRAGMA temp_store"), 2);
      assert.equal(scalar(db, "PRAGMA recursive_triggers"), 1);
    });

    test("refuses option values that would be spliced into SQL", (t) => {
      const box = sandbox(t);
      assert.throws(() => openDatabase(driver, box.file("a.db"), { journalMode: "wal; DROP TABLE x" as never }), /journalMode/);
      assert.throws(() => openDatabase(driver, box.file("b.db"), { pragmas: { "cache_size = 1; --": 1 } }), /pragma name/);
      assert.throws(() => openDatabase(driver, box.file("c.db"), { pragmas: { temp_store: "MEMORY; DROP" } }), /bare keyword/);
      assert.throws(() => openDatabase(driver, box.file("d.db"), { busyTimeout: -1 }), /busyTimeout/);
      assert.throws(() => openDatabase(driver, 42 as never), TypeError);
    });

    test("readOnly: a missing file fails clearly and creates nothing", (t) => {
      const box = sandbox(t);
      const file = box.file("missing", "x.db");
      assert.throws(
        () => openDatabase(driver, file, { readOnly: true }),
        (e: Error & { code?: string }) => e.code === "SQLITE_CANTOPEN" && e.message.includes(file),
      );
      assert.equal(existsSync(box.file("missing")), false, "no directory made");
    });

    test("readOnly: reads, refuses writes, and leaves the journal mode alone", (t) => {
      const box = sandbox(t);
      const file = box.file("a.db");
      const rw = openDatabase(driver, file, { journalMode: "delete" });
      rw.exec("CREATE TABLE t (a); INSERT INTO t VALUES (1)");
      rw.close();
      const ro = box.track(openDatabase(driver, file, { readOnly: true }));
      assert.equal(scalar(ro, "SELECT count(*) FROM t"), 1);
      assert.equal(scalar(ro, "PRAGMA journal_mode"), "delete");
      assert.throws(() => ro.exec("INSERT INTO t VALUES (2)"), /readonly/i);
    });

    test("readOnly on a WAL file another connection is writing", (t) => {
      const box = sandbox(t);
      const file = box.file("a.db");
      const rw = box.track(openDatabase(driver, file));
      rw.exec("CREATE TABLE t (a); INSERT INTO t VALUES (1)");
      const ro = box.track(openDatabase(driver, file, { readOnly: true }));
      rw.exec("INSERT INTO t VALUES (2)");
      assert.equal(scalar(ro, "SELECT count(*) FROM t"), 2);
    });

    test("fileMustExist: fails on a missing file without creating it", (t) => {
      const box = sandbox(t);
      const file = box.file("x.db");
      assert.throws(() => openDatabase(driver, file, { fileMustExist: true }), /not found/);
      assert.equal(existsSync(file), false);
      openDatabase(driver, file).close();
      const db = box.track(openDatabase(driver, file, { fileMustExist: true }));
      db.exec("CREATE TABLE t (a)");
    });

    test("mkdir: false leaves a missing directory missing", (t) => {
      const box = sandbox(t);
      assert.throws(() => openDatabase(driver, box.file("nope", "x.db"), { mkdir: false }));
      assert.equal(existsSync(box.file("nope")), false);
    });

    test("init runs after the pragmas; when it throws the handle is closed", (t) => {
      const box = sandbox(t);
      let seen: unknown;
      const db = box.track(
        openDatabase(driver, box.file("a.db"), {
          init: (d) => {
            seen = scalar(d, "PRAGMA journal_mode");
            d.exec("CREATE TABLE t (a)");
          },
        }),
      );
      assert.equal(seen, "wal");
      assert.equal(scalar(db, "SELECT count(*) FROM t"), 0);

      let closed = 0;
      const Base = driver as unknown as new (path: string, options?: unknown) => SqliteHandle;
      class Spy extends Base {
        close() {
          closed++;
          return super.close();
        }
      }
      const boom = new Error("migration failed");
      assert.throws(
        () =>
          openDatabase(Spy as unknown as SqliteDriver<SqliteHandle>, box.file("b.db"), {
            init: () => {
              throw boom;
            },
          }),
        (e) => e === boom,
      );
      assert.equal(closed, 1);
    });
  });

  describe(`lazyDatabase (${name})`, () => {
    test("opens on first get, shares the handle, reopens after close", (t) => {
      const box = sandbox(t);
      let opens = 0;
      const lazy = lazyDatabase(() => {
        opens++;
        return box.track(openDatabase(driver, box.file("a.db")));
      });
      assert.equal(lazy.isOpen, false);
      assert.equal(opens, 0, "nothing opened before the first get");
      const a = lazy.get();
      const { get } = lazy;
      assert.equal(get(), a, "a detached get still returns the shared handle");
      assert.equal(opens, 1);
      assert.equal(lazy.isOpen, true);
      lazy.close();
      lazy.close();
      assert.equal(lazy.isOpen, false);
      const b = lazy.get();
      assert.notEqual(b, a);
      assert.equal(opens, 2);
      b.exec("CREATE TABLE IF NOT EXISTS t (a)");
    });

    test("close before any get is a no-op", () => {
      const lazy = lazyDatabase(() => {
        throw new Error("should not open");
      });
      lazy.close();
      assert.equal(lazy.isOpen, false);
    });

    test("a factory that throws caches nothing, so the next get tries again", (t) => {
      const box = sandbox(t);
      let attempts = 0;
      const lazy = lazyDatabase(() => {
        attempts++;
        if (attempts === 1) throw new Error("first open fails");
        return box.track(openDatabase(driver, box.file("a.db")));
      });
      assert.throws(() => lazy.get(), /first open fails/);
      assert.equal(lazy.isOpen, false);
      lazy.get().exec("CREATE TABLE t (a)");
      assert.equal(attempts, 2);
    });
  });
}
