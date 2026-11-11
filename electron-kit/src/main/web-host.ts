import { readFile, stat } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { extname, join, resolve, sep } from "node:path";
import type { Unsubscribe } from "../ipc-schema.js";
import { addBroadcastSink, type IpcRegistry } from "./ipc.js";

// The app as a web app: the same main process, its page served over HTTP to
// any browser (Benhäus's tabs) instead of, or as well as, its own window.
//
// The page is the built renderer, unchanged. Its preload runs in the browser
// too: the host serves the built preload bundle wrapped in a shim that stands
// in for `require("electron")`, so contextBridge.exposeInMainWorld puts the
// same API object on `window`, and ipcRenderer's invoke/send/on go over HTTP
// (POST /__kit/invoke, POST /__kit/send) and a server-sent-events stream
// (GET /__kit/events) to the handlers the app registered through recordIpc
// or createIpcMain. The page can tell it's on the web by `window.__kitWeb`.
//
// Local only: it binds 127.0.0.1, and the IPC routes take requests from the
// page it serves alone (a custom header that a cross-site request can't send
// without a preflight, which isn't answered, and an Origin check).

export interface WebHostOptions {
  /** The port to listen on. */
  port: number;
  /** The address to bind. Default 127.0.0.1: the host is for this computer. */
  host?: string;
  /** The built renderer: the folder with index.html and its assets (electron-vite's out/renderer). */
  rendererDir: string;
  /** The built preload bundle, CommonJS, requiring only "electron" (electron-vite's out/preload/index.cjs). */
  preloadFile: string;
  /** Where a page's invoke and send go: createIpcMain(…).registry, or recordIpc(ipcMain).registry. */
  ipc: IpcRegistry;
  /** What the shim reports as process.platform. Default this process's. */
  platform?: string;
  /** Extra fields the page can read at window.__kitWeb (an app name, a version). */
  info?: Record<string, unknown>;
  /** The page served for paths that aren't files (a router's deep link). Default index.html. */
  fallback?: string;
  /**
   * Routes the app answers itself, tried before the page's files (never for /__kit/): what stood in for a custom
   * protocol in the window, an image endpoint say. Resolve true when it answered, false to let the host serve the
   * path. These aren't behind the Origin and header checks the IPC routes have, so answer only what is safe for any
   * page to load (a GET of an image), or check the request's sec-fetch-site yourself.
   */
  handle?: (req: IncomingMessage, res: ServerResponse) => boolean | Promise<boolean>;
  /** Where to report requests that were refused and handler errors. Default: nowhere. */
  log?: (line: string) => void;
}

export interface WebHost {
  /** http://127.0.0.1:<port> */
  readonly url: string;
  readonly port: number;
  readonly host: string;
  /** How many pages are listening for events right now. */
  clients(): number;
  /** Push an event to every page, as webContents.send would: the listeners get (event, ...args). broadcast() does this for you. */
  push(channel: string, ...args: unknown[]): number;
  close(): Promise<void>;
}

/**
 * Whether this launch asked for the web host alone, no window: `--web` on the
 * command line, or ELECTRON_KIT_WEB=1 in the environment (what an app's
 * `npm run web` sets). Pass a second launch's argv (second-instance) with an
 * empty env to read that launch's flag rather than this process's.
 */
export function isWebLaunch(argv: readonly string[] = process.argv, env: Record<string, string | undefined> = process.env): boolean {
  return argv.includes("--web") || env.ELECTRON_KIT_WEB === "1";
}

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".cjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
  ".wasm": "application/wasm",
  ".mp3": "audio/mpeg",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".txt": "text/plain; charset=utf-8",
};

const PRELOAD_ROUTE = "/__kit/preload.js";
const BODY_LIMIT = 8 * 1024 * 1024;
const IPC_HEADER = "x-kit-ipc";

/**
 * The page with the web preload added: a classic script in <head>, which runs
 * before the page's own (deferred) module scripts, so window.<api> is there
 * when they start. Without a <head>, it goes first in the document.
 */
export function injectWebPreload(html: string, src: string = PRELOAD_ROUTE): string {
  const tag = `<script src="${src}"></script>`;
  if (html.includes(tag)) return html;
  const head = /<head[^>]*>/i.exec(html);
  if (head) return `${html.slice(0, head.index + head[0].length)}${tag}${html.slice(head.index + head[0].length)}`;
  return `${tag}${html}`;
}

