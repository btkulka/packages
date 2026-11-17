# @btkulka/app-server

The one-process server Ben's web apps share. An app's JSON API and its page answer on one port. In dev, Vite runs inside the same process in middleware mode, so hot reload works on that port. In production the built `dist/` is served. A second `npm run dev` attaches to the copy already running instead of fighting it. The app listens on this machine and its Tailscale address only, never the Wi-Fi. Phones come in through Benhäus's phone remote, which knows who each phone is and what it may open (Settings › People).

Gourmet Guru (`fridge-planner`) and habit-tracker run on it.

```ts
import react from "@vitejs/plugin-react";
import { appHosts, attachToRunning, fileLog, runningInstance, startApp } from "@btkulka/app-server";
import { serveOrAttach } from "@btkulka/data-sync";

const log = fileLog(LOG_PATH);
const hosts = appHosts(); // 127.0.0.1 and the Tailscale address

async function serve() {
  const db = openDb(DB_PATH);
  await startApp({
    name: "Gourmet Guru", version: VERSION, port: 4878, hosts,
    root: ROOT, distDir: DIST_DIR, prod: PROD, log,
    before: hello,                     // data-sync's /_data-sync/hello, answered first
    api: createApi(db),                // (req, res) => Promise<void>, for /api/*
    dev: PROD ? undefined : { vite: await import("vite"), plugins: [react()] },
    banner: `db: ${DB_PATH}`,
    onClose: () => db.close(),
  });
}

const running = await runningInstance({ name: "Gourmet Guru", port: 4878 });
if (running && running.pid !== process.pid) await attachToRunning({ name: "Gourmet Guru", port: 4878, logPath: LOG_PATH, instance: running });
await serveOrAttach({ app: "fridge-planner", port: 4878, host: hosts, serve, localRows: () => rows(db) });
```

## What's in it

- **`startApp(options)`** opens one server per address in `hosts`. It retries for a few seconds when a restart races the copy it replaces for the port. Requests run `before` (when it returns true the request is handled), then `api` for `/api/*`, then the page: Vite's middleware in dev, or `dist/` with an `index.html` fallback in production. Websocket upgrades on every address go to the first server, so Vite's hot reload works whichever address the browser used. SIGINT and SIGTERM close everything and call `onClose`. It returns `{ servers, hosts, close }`.
  - Vite is never imported by the package: the app hands in `await import("vite")` and its plugins. The config is given inline, so Vite never writes a temporary bundled config, which `tsx watch` would see as a change and restart on.
  - A Tailscale address that comes up after the app does is listened on too: Tailscale often starts after login, and something else may have held the address. A watcher checks once a minute whenever the hosts are `appHosts()`'s own (HOST unset), and says once per address when it can't get one.
- **`appHosts()`** picks where to listen. With HOST unset it's `127.0.0.1` plus this machine's Tailscale IPv4 addresses (100.64.0.0/10). HOST `all` or `0.0.0.0` means every interface, `local` means loopback only, and a comma-separated list means exactly those addresses. `tailscaleAddresses()`, `lanAddresses()` and `hostsAreDefault()` are exported beside it.
- **`runningInstance` / `attachToRunning`.** The first asks the port's `/api/health` whether this app (by name) already answers there. The second attaches a second `npm run dev` to it: it tails the log file, watches health, and starts serving itself (by returning) if that copy goes away. Ctrl+C detaches and leaves the server up.
- **HTTP helpers:**
  - `router()` with `add(method, pattern, handler)` and `handle(req, res)`, which resolves false when no route matched. Patterns are like `/api/items/:id`. A handler gets a `Ctx` (`req`, `res`, `params`, `query`, and `body()` to read the JSON body), and what it returns is sent as JSON.
  - `json(res, status, body)`, `readBody`, `readRaw`.
  - `idParam`, `str`, `num` read and check values.
  - `httpError(status, message)` throws a typed `HttpError`, which the router answers with that status.
- **`isCrossSiteWrite(req)`** is the guard for an API with no login. It's true for a write (anything but GET, HEAD and OPTIONS) whose Origin isn't the request's own host, so another web page can't change the app's data. A request with no Origin (curl, another machine's server) and reads pass.
- **`fileLog(path)`** logs to the console and appends to a file. Under `node --test` it writes nothing to the file, so tests never touch an app's real `data/`.
- **`distHandler(distDir)`** is the production page on its own: static files with an SPA fallback.

## Why loopback and Tailscale only

Listening on every interface put each app on the Wi-Fi with no sign-in, open to anyone on the network. Now the Wi-Fi way in is Benhäus's phone remote. It checks the phone's session and its person, then passes the app's port through, and a guest gets only the apps shared with them. The Tailscale address stays because data-sync's second machine reaches the app there, and Ben's own phone on the tailnet opens it directly. Anyone on the tailnet can reach these ports without Benhäus. If a guest joins the tailnet, limit their device in the Tailscale ACLs to the remote's port (4791).

Icon: `icon.svg` is two server slabs (one process, the API and the page) on the Benhäus app-icon plate, in the Utilities sky tint. It was designed on the Claude Design canvas https://claude.ai/artifact/DLLD8QgGK4ZGXBSV6pBVdH with the Benhäus design system. BPM draws it through `benhaus.config.json` (`logos` and the `libraries` row).

Tests: `npm test` (node:test on the built `dist/`).
