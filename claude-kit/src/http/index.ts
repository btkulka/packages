import { existsSync, readFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { dirname, join } from "node:path";
import type { ChatHost } from "../host/host.js";
import type { ClaudeEvent, ThumbSize } from "../types.js";

// @btkulka/claude-kit/http: a ChatHost over HTTP, for a server app (express,
// connect, fastify's raw req/res, node:http). Under its base path ("/claude"):
//
//   POST /rpc           {"method": "send", "args": ["hi"]} → {"ok": true, "value": …}
//   GET  /events        the host's events as Server-Sent Events (chats, chat, stream)
//   GET  /image?ref=…   an image to draw (&folder=…&thumb=md|lg)
//   GET  /element.js    the <claude-widget> element (../element), React inside
//   GET  /styles.css    its styles, for a page that uses /react itself
//
// A chat runs Claude Code on this machine, so by default only the machine
// itself may ask: the connection has to come from a loopback address (a
// server listening on a tailnet address too gets peers, and a TCP tunnel from
// another machine arrives with its Host: localhost intact), the Host header
// has to be localhost (DNS rebinding), and a page from another origin is
// turned away (Origin, Sec-Fetch-Site). `allowHosts` adds host names and
// `allowRemote` lets other machines connect, both on purpose.

type Next = (err?: unknown) => void;
export type HttpHandler = (req: IncomingMessage, res: ServerResponse, next?: Next) => void;

export interface HttpHandlerOptions {
  /** The path everything is under: "/claude". */
  base?: string;
  /** Host names besides localhost, 127.0.0.1 and ::1 that may reach it (no port). */
  allowHosts?: string[];
  /** Other machines may connect (a phone on the tailnet, with `allowHosts` naming this one). Off: only connections from this machine. */
  allowRemote?: boolean;
  /** Where element.js and styles.css are: the package's dist/element, found by itself. */
  assets?: string;
}

const METHODS = ["state", "start", "seen", "send", "stop", "newChat", "select", "close", "answer", "terminal", "configure", "past", "load"] as const;
type Method = (typeof METHODS)[number];

const LOOPBACK = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);
/** A connection from this machine, as the socket sees it: IPv4, IPv6, and IPv4 written as IPv6. */
const fromHere = (addr: string | undefined) => !!addr && (addr === "::1" || /^(::ffff:)?127\./.test(addr));

/** This module's folder, in either build: __dirname in CommonJS, else read off a stack frame. */
function hereDir(): string | undefined {
  if (typeof __dirname === "string") return __dirname;
  const frame = new Error().stack?.split("\n").find((l) => /[\\/]http[\\/]index\.js/.test(l));
  const m = frame && /(file:\/\/\/?[^\s)]+?|[A-Za-z]:\\[^\s)]+?|\/[^\s)]+?)[\\/]index\.js/.exec(frame);
  if (!m) return undefined;
  const p = m[1].startsWith("file:") ? decodeURIComponent(m[1].replace(/^file:\/\/\/?/, process.platform === "win32" ? "" : "/")) : m[1];
  return p;
}

function defaultAssets(): string | undefined {
  const here = hereDir();
  // dist/esm/http or dist/cjs/http → dist/element
  const dir = here && join(dirname(dirname(here)), "element");
  return dir && existsSync(dir) ? dir : undefined;
}

const hostName = (h: string | undefined) => (h ?? "").replace(/:\d+$/, "").toLowerCase();

function json(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(JSON.stringify(body));
}

function readBody(req: IncomingMessage, max = 64 * 1024 * 1024): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > max) {
        reject(new Error("Too big."));
        req.destroy();
      } else chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function call(host: ChatHost, method: Method, args: unknown[]): unknown {
  // JSON turns a left-out argument into null: that's left out too.
  const a = args.map((x) => x ?? undefined) as never[];
  switch (method) {
    case "past":
      return host.past({ query: a[0], limit: a[1] });
    case "newChat":
      return host.newChat(a[0]);
    default:
      return (host[method] as (...x: never[]) => unknown)(...a);
  }
}