/**
 * The preload bundle made to run in a browser: wrapped so its `require`
 * resolves "electron" to a stand-in whose ipcRenderer talks to the host and
 * whose contextBridge sets window.<key>, with `process`, `module`, `exports`,
 * `__dirname` and `__filename` supplied. Pure: given the bundle's text.
 */
export function webPreloadScript(preloadSource: string, info: Record<string, unknown> = {}): string {
  return `${SHIM.replace("__KIT_INFO__", JSON.stringify(info))}\n(function (require, module, exports, process, __dirname, __filename) {\n${preloadSource}\n})(__kitRequire, __kitModule, __kitModule.exports, __kitProcess, "/", "/preload.js");\n})();\n`;
}

// The browser side. Plain script, no build step: it's served as text.
const SHIM = String.raw`(function () {
"use strict";
var info = __KIT_INFO__;
var base = location.origin;
var listeners = new Map();
var stream = null;
function connect() {
  stream = new EventSource(base + "/__kit/events");
  stream.addEventListener("ipc", function (e) {
    var msg = JSON.parse(e.data);
    var set = listeners.get(msg.channel);
    if (!set) return;
    var event = { sender: null, senderId: 0, ports: [] };
    set.forEach(function (fn) {
      try { fn.apply(null, [event].concat(msg.args || [])); } catch (err) { console.error("[electron-kit web] listener on " + msg.channel + " threw", err); }
    });
  });
}
connect();
function post(route, channel, args) {
  return fetch(base + route, { method: "POST", headers: { "content-type": "application/json", "x-kit-ipc": "1" }, body: JSON.stringify({ channel: channel, args: args }) });
}
var LOCAL_INVOKE = { "window:is-maximized": function () { return false; } };
var ipcRenderer = {
  invoke: function (channel) {
    var args = Array.prototype.slice.call(arguments, 1);
    if (LOCAL_INVOKE[channel]) return Promise.resolve(LOCAL_INVOKE[channel].apply(null, args));
    return post("/__kit/invoke", channel, args).then(function (r) { return r.json(); }).then(function (j) {
      if (!j.ok) throw new Error(j.error || "Error invoking remote method '" + channel + "'");
      return j.result;
    });
  },
  send: function (channel) {
    var args = Array.prototype.slice.call(arguments, 1);
    if (channel === "window:control") {
      if (args[0] === "reload_window" || args[0] === "force_reload") location.reload();
      return;
    }
    post("/__kit/send", channel, args).catch(function (err) { console.error("[electron-kit web] send on " + channel + " failed", err); });
  },
  sendSync: function (channel) {
    var args = Array.prototype.slice.call(arguments, 1);
    var xhr = new XMLHttpRequest();
    xhr.open("POST", base + "/__kit/invoke", false);
    xhr.setRequestHeader("content-type", "application/json");
    xhr.setRequestHeader("x-kit-ipc", "1");
    xhr.send(JSON.stringify({ channel: channel, args: args }));
    var j = JSON.parse(xhr.responseText || "{}");
    if (!j.ok) throw new Error(j.error || "sendSync on '" + channel + "' failed");
    return j.result;
  },
  postMessage: function (channel) { throw new Error("ipcRenderer.postMessage('" + channel + "') isn't available on the web"); },
  on: function (channel, fn) {
    var set = listeners.get(channel);
    if (!set) listeners.set(channel, (set = new Set()));
    set.add(fn);
    return ipcRenderer;
  },
  once: function (channel, fn) {
    var wrapped = function () { ipcRenderer.removeListener(channel, wrapped); return fn.apply(null, arguments); };
    return ipcRenderer.on(channel, wrapped);
  },
  addListener: function (channel, fn) { return ipcRenderer.on(channel, fn); },
  removeListener: function (channel, fn) {
    var set = listeners.get(channel);
    if (set) set.delete(fn);
    return ipcRenderer;
  },
  off: function (channel, fn) { return ipcRenderer.removeListener(channel, fn); },
  removeAllListeners: function (channel) {
    if (channel === undefined) listeners.clear();
    else listeners.delete(channel);
    return ipcRenderer;
  },
  listenerCount: function (channel) { var set = listeners.get(channel); return set ? set.size : 0; },
};
var contextBridge = {
  exposeInMainWorld: function (key, api) { window[key] = api; },
  exposeInIsolatedWorld: function (_world, key, api) { window[key] = api; },
};
var electron = { contextBridge, ipcRenderer, webFrame: { setZoomLevel: function () {}, getZoomLevel: function () { return 0; }, setZoomFactor: function () {}, getZoomFactor: function () { return 1; } } };
var __kitProcess = { platform: info.platform, env: {}, versions: { electron: "web", chrome: "", node: "" }, contextIsolated: false, sandboxed: true, type: "renderer", argv: [], cwd: function () { return "/"; }, nextTick: function (fn) { Promise.resolve().then(fn); } };
var __kitModule = { exports: {} };
function __kitRequire(name) {
  if (name === "electron" || name === "electron/renderer") return electron;
  throw new Error("The preload requires '" + name + "', which the web host can't provide; a preload on the web may only require electron.");
}
window.__kitWeb = info;
`;

