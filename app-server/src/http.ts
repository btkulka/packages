import type { IncomingMessage, ServerResponse } from "node:http";
import { HttpError } from "@btkulka/http-kit";

// The small HTTP kit an app's API is written with: JSON in and out, a typed error with its status, a route
// table matched by method and path pattern, and the cross-site write guard.

export { HttpError };

export const httpError = (status: number, message: string): HttpError => new HttpError(message, { status });

export function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
}

/** A JSON body (an empty one reads as {}), refused over `max` characters. */
export async function readBody<T = Record<string, unknown>>(req: IncomingMessage, max = 2_000_000): Promise<T> {
  let text = "";
  for await (const chunk of req) {
    text += chunk;
    if (text.length > max) throw httpError(413, "That request is too large.");
  }
  if (!text) return {} as T;
  try {
    return JSON.parse(text) as T;
  } catch {
    throw httpError(400, "The request body isn't JSON.");
  }
}

/** The raw body (a photo), refused over `max` bytes. */
export async function readRaw(req: IncomingMessage, max = 15_000_000): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const b = typeof chunk === "string" ? Buffer.from(chunk) : (chunk as Buffer);
    size += b.length;
    if (size > max) throw httpError(413, `That's over ${Math.round(max / 1_000_000)} MB.`);
    chunks.push(b);
  }
  return Buffer.concat(chunks);
}

export interface Ctx {
  req: IncomingMessage;
  res: ServerResponse;
  params: Record<string, string>;
  query: URLSearchParams;
  body: <T = Record<string, unknown>>() => Promise<T>;
}

type Handler = (ctx: Ctx) => unknown | Promise<unknown>;

interface Route {
  method: string;
  pattern: RegExp;
  keys: string[];
  handler: Handler;
}

/**
 * A route table: `add("PATCH", "/api/items/:id", fn)`. A handler's return value is sent as JSON (200); one that
 * writes to `res` itself returns after doing so. A thrown HttpError answers with its status and `{ error }`;
 * anything else is thrown on, for the server to answer 500. `handle` resolves false when no route matched.
 */
export function router() {
  const routes: Route[] = [];
  const add = (method: string, path: string, handler: Handler) => {
    const keys: string[] = [];
    const pattern = new RegExp(`^${path.replace(/:(\w+)/g, (_, k: string) => (keys.push(k), "([^/]+)"))}$`);
    routes.push({ method, pattern, keys, handler });
  };
  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<boolean> => {
    const url = new URL(req.url ?? "/", "http://localhost");
    for (const r of routes) {
      if (r.method !== req.method) continue;
      const m = r.pattern.exec(url.pathname);
      if (!m) continue;
      const params = Object.fromEntries(r.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])]));
      try {
        const out = await r.handler({ req, res, params, query: url.searchParams, body: () => readBody(req) });
        if (!res.headersSent) json(res, 200, out ?? { ok: true });
      } catch (e) {
        if (e instanceof HttpError) json(res, e.status || 500, { error: e.message });
        else throw e;
      }
      return true;
    }
    return false;
  };
  return { add, handle };
}

/** A positive integer route param, or a 400. */
export function idParam(ctx: Ctx, key = "id"): number {
  const n = Number(ctx.params[key]);
  if (!Number.isInteger(n) || n <= 0) throw httpError(400, `${key} must be a positive whole number.`);
  return n;
}

/** A string field, trimmed and cut at `max`; undefined when absent. */
export function str(v: unknown, max = 500): string | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "string") throw httpError(400, "Expected text.");
  return v.trim().slice(0, max);
}

/** A number field; undefined when absent, null when explicitly null or empty. */
export function num(v: unknown): number | null | undefined {
  if (v === undefined) return undefined;
  if (v === null || v === "") return null;
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n)) throw httpError(400, "Expected a number.");
  return n;
}

const READS = new Set(["GET", "HEAD", "OPTIONS"]);

/**
 * True for a request that changes something and was sent by a page from another origin. The app has no login,
 * so this is what stops another web page from changing its data: the browser names the origin of every write,
 * and it has to be the app's own host. Anything without an Origin (curl, another machine's server, a proxy that
 * passes both headers through) passes. Reads pass: the browser keeps their answers from a cross-origin page.
 */
export function isCrossSiteWrite(req: Pick<IncomingMessage, "method" | "headers">): boolean {
  if (READS.has((req.method ?? "GET").toUpperCase())) return false;
  const origin = req.headers.origin;
  if (origin === undefined) return false;
  const host = req.headers.host;
  try {
    return !host || new URL(origin).host.toLowerCase() !== host.toLowerCase();
  } catch {
    return true;
  }
}
