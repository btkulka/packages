import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { describe, test } from "node:test";
import { openDatabase, type SqliteDriver, type SqliteHandle } from "@btkulka/sqlite-store";
import { createDataSync, readHistory, type SyncStatus } from "./index.js";
import { drivers, sandbox, SCHEMA, type Sandbox } from "./testing/drivers.js";

const quiet = () => {};

function machine(box: Sandbox, driver: SqliteDriver<SqliteHandle>, name: string, extra: { schemaVersion?: number; exclude?: string[] } = {}) {
  const dbPath = box.file(name, "app.db");
  const told: string[] = [];
  const sync = createDataSync({ app: "habits", dbPath, driver, dir: box.file("sync"), machine: name, log: quiet, notify: (m: string, _s: SyncStatus) => told.push(m), ...extra });
  const open = () => box.track(openDatabase(driver, dbPath, { init: (db) => db.exec(`CREATE TABLE IF NOT EXISTS habits (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL)`) }));
  return { sync, dbPath, told, open };
}

const names = (db: SqliteHandle) => (db.prepare("SELECT name FROM habits ORDER BY id").all() as { name: string }[]).map((r) => r.name);

for (const { name, driver } of drivers) {
  describe(`createDataSync (${name})`, () => {
    test("the first machine pushes; a new machine pulls before it opens", (t) => {
      const box = sandbox(t);
      const a = machine(box, driver, "zagreus");
      const b = machine(box, driver, "macbook");

      assert.equal(a.sync.prepare().action, "none");
      const dbA = a.open();
      dbA.exec(`INSERT INTO habits (name) VALUES ('Read'), ('Run')`);
      assert.equal(a.sync.push(dbA).action, "pushed");
      assert.equal(a.sync.push(dbA).action, "up-to-date");
      dbA.close();

      const r = b.sync.prepare();
      assert.equal(r.action, "pulled");
      assert.equal(r.status.verdict, "in-sync");
      assert.deepEqual(names(b.open()), ["Read", "Run"]);
      assert.equal(b.sync.status().verdict, "in-sync");
    });

    test("whoever changed last is pushed and the other pulls, back and forth", (t) => {
      const box = sandbox(t);
      const a = machine(box, driver, "zagreus");
      const b = machine(box, driver, "macbook");
      let dbA = a.open();
      dbA.exec(`INSERT INTO habits (name) VALUES ('Read')`);
      a.sync.push(dbA);
      dbA.close();

      b.sync.prepare();
      const dbB = b.open();
      dbB.exec(`INSERT INTO habits (name) VALUES ('Stretch')`);
      assert.equal(b.sync.push(dbB).action, "pushed");
      dbB.close();

      assert.equal(a.sync.status().verdict, "remote-ahead");
      assert.equal(a.sync.prepare().action, "pulled");
      dbA = a.open();
      assert.deepEqual(names(dbA), ["Read", "Stretch"]);
      assert.equal(a.sync.push(dbA).action, "up-to-date");
    });

    test("both changed: held, this copy backed up, Ben told, and nothing moves until he picks", (t) => {
      const box = sandbox(t);
      const a = machine(box, driver, "zagreus");
      const b = machine(box, driver, "macbook");
      let dbA = a.open();
      dbA.exec(`INSERT INTO habits (name) VALUES ('Read')`);
      a.sync.push(dbA);
      b.sync.prepare();
      const dbB = b.open();

      dbB.exec(`INSERT INTO habits (name) VALUES ('Mac')`);
      b.sync.push(dbB);
      dbA.exec(`INSERT INTO habits (name) VALUES ('PC')`);
      const held = a.sync.push(dbA);
      assert.equal(held.action, "held");
      assert.ok(held.status.conflict?.backup && existsSync(held.status.conflict.backup));
      assert.equal(a.told.length, 1);
      assert.match(a.told[0], /zagreus and macbook both changed habits/);

      // Held: more writes here don't push, and a restart doesn't pull.
      dbA.exec(`INSERT INTO habits (name) VALUES ('PC again')`);
      assert.equal(a.sync.push(dbA).action, "held");
      dbA.close();
      assert.equal(a.sync.prepare().action, "held");

      // Ben keeps the Mac's: it's restored at the next start, and the PC's copy is backed up again.
      assert.equal(a.sync.resolve("remote").action, "restart");
      const p = a.sync.prepare();
      assert.equal(p.action, "pulled");
      assert.ok(p.backup);
      dbA = a.open();
      assert.deepEqual(names(dbA), ["Read", "Mac"]);
      assert.equal(a.sync.status(dbA).conflict, null);
      assert.equal(a.sync.push(dbA).action, "up-to-date");
    });

    test("every push, pull, hold and choice lands in the shared history, one file per machine", (t) => {
      const box = sandbox(t);
      const a = machine(box, driver, "zagreus");
      const b = machine(box, driver, "macbook");
      const dbA = a.open();
      dbA.exec(`INSERT INTO habits (name) VALUES ('Read')`);
      a.sync.push(dbA);
      b.sync.prepare();
      const dbB = b.open();
      dbB.exec(`INSERT INTO habits (name) VALUES ('Mac')`);
      b.sync.push(dbB);
      dbA.exec(`INSERT INTO habits (name) VALUES ('PC')`);
      a.sync.push(dbA);
      a.sync.resolve("local", dbA);

      const h = readHistory(box.file("sync"), { app: "habits" });
      assert.deepEqual(
        h.map((e) => `${e.machine} ${e.event}${e.from ? ` from ${e.from}` : ""}`),
        ["zagreus pushed", "macbook pulled from zagreus", "macbook pushed", "zagreus held from macbook", "zagreus kept-local"],
      );
      assert.equal(h[0].total, 1);
      assert.deepEqual(readHistory(box.file("sync")).length, 5);
      assert.ok(existsSync(box.file("sync", "habits", "history", "zagreus.jsonl")));
      assert.ok(existsSync(box.file("sync", "habits", "history", "macbook.jsonl")));
    });

    test("keeping this machine's data pushes it over the other's", (t) => {
      const box = sandbox(t);
      const a = machine(box, driver, "zagreus");
      const b = machine(box, driver, "macbook");
      const dbA = a.open();
      dbA.exec(`INSERT INTO habits (name) VALUES ('Read')`);
      a.sync.push(dbA);
      b.sync.prepare();
      const dbB = b.open();
      dbB.exec(`INSERT INTO habits (name) VALUES ('Mac')`);
      b.sync.push(dbB);
      dbA.exec(`INSERT INTO habits (name) VALUES ('PC')`);
      assert.equal(a.sync.push(dbA).action, "held");

      assert.equal(a.sync.resolve("local", dbA).action, "pushed");
      assert.equal(a.sync.status(dbA).verdict, "in-sync");
      // The Mac hadn't changed since its push, so it simply pulls the PC's.
      dbB.close();
      assert.equal(b.sync.prepare().action, "pulled");
      assert.deepEqual(names(b.open()), ["Read", "PC"]);
    });

    test("two machines with their own data that never synced don't overwrite each other", (t) => {
      const box = sandbox(t);
      const a = machine(box, driver, "zagreus");
      const b = machine(box, driver, "macbook");
      const dbA = a.open();
      dbA.exec(`INSERT INTO habits (name) VALUES ('PC')`);
      a.sync.push(dbA);
      const dbB = b.open();
      dbB.exec(`INSERT INTO habits (name) VALUES ('Mac')`);
      dbB.close();
      assert.equal(b.sync.prepare().action, "held");
      assert.deepEqual(names(b.open()), ["Mac"]);
    });

    test("never pulls data from newer code than this app knows", (t) => {
      const box = sandbox(t);
      const a = machine(box, driver, "zagreus");
      const b = machine(box, driver, "macbook", { schemaVersion: 1 });
      const dbA = a.open();
      dbA.exec(`INSERT INTO habits (name) VALUES ('Read'); PRAGMA user_version = 2;`);
      a.sync.push(dbA);
      const dbB = b.open();
      dbB.exec(`PRAGMA user_version = 1`);
      dbB.close();
      assert.equal(b.sync.prepare().action, "behind");
      assert.deepEqual(names(b.open()), []);
    });

    test("a snapshot cut short reads as none", (t) => {
      const box = sandbox(t);
      const a = machine(box, driver, "zagreus");
      const b = machine(box, driver, "macbook");
      const dbA = a.open();
      dbA.exec(`INSERT INTO habits (name) VALUES ('Read')`);
      a.sync.push(dbA);
      const text = readFileSync(a.sync.file, "utf8");
      writeFileSync(a.sync.file, text.slice(0, text.length - 20));
      assert.equal(b.sync.status().remote, null);
      assert.equal(b.sync.prepare().action, "none");
    });

    test("watch pushes once writes go quiet, and stop pushes what's pending", async (t) => {
      const box = sandbox(t);
      const a = machine(box, driver, "zagreus");
      const dbA = a.open();
      const stop = a.sync.watch(dbA, { intervalMs: 20, quietMs: 40 });
      dbA.exec(`INSERT INTO habits (name) VALUES ('Read')`);
      await new Promise((r) => setTimeout(r, 300));
      assert.equal(a.sync.status(dbA).verdict, "in-sync");
      assert.equal(a.sync.status(dbA).remote?.total, 1);
      dbA.exec(`INSERT INTO habits (name) VALUES ('Run')`);
      stop();
      assert.equal(a.sync.status(dbA).remote?.total, 2);
    });

    test("watch also pushes writes made by another connection (a CLI, an MCP server)", async (t) => {
      const box = sandbox(t);
      const a = machine(box, driver, "zagreus");
      const dbA = a.open();
      const stop = a.sync.watch(dbA, { intervalMs: 20, quietMs: 40 });
      const cli = a.open();
      cli.exec(`INSERT INTO habits (name) VALUES ('From the CLI')`);
      await new Promise((r) => setTimeout(r, 300));
      stop();
      assert.equal(a.sync.status(dbA).remote?.total, 1);
    });
  });
}