function allowedOrigins(host: string, port: number): Set<string> {
  const hosts = new Set([host, "127.0.0.1", "localhost", "[::1]"]);
  return new Set([...hosts].map((h) => `http://${h}:${port}`));
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((res, rej) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > BODY_LIMIT) {
        rej(new Error("Request body too large"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => res(Buffer.concat(chunks).toString("utf8")));
    req.on("error", rej);
  });
}

const json = (res: ServerResponse, status: number, body: unknown) => {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
};

/** A file path under `root` for a URL path, or undefined when it would leave the folder. */
export function fileUnder(root: string, urlPath: string): string | undefined {
  let p: string;
  try {
    p = decodeURIComponent(urlPath.split("?")[0]);
  } catch {
    return undefined;
  }
  if (p.includes("\0")) return undefined;
  const base = resolve(root);
  const full = resolve(base, `.${p.startsWith("/") ? p : `/${p}`}`);
  if (full !== base && !full.startsWith(base + sep)) return undefined;
  return full;
}

/**
 * Serve the app's page and bridge its IPC to the browser. Resolves once
 * listening. The app keeps its handlers as they are; what changes is that
 * they're registered through recordIpc (createIpcMain does this), and that
 * events go out with broadcast() or host.push().
 *
 *   const host = await createWebHost({ port: 7791, rendererDir: join(__dirname, "../renderer"), preloadFile: join(__dirname, "../preload/index.cjs"), ipc: ipc.registry });
 */
