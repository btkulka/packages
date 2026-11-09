import { createServer, request, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { connect } from "node:net";
import { hostname } from "node:os";
import { runsServers, tailnet, type Peer } from "./tailnet.js";

/** Every app that uses this answers here, so another machine can tell it's the same app and whether it's serving. */
export const HELLO_PATH = "/_data-sync/hello";

export interface Hello {
  app: string;
  machine: string;
  /** "serving": this machine has the data. "attached": it proxies to `target`. */
  mode: "serving" | "attached";
  pid: number;
  startedAt: string;
  /** For an attached instance: the machine it proxies to. */
  target?: string;
}

export interface Running {
  /** Where it answers: http://100.102.17.49:42248. */
  url: string;
  host: string;
  /** The machine's tailnet name, or "localhost". */
  name: string;
  hello: Hello;
}

/** GET HELLO_PATH answered with `hello()`; anything else is left for the app. Returns true when it answered. */
export function helloRoute(hello: () => Hello): (req: IncomingMessage, res: ServerResponse) => boolean {
  return (req, res) => {
    if (req.method !== "GET" || (req.url ?? "").split("?")[0] !== HELLO_PATH) return false;
    res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
    res.end(JSON.stringify(hello()));
    return true;
  };
}

/** A hello for this process: serving, from now. */
export function servingHello(app: string, machine = hostname()): () => Hello {
  const startedAt = new Date().toISOString();
  return () => ({ app, machine, mode: "serving", pid: process.pid, startedAt });
}

async function probe(host: string, port: number, app: string, timeoutMs: number): Promise<Hello | null> {
  try {
    const res = await fetch(`http://${host.includes(":") ? `[${host}]` : host}:${port}${HELLO_PATH}`, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return null;
    const h = (await res.json()) as Hello;
    return h?.app === app && h.mode === "serving" ? h : null;
  } catch {
    return null;
  }
}

/**
 * The app serving its data right now, if any: this machine first (127.0.0.1), then every online machine
 * on the tailnet that runs servers. Attached instances don't count, so two attached machines can't point
 * at each other. Null when nothing answers within `timeoutMs`.
 */
export async function findRunning(options: { app: string; port: number; local?: boolean; peers?: Peer[]; timeoutMs?: number }): Promise<Running | null> {
  const { app, port, timeoutMs = 1500 } = options;
  if (options.local !== false) {
    const h = await probe("127.0.0.1", port, app, timeoutMs);
    if (h) return { url: `http://127.0.0.1:${port}`, host: "127.0.0.1", name: "localhost", hello: h };
  }
  let peers = options.peers;
  if (!peers) {
    const net = await tailnet();
    peers = net.peers.filter((p) => p.ip !== net.self?.ip);
  }
  const candidates = peers.filter((p) => p.online && runsServers(p));
  const found = await Promise.all(candidates.map(async (p) => ({ p, h: await probe(p.ip, port, app, timeoutMs) })));
  const hit = found.find((f) => f.h);
  return hit ? { url: `http://${hit.p.ip}:${port}`, host: hit.p.ip, name: hit.p.name, hello: hit.h! } : null;
}

export interface Proxy {
  server: Server;
  /** Stop listening and drop every open connection (event streams included). */
  close(): Promise<void>;
}

/**
 * Listen on `port` and pass every request (and WebSocket upgrade) through to `target`, answering
 * HELLO_PATH itself as attached. The Benhäus tab, the phone and anything else pointed at this machine's
 * port keep working, with the other machine's data.
 */
export function startProxy(options: { app: string; port: number; host?: string; target: Running; machine?: string }): Promise<Proxy> {
  const { app, port, target } = options;
  const machine = options.machine ?? hostname();
  const startedAt = new Date().toISOString();
  const hello = helloRoute(() => ({ app, machine, mode: "attached", pid: process.pid, startedAt, target: target.name }));
  const upstreamPort = Number(new URL(target.url).port);

  const server = createServer((req, res) => {
    if (hello(req, res)) return;
    const up = request({ host: target.host, port: upstreamPort, method: req.method, path: req.url, headers: req.headers }, (r) => {
      res.writeHead(r.statusCode ?? 502, r.headers);
      r.pipe(res);
    });
    up.on("error", (e) => {
      if (!res.headersSent) res.writeHead(502, { "content-type": "text/plain" });
      res.end(`${app} on ${target.name} didn't answer: ${e.message}`);
    });
    req.pipe(up);
  });

  server.on("upgrade", (req, socket, head) => {
    const up = connect(upstreamPort, target.host, () => {
      const lines = [`${req.method} ${req.url} HTTP/${req.httpVersion}`];
      for (let i = 0; i < req.rawHeaders.length; i += 2) lines.push(`${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}`);
      up.write(`${lines.join("\r\n")}\r\n\r\n`);
      if (head?.length) up.write(head);
      socket.pipe(up).pipe(socket);
    });
    up.on("error", () => socket.destroy());
    socket.on("error", () => up.destroy());
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, options.host ?? "0.0.0.0", () => {
      server.off("error", reject);
      resolve({
        server,
        close: () =>
          new Promise<void>((done) => {
            server.close(() => done());
            server.closeAllConnections();
          }),
      });
    });
  });
}

export interface ServeOrAttachOptions {
  app: string;
  port: number;
  /** The address the app listens on, so the proxy listens the same way. Default every interface. */
  host?: string;
  machine?: string;
  /**
   * Start serving here: pull the newest snapshot (DataSync.prepare), open the database, listen on `port`.
   * Called at once when nothing else is serving, or when the machine this one attached to goes away.
   */
  serve: () => unknown | Promise<unknown>;
  /** How often an attached instance checks its target is still there. Default 5 s; two misses in a row and it takes over. */
  checkMs?: number;
  log?: (line: string) => void;
  /** Peers to look at instead of asking Tailscale (tests). */
  peers?: Peer[];
}

export type ServeOrAttach =
  | { mode: "serving" }
  /** Already serving on this machine: the app's own attach (or nothing) applies. */
  | { mode: "local"; running: Running }
  | { mode: "attached"; running: Running; /** Stop proxying without taking over. */ stop: () => Promise<void> };

/**
 * Look before serving: if this app is already serving on another machine of the tailnet, proxy this
 * machine's port to it, and take over (serve) when it goes away; otherwise serve now.
 */
export async function serveOrAttach(options: ServeOrAttachOptions): Promise<ServeOrAttach> {
  const { app, port } = options;
  const log = options.log ?? ((line: string) => console.log(`[data-sync] ${line}`));
  const running = await findRunning({ app, port, peers: options.peers });
  if (!running) {
    await options.serve();
    return { mode: "serving" };
  }
  if (running.name === "localhost") return { mode: "local", running };

  const proxy = await startProxy({ app, port, host: options.host, target: running, machine: options.machine });
  log(`${app} is serving on ${running.name}; this machine's port ${port} passes through to ${running.url}`);
  let misses = 0;
  let stopped = false;
  const timer = setInterval(async () => {
    const h = await probe(running.host, port, app, 2000);
    if (h) {
      misses = 0;
      return;
    }
    if (++misses < 2 || stopped) return;
    stopped = true;
    clearInterval(timer);
    log(`${app} on ${running.name} went away; serving here.`);
    await proxy.close();
    try {
      await options.serve();
    } catch (e) {
      log(`${app}: couldn't take over: ${(e as Error).message}`);
    }
  }, options.checkMs ?? 5000);
  return {
    mode: "attached",
    running,
    stop: async () => {
      stopped = true;
      clearInterval(timer);
      await proxy.close();
    },
  };
}
