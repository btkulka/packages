import { existsSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { extname, join, normalize } from "node:path";
import { freePort } from "@btkulka/proc-kit";
import { appHosts, hostsAreDefault, tailscaleAddresses } from "./hosts.js";
import { isCrossSiteWrite, json } from "./http.js";
import type { Logger } from "./log.js";

// One process on the app's port: its JSON API under /api, and its page. In dev, Vite runs in middleware mode
// on the same port (hot reload shares the server); in production the built dist/ is served. It listens on each
// address appHosts gives (this machine and its Tailscale address): one server per address, all with the same
// handler, Vite's live-reload socket answered by the first.

type Handler = (req: IncomingMessage, res: ServerResponse) => unknown;

/** What the app hands in of Vite (the package never imports it): its createServer, and the app's plugins. */
export interface ViteLike {
  createServer(config: Record<string, unknown>): Promise<{ middlewares: (req: IncomingMessage, res: ServerResponse, next: () => void) => void; close(): Promise<void> }>;
}

export interface StartAppOptions {
  name: string;
  version: string;
  port: number;
  /** Default appHosts(): 127.0.0.1 and the Tailscale address (HOST overrides). */
  hosts?: string[];
  /** The app's folder: Vite's root in dev. */
  root: string;
  /** The built page, served with --prod. */
  distDir: string;
  prod: boolean;
  log: Logger;
  /** The app's API, for /api and /api/…: resolves true when it answered, false for a path it doesn't know (a 404). */
  api: (req: IncomingMessage, res: ServerResponse) => boolean | void | Promise<boolean | void>;
  /** Answered before anything else (data-sync's hello): true when it answered. */
  before?: (req: IncomingMessage, res: ServerResponse) => boolean;
  /** Vite for dev, and the app's plugins: `{ vite: await import("vite"), plugins: [react()] }`. Left out, dist/ is served in dev too. */
  dev?: { vite: ViteLike; plugins: unknown[] };
  /** Said after the address in the startup line ("db: …"). */
  banner?: string;
  /** Once listening (start loops that need the server up). */
  onListening?: () => void;
  /** On the way down (close the database, stop loops). */
  onClose?: () => void;
  /** Free the port from a dead copy first. Default true. */
  freeFirst?: boolean;
  /** Exit the process after a signal closes it. Default true. */
  exitOnSignal?: boolean;
}

export interface RunningApp {
  servers: Server[];
  /** The addresses it ended up listening on. */
  hosts: string[];
  close(): Promise<void>;
}

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".map": "application/json",
};

/** The built page: a file from dist/, or index.html for anything else (the app routes it). */
export function distHandler(distDir: string): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  return async (req, res) => {
    let pathname: string;
    try {
      pathname = decodeURIComponent(new URL(req.url ?? "/", "http://localhost").pathname);
    } catch {
      res.writeHead(400, { "content-type": "text/plain" });
      res.end("Bad request");
      return;
    }
    let file = join(distDir, normalize(pathname).replace(/^(\.\.[/\\])+/, ""));
    if (!file.startsWith(distDir)) file = join(distDir, "index.html");
    if (!existsSync(file) || statSync(file).isDirectory()) file = join(distDir, "index.html");
    try {
      const body = await readFile(file);
      const immutable = /[/\\]assets[/\\]/.test(file);
      res.writeHead(200, { "content-type": TYPES[extname(file)] ?? "application/octet-stream", "cache-control": immutable ? "public, max-age=31536000, immutable" : "no-cache" });
      res.end(body);
    } catch {
      res.writeHead(404, { "content-type": "text/plain" });
      res.end("Not found. Run `npm run build` first.");
    }
  };
}

function listenOne(server: Server, port: number, host: string, log: Logger, retries = 20, quiet = false): Promise<boolean> {
  return new Promise((resolve) => {
    let attempts = 0;
    const onError = (e: NodeJS.ErrnoException) => {
      // A restart can race the copy it replaces while that one lets go of the port.
      if (e.code === "EADDRINUSE" && attempts++ < retries) return void setTimeout(() => server.listen(port, host), 500);
      if (!quiet) log.warn(`couldn't listen on ${host}:${port}: ${e.message}`);
      server.off("error", onError);
      resolve(false);
    };
    server.on("error", onError);
    server.listen(port, host, () => {
      server.off("error", onError);
      server.on("error", (e) => log.error(`${host}:${port}:`, e));
      resolve(true);
    });
  });
}