export async function createWebHost(opts: WebHostOptions): Promise<WebHost> {
  const host = opts.host ?? "127.0.0.1";
  // Port 0 asks for a free one; the real port is known once listening, so what depends on it is filled in then.
  let port = opts.port;
  let origins = allowedOrigins(host, port);
  const root = resolve(opts.rendererDir);
  const fallback = opts.fallback ?? "index.html";
  const log = opts.log ?? (() => undefined);
  const info: Record<string, unknown> = { ...opts.info, web: true, platform: opts.platform ?? process.platform, port };
  let preloadJs: string | undefined;
  const clients = new Set<ServerResponse>();

  const preload = async () => (preloadJs ??= webPreloadScript(await readFile(opts.preloadFile, "utf8"), info));

  const refuse = (req: IncomingMessage, res: ServerResponse, why: string) => {
    log(`refused ${req.method} ${req.url}: ${why}`);
    json(res, 403, { ok: false, error: why });
  };

  const push = (channel: string, ...args: unknown[]) => {
    if (!clients.size) return 0;
    const line = `event: ipc\ndata: ${JSON.stringify({ channel, args })}\n\n`;
    for (const c of clients) c.write(line);
    return clients.size;
  };

  const serveFile = async (res: ServerResponse, file: string) => {
    let target = file;
    let s = await stat(target).catch(() => undefined);
    if (s?.isDirectory()) {
      target = join(target, "index.html");
      s = await stat(target).catch(() => undefined);
    }
    if (!s?.isFile()) {
      // Not a file: a router's path, so the page itself (never for things that look like assets).
      if (extname(file)) return void json(res, 404, { ok: false, error: "Not found" });
      target = join(root, fallback);
      s = await stat(target).catch(() => undefined);
      if (!s?.isFile()) return void json(res, 404, { ok: false, error: "Not found" });
    }
    const ext = extname(target).toLowerCase();
    if (ext === ".html") {
      const html = injectWebPreload(await readFile(target, "utf8"));
      res.writeHead(200, { "content-type": MIME[ext], "cache-control": "no-store" });
      return void res.end(html);
    }
    res.writeHead(200, { "content-type": MIME[ext] ?? "application/octet-stream", "content-length": s.size, "cache-control": ext ? "max-age=60" : "no-store" });
    res.end(await readFile(target));
  };

  const handle = async (req: IncomingMessage, res: ServerResponse) => {
    const url = req.url ?? "/";
    const path = url.split("?")[0];
    if (path.startsWith("/__kit/")) {
      const origin = req.headers.origin;
      if (origin && !origins.has(origin)) return refuse(req, res, `Origin ${origin} isn't this host`);
      if (path === PRELOAD_ROUTE && req.method === "GET") {
        res.writeHead(200, { "content-type": MIME[".js"], "cache-control": "no-store" });
        return void res.end(await preload());
      }
      if (path === "/__kit/info" && req.method === "GET") return void json(res, 200, { ...info, channels: opts.ipc.channels(), clients: clients.size });
      if (path === "/__kit/events" && req.method === "GET") {
        res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive", "x-accel-buffering": "no" });
        res.write(": connected\n\n");
        clients.add(res);
        const ping = setInterval(() => res.write(": ping\n\n"), 25_000);
        res.on("close", () => {
          clearInterval(ping);
          clients.delete(res);
        });
        return;
      }
      if ((path === "/__kit/invoke" || path === "/__kit/send") && req.method === "POST") {
        if (req.headers[IPC_HEADER] !== "1") return refuse(req, res, `Missing ${IPC_HEADER} header`);
        let body: { channel?: unknown; args?: unknown };
        try {
          body = JSON.parse((await readBody(req)) || "{}");
        } catch (e) {
          return void json(res, 400, { ok: false, error: `Bad request body: ${(e as Error).message}` });
        }
        const channel = typeof body.channel === "string" ? body.channel : "";
        const args = Array.isArray(body.args) ? body.args : [];
        if (!channel) return void json(res, 400, { ok: false, error: "No channel" });
        if (path === "/__kit/send") {
          const heard = opts.ipc.send(channel, args);
          return void json(res, 200, { ok: true, heard });
        }
        try {
          const result = await opts.ipc.invoke(channel, args);
          return void json(res, 200, { ok: true, result: result === undefined ? null : result });
        } catch (e) {
          const message = e instanceof Error ? e.message : String(e);
          log(`invoke ${channel} failed: ${message}`);
          return void json(res, 200, { ok: false, error: message });
        }
      }
      return void json(res, 404, { ok: false, error: "Not found" });
    }
    if (opts.handle && (await opts.handle(req, res))) return;
    if (req.method !== "GET" && req.method !== "HEAD") return void json(res, 405, { ok: false, error: "Method not allowed" });
    const file = fileUnder(root, path);
    if (!file) return refuse(req, res, "Path leaves the renderer folder");
    await serveFile(res, file);
  };

  const server: Server = createServer((req, res) => {
    handle(req, res).catch((e: Error) => {
      log(`request ${req.method} ${req.url} failed: ${e.message}`);
      if (!res.headersSent) json(res, 500, { ok: false, error: e.message });
      else res.end();
    });
  });
  const unsink: Unsubscribe = addBroadcastSink((channel, args) => void push(channel, ...args));

  await new Promise<void>((res, rej) => {
    server.once("error", rej);
    server.listen(port, host, () => {
      server.off("error", rej);
      const address = server.address();
      if (address && typeof address === "object") port = address.port;
      origins = allowedOrigins(host, port);
      info.port = port;
      res();
    });
  });

  return {
    url: `http://${host}:${port}`,
    get port() {
      return port;
    },
    host,
    clients: () => clients.size,
    push,
    close: () => {
      unsink();
      for (const c of clients) c.end();
      clients.clear();
      return new Promise<void>((res) => server.close(() => res()));
    },
  };
}
