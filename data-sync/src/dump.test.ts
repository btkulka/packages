import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { openDatabase } from "@btkulka/sqlite-store";
import { dumpDatabase, restoreSnapshot } from "./index.js";
import { drivers, sandbox, SCHEMA } from "./testing/drivers.js";

for (const { name, driver } of drivers) {
  describe(`dumpDatabase (${name})`, () => {
    test("the same rows written in a different order give the same bytes", (t) => {
      const box = sandbox(t);
      const a = box.track(openDatabase(driver, box.file("a.db")));
      const b = box.track(openDatabase(driver, box.file("b.db")));
      a.exec(SCHEMA);
      b.exec(SCHEMA);
      a.exec(`INSERT INTO settings VALUES ('theme','night'); INSERT INTO settings VALUES ('accent','gold');`);
      b.exec(`INSERT INTO settings VALUES ('accent','gold'); INSERT INTO settings VALUES ('theme','night');`);
      assert.equal(dumpDatabase(a).sha, dumpDatabase(b).sha);
      b.exec(`UPDATE settings SET value = 'day' WHERE key = 'theme'`);
      assert.notEqual(dumpDatabase(a).sha, dumpDatabase(b).sha);
    });

    test("round-trips values, counters and user_version, and no trigger fires on the way in", (t) => {
      const box = sandbox(t);
      const src = box.track(openDatabase(driver, box.file("src.db")));
      src.exec(SCHEMA);
      src.exec(`INSERT INTO settings VALUES ('touch', 'no')`);
      src.prepare("INSERT INTO habits (name, goal, icon) VALUES (?, ?, ?)").run("Read 'n' write", 1.5, Buffer.from([0, 1, 254, 255]));
      src.prepare("INSERT INTO habits (name, goal, icon) VALUES (?, ?, ?)").run("Gone", null, null);
      src.exec(`DELETE FROM habits WHERE name = 'Gone'`);
      src.exec(`INSERT INTO checkins (habit_id, day, value) VALUES (1, '2026-11-09', 3)`);
      const d = dumpDatabase(src);
      assert.deepEqual(d.rows, { cache: 0, checkins: 1, habits: 1, settings: 1 });
      assert.equal(d.schemaVersion, 3);

      restoreSnapshot(driver, d.sql, box.file("dst.db"), { backupDir: box.file("backups") });
      const dst = box.track(openDatabase(driver, box.file("dst.db")));
      const h = { ...(dst.prepare("SELECT * FROM habits").get() as Record<string, unknown>) };
      assert.equal(h.name, "Read 'n' write");
      assert.equal(h.goal, 1.5);
      assert.deepEqual([...(h.icon as Uint8Array)], [0, 1, 254, 255]);
      assert.equal((dst.prepare("SELECT value FROM settings WHERE key = 'touch'").get() as { value: string }).value, "no");
      // The deleted habit's id stays used: the next one is 3, not 2.
      dst.exec(`INSERT INTO habits (name) VALUES ('Next')`);
      assert.equal((dst.prepare("SELECT max(id) AS id FROM habits").get() as { id: number }).id, 3);
      assert.equal((dst.prepare("PRAGMA user_version").get() as { user_version: number }).user_version, 3);
      assert.equal(dumpDatabase(dst).rows.habits, 2);
    });

    test("an excluded table's rows stay out, and a restore keeps this machine's", (t) => {
      const box = sandbox(t);
      const src = box.track(openDatabase(driver, box.file("src.db")));
      src.exec(SCHEMA);
      src.exec(`INSERT INTO cache VALUES ('k', 'theirs'); INSERT INTO settings VALUES ('a', '1');`);
      const d = dumpDatabase(src, { exclude: ["cache"] });
      assert.ok(!d.sql.includes("theirs"));
      assert.equal(d.rows.cache, undefined);

      const here = openDatabase(driver, box.file("here.db"));
      here.exec(SCHEMA);
      here.exec(`INSERT INTO cache VALUES ('k', 'mine')`);
      here.close();
      const { backup } = restoreSnapshot(driver, d.sql, box.file("here.db"), { backupDir: box.file("backups"), keep: ["cache"] });
      assert.ok(backup);
      const after = box.track(openDatabase(driver, box.file("here.db")));
      assert.equal((after.prepare("SELECT value FROM cache").get() as { value: string }).value, "mine");
      assert.equal((after.prepare("SELECT value FROM settings").get() as { value: string }).value, "1");
    });

    test("refuses virtual tables rather than writing a dump that won't restore", (t) => {
      const box = sandbox(t);
      const db = box.track(openDatabase(driver, box.file("v.db")));
      try {
        db.exec(`CREATE VIRTUAL TABLE notes USING fts5(body)`);
      } catch {
        t.skip("no FTS5 in this build");
        return;
      }
      assert.throws(() => dumpDatabase(db), /virtual tables/);
    });
  });
}