export async function startApp(o: StartAppOptions): Promise<RunningApp> {
  const { log, port } = o;
  if (o.freeFirst ?? true) {
    const freed = await freePort(port);
    if (freed.killed.length) log.info(`freed :${port} (killed ${freed.killed.join(", ")})`);
  }

  let page: Handler = distHandler(o.distDir);
  let closeVite: (() => Promise<void>) | undefined;

  const handler: Handler = (req, res) => {
    if (o.before?.(req, res)) return;
    const path = (req.url ?? "/").split("?")[0];
    const isApi = path === "/api" || path.startsWith("/api/");
    if (isApi && isCrossSiteWrite(req)) {
      log.warn(`refused ${req.method ?? ""} ${path} from ${String(req.headers.origin)}`);
      return json(res, 403, { error: "That request came from another site." });
    }
    // Whatever a request throws is answered here: left as an unhandled rejection it would end the process.
    Promise.resolve()
      .then(async () => {
        if (!isApi) return page(req, res);
        const answered = await o.api(req, res);
        if (answered === false && !res.headersSent) json(res, 404, { error: `No such API route: ${req.method} ${path}` });
      })
      .catch((e: unknown) => {
        log.error(`${req.method ?? "GET"} ${req.url ?? "/"}:`, e);
        if (res.headersSent) res.destroy();
        else json(res, 500, { error: (e as Error)?.message || "Something went wrong." });
      });
  };

  const hosts = o.hosts ?? appHosts();
  const servers: Server[] = [];
  const primary = createServer(handler);
  // A second address's live-reload socket goes to the first server, where Vite listens for it.
  const secondary = () => {
    const s = createServer(handler);
    s.on("upgrade", (req, socket, head) => primary.emit("upgrade", req, socket, head));
    return s;
  };

  if (o.prod) {
    if (!existsSync(join(o.distDir, "index.html"))) log.warn("dist/ is missing: run `npm run build`, or use `npm run dev`.");
  } else if (o.dev) {
    // The config is given inline (not vite.config.ts), so Vite never writes its temporary bundled-config file
    // (which tsx watch would see as a change and restart on). Hot reload shares this server, not a port of its own.
    const vite = await o.dev.vite.createServer({
      configFile: false,
      root: o.root,
      plugins: o.dev.plugins,
      server: { middlewareMode: true, hmr: { server: primary } },
      appType: "spa",
      customLogger: {
        info: (m: string) => log.info(m),
        warn: (m: string) => log.warn(m),
        warnOnce: (m: string) => log.warn(m),
        error: (m: string) => log.error(m),
        clearScreen: () => {},
        hasErrorLogged: () => false,
        hasWarned: false,
      },
    });
    closeVite = () => vite.close();
    page = (req, res) =>
      new Promise<void>((resolve) => {
        vite.middlewares(req, res, () => {
          res.writeHead(404, { "content-type": "text/plain" });
          res.end("Not found");
          resolve();
        });
        res.on("finish", resolve);
      });
  }

  const listening: string[] = [];
  for (const host of hosts) {
    const s = servers.length ? secondary() : primary;
    if (await listenOne(s, port, host, log)) {
      servers.push(s);
      listening.push(host);
    }
  }
  if (!servers.length) {
    log.error(`${o.name} could not listen on :${port} at ${hosts.join(", ")}.`);
    process.exit(1);
  }
  const url = (h: string) => `http://${h === "0.0.0.0" ? "127.0.0.1" : h}:${port}`;
  const where = listening.map((h) => (tailscaleAddresses().includes(h) ? `${url(h)} (Tailscale)` : url(h))).join(" and ");
  log.info(`${o.name} v${o.version} ${o.prod ? "" : "(dev) "}on ${where}  pid ${process.pid}${o.banner ? `  ${o.banner}` : ""}`);
  o.onListening?.();

  // A Tailscale address that comes up after the app (Tailscale starting after login), or that something else held
  // when it started, is listened on too: whenever the hosts are appHosts()'s own (HOST unset), passed in or not.
  // Each try is one attempt, said once per address.
  const tried = new Set<string>();
  const watch =
    hostsAreDefault() && hosts.every((h) => h === "127.0.0.1" || tailscaleAddresses().includes(h))
      ? setInterval(async () => {
          for (const ip of tailscaleAddresses()) {
            if (listening.includes(ip)) continue;
            const s = secondary();
            if (await listenOne(s, port, ip, log, 0, tried.has(ip))) {
              servers.push(s);
              listening.push(ip);
              log.info(`${o.name} now also on ${url(ip)} (Tailscale)`);
            }
            tried.add(ip);
          }
        }, 60_000)
      : undefined;
  watch?.unref();

  let closing: Promise<void> | undefined;
  const close = () =>
    (closing ??= (async () => {
      if (watch) clearInterval(watch);
      for (const s of servers) {
        s.close();
        s.closeAllConnections?.();
      }
      await closeVite?.().catch(() => undefined);
      try {
        o.onClose?.();
      } catch (e) {
        log.error(`${o.name}: while stopping:`, e);
      }
    })());

  if (o.exitOnSignal ?? true) {
    const stop = (signal: string) => {
      if (closing) return;
      log.info(`${o.name}: ${signal}, stopping`);
      void close().finally(() => setTimeout(() => process.exit(0), 300).unref());
    };
    process.on("SIGINT", () => stop("SIGINT"));
    process.on("SIGTERM", () => stop("SIGTERM"));
    process.on("SIGBREAK", () => stop("SIGBREAK"));
  }
  return { servers, hosts: listening, close };
}
