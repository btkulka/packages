import { timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server as NodeHttpServer, type ServerResponse } from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { Connectable } from "./stdio.js";

// A Streamable HTTP MCP endpoint for a long-running app (Benhäus runs one inside
// Electron's main process). Stateless: every POST gets a fresh server and
// transport. Local callers only: a request with an Origin header (a browser) or a
// Host that isn't this loopback address is refused, which is the DNS-rebinding
// guard. With a token, the endpoint and the extra routes need
// `Authorization: Bearer <token>`; /health never does.

export interface HttpOptions {
  /** A fresh MCP server for each request, e.g. `() => createToolServer({...})`. */
  createServer(): Connectable;
  /** The port to try first. 0 takes any free port. */
  port: number;
  /** How many ports to try, counting up from `port`, when one is taken. Default 10. */
  portAttempts?: number;
  /** Interface to bind. Default 127.0.0.1. */
  host?: string;
  /** Where the MCP endpoint is. Default "/mcp". */
  path?: string;
  /** Bearer token for the endpoint and `routes`. Omit for none. */
  token?: string;
  /** GET/POST /health answers 200 with this as JSON, no token needed. Omit for no /health. */
  health?(): unknown;
  /** Extra POST endpoints behind the token, answering 200 with what the function returns, as JSON. */
  routes?: Record<string, () => unknown>;
  /** Largest request body accepted, in bytes. Default 4 MiB. */
  maxBodyBytes?: number;
}

export interface HttpHandle {
  /** `http://127.0.0.1:<port>/mcp` */
  url: string;
  port: number;
  /** The node:http server. */
  http: NodeHttpServer;
  close(): Promise<void>;
}

/** Compares two tokens in constant time. */
export function sameToken(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

class TooLarge extends Error {}

function readBody(req: IncomingMessage, limit: number): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let failed = false;
    req.on("data", (c: Buffer) => {
      if (failed) return;
      size += c.length;
      if (size > limit) {
        failed = true;
        reject(new TooLarge("Request body too large."));
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      if (failed) return;
      const s = Buffer.concat(chunks).toString("utf8");
      try {
        resolve(s ? JSON.parse(s) : undefined);
      } catch (e) {
        reject(e);
      }
    });
    req.on("error", reject);
  });
}

function send(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) {
  res.writeHead(status, { "content-type": "application/json", ...headers });
  res.end(JSON.stringify(body));
}

const rpcError = (code: number, message: string) => ({ jsonrpc: "2.0", error: { code, message }, id: null });

/** Serve MCP over Streamable HTTP. Rejects with "Ports A–B are all in use." when none is free. */
export async function serveHttp(opts: HttpOptions): Promise<HttpHandle> {
  const host = opts.host ?? "127.0.0.1";
  const mcpPath = opts.path ?? "/mcp";
  const limit = opts.maxBodyBytes ?? 4 * 1024 * 1024;
  let boundPort = 0;

  const handler = async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const hostHeader = (req.headers.host ?? "").toLowerCase();
    const allowed = new Set([`127.0.0.1:${boundPort}`, `localhost:${boundPort}`, `${host.toLowerCase()}:${boundPort}`]);
    if (req.headers.origin || !allowed.has(hostHeader)) return send(res, 403, { error: "forbidden" });
    if (opts.health && url.pathname === "/health") return send(res, 200, await opts.health());
    if (opts.token) {
      const auth = String(req.headers.authorization ?? "");
      if (!auth.startsWith("Bearer ") || !sameToken(auth.slice(7), opts.token)) return send(res, 401, { error: "unauthorized" });
    }
    const route = req.method === "POST" ? opts.routes?.[url.pathname] : undefined;
    if (route) {
      try {
        return send(res, 200, await route());
      } catch (e) {
        return send(res, 500, { error: (e as Error).message });
      }
    }
    if (url.pathname !== mcpPath) return send(res, 404, { error: "not found" });
    if (req.method !== "POST") return send(res, 405, rpcError(-32000, "Method not allowed."));

    try {
      const body = await readBody(req, limit);
      const server = opts.createServer();
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
      res.on("close", () => {
        void transport.close();
        void server.close();
      });
      await server.connect(transport);
      await transport.handleRequest(req, res, body);
    } catch (e) {
      if (res.headersSent) return;
      if (e instanceof TooLarge) {
        res.once("finish", () => req.destroy());
        return send(res, 413, rpcError(-32000, e.message), { connection: "close" });
      }
      send(res, 500, rpcError(-32603, (e as Error).message));
    }
  };

  const attempts = opts.port === 0 ? 1 : (opts.portAttempts ?? 10);
  for (let port = opts.port; port < opts.port + attempts; port++) {
    const http = await new Promise<NodeHttpServer | undefined>((resolve) => {
      const s = createServer((req, res) => {
        handler(req, res).catch((e) => {
          if (!res.headersSent) send(res, 500, { error: (e as Error).message });
        });
      });
      s.once("error", () => resolve(undefined));
      s.listen(port, host, () => resolve(s));
    });
    if (!http) continue;
    const address = http.address();
    boundPort = typeof address === "object" && address ? address.port : port;
    return {
      url: `http://${host}:${boundPort}${mcpPath}`,
      port: boundPort,
      http,
      close: () => new Promise<void>((resolve) => http.close(() => resolve())),
    };
  }
  throw new Error(`Ports ${opts.port}–${opts.port + attempts - 1} are all in use.`);
}