/** The host over HTTP, as a request handler: unknown paths go to `next` (or a 404). */
export function httpHandler(host: ChatHost, o: HttpHandlerOptions = {}): HttpHandler {
  const base = (o.base ?? "/claude").replace(/\/+$/, "");
  const allowed = new Set([...LOOPBACK, ...(o.allowHosts ?? []).map((h) => h.toLowerCase())]);
  const assets = o.assets ?? defaultAssets();
  const clients = new Set<ServerResponse>();
  host.on((e: ClaudeEvent) => {
    const frame = `event: ${e.type}\ndata: ${JSON.stringify(e.payload)}\n\n`;
    for (const res of clients) res.write(frame);
  });
  const beat = setInterval(() => {
    for (const res of clients) res.write(": beat\n\n");
  }, 25_000);
  beat.unref?.();

  return (req, res, next) => {
    const url = new URL(req.url ?? "/", "http://x");
    if (url.pathname !== base && !url.pathname.startsWith(`${base}/`)) return next ? next() : json(res, 404, { ok: false, error: "Not found." });
    const path = url.pathname.slice(base.length) || "/";

    // Only this machine (or the hosts allowed), and only pages of this origin.
    if (!o.allowRemote && !fromHere(req.socket.remoteAddress)) return json(res, 403, { ok: false, error: "Only this machine can reach Claude here." });
    if (!allowed.has(hostName(req.headers.host))) return json(res, 403, { ok: false, error: "Only this machine can reach Claude here." });
    const site = req.headers["sec-fetch-site"];
    if (site === "cross-site") return json(res, 403, { ok: false, error: "Not from another site." });
    const origin = req.headers.origin;
    if (origin && origin !== "null") {
      try {
        if (new URL(origin).host.toLowerCase() !== (req.headers.host ?? "").toLowerCase()) return json(res, 403, { ok: false, error: "Not from another origin." });
      } catch {
        return json(res, 403, { ok: false, error: "Bad origin." });
      }
    }

    if (req.method === "GET" && path === "/events") {
      res.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-store", Connection: "keep-alive", "X-Accel-Buffering": "no" });
      res.write(": hello\n\n");
      clients.add(res);
      req.on("close", () => clients.delete(res));
      return;
    }

    if (req.method === "POST" && path === "/rpc") {
      if (!/^application\/json\b/i.test(req.headers["content-type"] ?? "")) return json(res, 415, { ok: false, error: "Send JSON." });
      void readBody(req)
        .then(async (raw) => {
          const { method, args } = JSON.parse(raw || "{}") as { method?: string; args?: unknown[] };
          if (!method || !(METHODS as readonly string[]).includes(method)) return json(res, 400, { ok: false, error: `No method ${method}.` });
          const value = await call(host, method as Method, Array.isArray(args) ? args : []);
          json(res, 200, { ok: true, value: value ?? null });
        })
        .catch((e: Error) => json(res, 200, { ok: false, error: e.message }));
      return;
    }

    if (req.method === "GET" && path === "/image") {
      const ref = url.searchParams.get("ref") ?? "";
      const thumb = (url.searchParams.get("thumb") ?? undefined) as ThumbSize | undefined;
      void host
        .image(ref, url.searchParams.get("folder") ?? undefined, thumb === "md" || thumb === "lg" ? thumb : undefined)
        .then((img) => {
          res.writeHead(200, {
            "Content-Type": img.type,
            "Cache-Control": "private, max-age=3600",
            "Content-Disposition": `inline; filename="${encodeURIComponent(img.name)}"`,
            "X-Content-Type-Options": "nosniff",
            // An SVG drawn as an image runs no script, but opened on its own it would: never as this origin's page.
            "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; sandbox",
          });
          res.end(img.bytes);
        })
        .catch((e: Error) => json(res, 404, { ok: false, error: e.message }));
      return;
    }

    if (req.method === "GET" && (path === "/element.js" || path === "/styles.css")) {
      const file = assets && join(assets, path === "/element.js" ? "claude-kit.js" : "claude-kit.css");
      if (!file || !existsSync(file)) return json(res, 404, { ok: false, error: "The element isn't built: npm run build in D:\\source\\packages\\claude-kit." });
      res.writeHead(200, { "Content-Type": path.endsWith(".js") ? "text/javascript; charset=utf-8" : "text/css; charset=utf-8", "Cache-Control": "no-cache" });
      res.end(readFileSync(file));
      return;
    }

    if (next) return next();
    json(res, 404, { ok: false, error: "Not found." });
  };
}
