import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { keyValueStore, openDatabase } from "./index.js";
import { drivers, sandbox, scalar } from "./testing/drivers.js";

for (const { name, driver } of drivers) {
  describe(`keyValueStore (${name})`, () => {
    const open = (t: Parameters<typeof sandbox>[0]) => {
      const box = sandbox(t);
      return box.track(openDatabase(driver, box.file("a.db")));
    };

    test("creates the table and stores text", (t) => {
      const db = open(t);
      const kv = keyValueStore(db);
      assert.equal(kv.get("monthly_budget"), null);
      kv.set("monthly_budget", "200");
      assert.equal(kv.get("monthly_budget"), "200");
      kv.set("monthly_budget", "250");
      assert.equal(kv.get("monthly_budget"), "250");
      assert.equal(scalar(db, "SELECT count(*) FROM settings"), 1);
    });

    test("JSON values, with the fallback for missing and malformed ones", (t) => {
      const db = open(t);
      const kv = keyValueStore(db, "kv_store");
      kv.setJson("targets", { floor: 1500, list: [1, 2] });
      assert.deepEqual(kv.getJson("targets", {}), { floor: 1500, list: [1, 2] });
      assert.equal(kv.get("targets"), '{"floor":1500,"list":[1,2]}');
      assert.deepEqual(kv.getJson("missing", ["d"]), ["d"]);
      kv.set("broken", "{oops");
      assert.equal(kv.getJson("broken", "fb"), "fb");
      kv.setJson("nothing", undefined);
      assert.equal(kv.get("nothing"), "null");
      assert.equal(kv.getJson("nothing", 7), 7);
      assert.throws(() => kv.set("n", 5 as never), TypeError);
    });

    test("has, delete, all and clear", (t) => {
      const db = open(t);
      const kv = keyValueStore(db, "meta");
      kv.set("b", "2");
      kv.set("a", "1");
      kv.set("__proto__", "p");
      assert.equal(kv.has("a"), true);
      assert.equal(kv.has("zz"), false);
      const all = kv.all();
      assert.deepEqual(Object.keys(all), ["__proto__", "a", "b"]);
      assert.equal(all.__proto__, "p");
      assert.equal(kv.delete("a"), true);
      assert.equal(kv.delete("a"), false);
      kv.clear();
      assert.deepEqual(kv.all(), {});
    });

    test("an app's own table with an updated_at default: every write refreshes it", (t) => {
      const db = open(t);
      db.exec("CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL DEFAULT 0)");
      db.exec("INSERT INTO settings (key, value, updated_at) VALUES ('k', 'old', 0)");
      const kv = keyValueStore(db);
      kv.set("k", "new");
      assert.equal(kv.get("k"), "new");
      assert.equal(scalar(db, "SELECT updated_at FROM settings WHERE key = 'k'"), 0, "the default applied again");
      db.exec("UPDATE settings SET updated_at = 5");
      kv.set("k", "newer");
      assert.equal(scalar(db, "SELECT updated_at FROM settings WHERE key = 'k'"), 0);
    });

    test("create: false uses an existing table and fails on a missing one", (t) => {
      const db = open(t);
      const missing = keyValueStore(db, "nowhere", { create: false });
      assert.throws(() => missing.get("x"), /no such table/);
      db.exec("CREATE TABLE prefs (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
      const kv = keyValueStore(db, "prefs", { create: false });
      kv.set("x", "1");
      assert.equal(kv.get("x"), "1");
    });

    test("two stores on one table see each other's writes", (t) => {
      const db = open(t);
      const a = keyValueStore(db);
      const b = keyValueStore(db);
      a.set("k", "v");
      assert.equal(b.get("k"), "v");
    });
  });
}
