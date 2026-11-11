import { createServer, request, type IncomingMessage, type RequestOptions, type Server, type ServerResponse } from "node:http";
import { connect, type Socket } from "node:net";
import { hostname } from "node:os";
import { join } from "node:path";
import { hasHistory } from "./history.js";
import { peekManifest, snapshotName } from "./snapshot.js";
import { runsServers, tailnet, type Peer } from "./tailnet.js";
import { tailnetFor, type TailnetConfig } from "./tailnets.js";

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
  /** For a serving instance: the rows its copy holds (DataSync.rows). 0 is an empty copy; absent (an older build): unknown. */
  rows?: number;
}

export interface Running {
  /** Where it answers: http://100.102.17.49:42248. */
  url: string;
  host: string;
  /** The machine's tailnet name, or "localhost". */
  name: string;
  hello: Hello;
  /** The HTTP proxy that reaches it (a userspace tailnet's); absent when it's reachable directly. */
  proxy?: string;
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

/**
 * A hello for this process: serving, from now. `rows` counts the copy it serves (`() => sync.rows()`), so a
 * machine with data never passes through to an empty one; a count that throws is left out.
 */
export function servingHello(app: string, machine = hostname(), rows?: () => number): () => Hello {
  const startedAt = new Date().toISOString();
  return () => {
    let n: number | undefined;
    try {
      n = rows?.();
    } catch {
      n = undefined;
    }
    return { app, machine, mode: "serving", pid: process.pid, startedAt, ...(typeof n === "number" && Number.isFinite(n) ? { rows: n } : {}) };
  };
}

const hostPort = (host: string, port: number) => `${host.includes(":") ? `[${host}]` : host}:${port}`;

/**
 * Where to send a request for `host:port` + `path`: straight there, or to an HTTP proxy in absolute form (how a
 * userspace tailscaled's outbound proxy reaches its tailnet).
 */
function route(host: string, port: number, path: string, proxy?: string): RequestOptions {
  if (!proxy) return { host, port, path };
  const p = new URL(proxy);
  return { host: p.hostname, port: Number(p.port) || 80, path: `http://${hostPort(host, port)}${path}` };
}

/** GET a JSON body, or null on any failure or a non-200 within `timeoutMs`. */
function getJson(host: string, port: number, path: string, timeoutMs: number, proxy?: string): Promise<unknown> {
  return new Promise((resolve) => {
    const req = request({ ...route(host, port, path, proxy), headers: { host: hostPort(host, port) } }, (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        return resolve(null);
      }
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (c: string) => (body += c));
      res.on("end", () => {
        try {
          resolve(JSON.parse(body));
        } catch {
          resolve(null);
        }
      });
    });
    req.setTimeout(timeoutMs, () => req.destroy());
    req.on("error", () => resolve(null));
    req.end();
  });
}

async function probe(host: string, port: number, app: string, timeoutMs: number, proxy?: string): Promise<Hello | null> {
  const h = (await getJson(host, port, HELLO_PATH, timeoutMs, proxy)) as Hello | null;
  return h?.app === app && h.mode === "serving" ? h : null;
}

/**
 * The app serving its data right now, if any: this machine first (127.0.0.1), then every online machine
 * on the app's tailnet (tailnetFor(app), or `tailnet`) that runs servers, through that tailnet's proxy when it
 * has one. Attached instances don't count, so two attached machines can't point at each other, and a copy
 * with rows is found before an empty one. Null when nothing answers within `timeoutMs`.
 */
export async function findRunning(options: { app: string; port: number; local?: boolean; peers?: Peer[]; tailnet?: TailnetConfig; timeoutMs?: number }): Promise<Running | null> {
  const { app, port, timeoutMs = 1500 } = options;
  if (options.local !== false) {
    const h = await probe("127.0.0.1", port, app, timeoutMs);
    if (h) return { url: `http://127.0.0.1:${port}`, host: "127.0.0.1", name: "localhost", hello: h };
  }
  const net = options.tailnet ?? tailnetFor(app);
  let peers = options.peers;
  if (!peers) {
    const status = await tailnet({ socket: net.socket });
    peers = status.peers.filter((p) => p.ip !== status.self?.ip);
  }
  const candidates = peers.filter((p) => p.online && runsServers(p));
  const found = await Promise.all(candidates.map(async (p) => ({ p, h: await probe(p.ip, port, app, timeoutMs, net.proxy) })));
  const hit = found.find((f) => f.h && f.h.rows !== 0) ?? found.find((f) => f.h);
  return hit ? { url: `http://${hostPort(hit.p.ip, port)}`, host: hit.p.ip, name: hit.p.name, hello: hit.h!, proxy: net.proxy } : null;
}

export interface Proxy {
  server: Server;
  /** Stop listening and drop every open connection (event streams included). */
  close(): Promise<void>;
}

/** A TCP connection to `host:port`, through an HTTP proxy's CONNECT when there is one. */
function tunnel(host: string, port: number, proxy: string | undefined, ready: (s: Socket) => void, failed: () => void): Socket {
  if (!proxy) {
    const direct: Socket = connect(port, host, () => ready(direct));
    return direct;
  }
  const p = new URL(proxy);
  const s = connect(Number(p.port) || 80, p.hostname, () => s.write(`CONNECT ${hostPort(host, port)} HTTP/1.1\r\nHost: ${hostPort(host, port)}\r\n\r\n`));
  let head = "";
  const onData = (chunk: Buffer) => {
    head += chunk.toString("latin1");
    const end = head.indexOf("\r\n\r\n");
    if (end < 0) return;
    s.off("data", onData);
    if (!/^HTTP\/1\.[01] 200/.test(head)) {
      s.destroy();
      return failed();
    }
    const rest = Buffer.from(head.slice(end + 4), "latin1");
    if (rest.length) s.unshift(rest);
    ready(s);
  };
  s.on("data", onData);
  return s;
}

