# @btkulka/data-sync

An app's SQLite data on every machine of Ben's, without a server. Two parts, used together:

- **Look before serving** (`serveOrAttach`). Before an app starts its server it asks the tailnet whether the same app is already serving on another machine. If it is, this machine's port becomes a pass-through to that one (so the Benhäus tab, the phone and bookmarks keep working, with the other machine's data), and when that machine goes away this one takes over and serves.
- **Snapshots through Syncthing** (`createDataSync`). The machine serving pushes a byte-stable SQL snapshot of its database to the sync folder a few seconds after each change. A machine about to serve pulls the newest snapshot first. The database file itself never travels, so no live SQLite file is ever synced.

Nothing is ever merged. When both machines changed since they last agreed, this machine's copy is backed up, the app keeps serving it, nothing for that app syncs, and Ben is told; he keeps one side (`resolve`).

```ts
import Database from "better-sqlite3";
import { createDataSync, helloRoute, serveOrAttach, servingHello } from "@btkulka/data-sync";

const sync = createDataSync({ app: "habit-tracker", dbPath: DB_PATH, driver: Database, schemaVersion: LATEST, notify: (msg) => benhaus.notify(msg) });
const hello = helloRoute(servingHello("habit-tracker"));

await serveOrAttach({
  app: "habit-tracker",
  port: 42248,
  serve: () => {
    sync.prepare();                 // pull the other machine's newer data, or hold a conflict
    const db = openDb();            // the app's own open + migrations
    sync.watch(db);                 // push after writes
    http.createServer((req, res) => hello(req, res) || app(req, res)).listen(42248);
  },
});
```

- **The sync folder** is `BENHAUS_SYNC_DIR`, else `~/.benhaus-sync`: one Syncthing folder (`benhaus-data`) shared between Ben's machines over Tailscale only. Each app writes `<app>/snapshot.sql` there: a header line with the manifest (machine, time, rows, schema version, sha), then the SQL. A file whose sha doesn't match its body reads as missing.
- **The verdict** compares each side with what it was when they last agreed (`<dbPath>.sync.json` keeps both shas): only here changed, push; only there changed, pull; both, hold. A machine with no database, or no rows, simply pulls.
- **Newer code wins nothing by accident**: pass `schemaVersion` (the newest `user_version` the app's code knows) and a snapshot from newer code is never pulled; the app here needs updating first.
- **`exclude`** lists tables whose rows stay on each machine (caches, this machine's own settings): never pushed, and kept through a pull.
- **Backups** go to `backups/` beside the database before every pull and when a conflict is held.
- `findRunning` probes `GET /_data-sync/hello` on 127.0.0.1, then every online tailnet machine that runs servers (phones are skipped). Only instances answering `mode: "serving"` count, so two attached machines can't point at each other. The peers come from `tailscale status --json` (`TAILSCALE_CLI` overrides the binary; the Mac app's is found on its own). No Tailscale means no peers: the app serves on its own.
- **Files** (resumes, artwork) aren't in the database: `mirrorFolder({ local, app, name })` keeps a folder the same through `<sync>/<app>/<name>`, copying whatever is missing or newer each way (times kept) and never deleting. Call it before serving and after the app adds a file.
- Virtual tables (FTS) aren't carried yet: `dumpDatabase` refuses them by name.
- Works on a better-sqlite3 `Database` or a node:sqlite `DatabaseSync`; the app hands its driver in, the package imports neither.