/**
 * Listen on `port` and pass every request (and WebSocket upgrade) through to `target` (through its tailnet's
 * proxy when it has one), answering HELLO_PATH itself as attached. The Benhäus tab, the phone and anything else
 * pointed at this machine's port keep working, with the other machine's data.
 */
export function startProxy(options: { app: string; port: number; host?: string; target: Running; machine?: string }): Promise<Proxy> {
  const { app, port, target } = options;
  const machine = options.machine ?? hostname();
  const startedAt = new Date().toISOString();
  const hello = helloRoute(() => ({ app, machine, mode: "attached", pid: process.pid, startedAt, target: target.name }));
  const upstreamPort = Number(new URL(target.url).port);

  const server = createServer((req, res) => {
    if (hello(req, res)) return;
    const up = request({ ...route(target.host, upstreamPort, req.url ?? "/", target.proxy), method: req.method, headers: req.headers }, (r) => {
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
    const up = tunnel(
      target.host,
      upstreamPort,
      target.proxy,
      (s) => {
        const lines = [`${req.method} ${req.url} HTTP/${req.httpVersion}`];
        for (let i = 0; i < req.rawHeaders.length; i += 2) lines.push(`${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}`);
        s.write(`${lines.join("\r\n")}\r\n\r\n`);
        if (head?.length) s.write(head);
        socket.pipe(s).pipe(socket);
      },
      () => socket.destroy(),
    );
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
  /**
   * The rows this machine's copy holds (`() => sync.rows()`). While it holds any, this machine doesn't pass
   * through to a copy that is empty, or to a machine that has never synced with it (no history of that
   * machine's and no snapshot from it in this machine's sync folder): it serves its own instead. Left out,
   * it passes through to whatever is serving.
   */
  localRows?: () => number | Promise<number>;
  /** Where to look for the other machine's history and snapshot. Default the app's tailnet's sync folder. */
  syncDir?: string;
  /** How often an attached instance checks its target is still there. Default 5 s; two misses in a row and it takes over. */
  checkMs?: number;
  log?: (line: string) => void;
  /** Peers to look at instead of asking Tailscale (tests). */
  peers?: Peer[];
  /** The tailnet to look on. Default tailnetFor(app). */
  tailnet?: TailnetConfig;
}

export type ServeOrAttach =
  | { mode: "serving" }
  /** Already serving on this machine: the app's own attach (or nothing) applies. */
  | { mode: "local"; running: Running }
  | { mode: "attached"; running: Running; /** Stop proxying without taking over. */ stop: () => Promise<void> };

/**
 * Why a machine holding `mine` rows shouldn't pass through to `running`: its copy is empty, or it has never
 * synced with this machine, so what it serves isn't this machine's data. Null when passing through is right.
 */
function passOver(app: string, running: Running, mine: number, dir: string): string | null {
  if (mine <= 0) return null;
  if (running.hello.rows === 0) return "its copy is empty";
  const them = running.hello.machine;
  const snapshotFrom = peekManifest(join(dir, app, snapshotName))?.machine;
  if (!hasHistory(dir, app, them) && snapshotFrom?.toLowerCase() !== them.toLowerCase())
    return `it has never synced with this machine (nothing of ${them}'s has reached ${join(dir, app)})`;
  return null;
}

/**
 * Look before serving: if this app is already serving on another machine of its tailnet, proxy this
 * machine's port to it, and take over (serve) when it goes away; otherwise serve now. With `localRows`, a
 * machine that has data serves it rather than passing through to an empty or never-synced copy.
 */
export async function serveOrAttach(options: ServeOrAttachOptions): Promise<ServeOrAttach> {
  const { app, port } = options;
  const log = options.log ?? ((line: string) => console.log(`[data-sync] ${line}`));
  const running = await findRunning({ app, port, peers: options.peers, tailnet: options.tailnet });
  if (!running) {
    await options.serve();
    return { mode: "serving" };
  }
  if (running.name === "localhost") return { mode: "local", running };

  let mine = 0;
  try {
    mine = (await options.localRows?.()) ?? 0;
  } catch (e) {
    log(`${app}: couldn't count this machine's rows: ${(e as Error).message}`);
  }
  const why = passOver(app, running, mine, options.syncDir ?? (options.tailnet ?? tailnetFor(app)).syncDir);
  if (why) {
    log(`${app} is serving on ${running.name}, but ${why}: serving this machine's ${mine} rows here instead.`);
    await options.serve();
    return { mode: "serving" };
  }

  const proxy = await startProxy({ app, port, host: options.host, target: running, machine: options.machine });
  log(`${app} is serving on ${running.name}; this machine's port ${port} passes through to ${running.url}`);
  let misses = 0;
  let stopped = false;
  const timer = setInterval(async () => {
    const h = await probe(running.host, port, app, 2000, running.proxy);
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
