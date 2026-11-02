// Notion's REST API as Ben's apps call it: an internal integration's secret in, and the calls
// they make. Built on @btkulka/http-kit: a per-attempt timeout, the caller's AbortSignal, a 429
// that waits out Retry-After (Notion allows about three requests a second), a 5xx or a dropped
// connection that backs off, an abort or another 4xx never retried. Browser-safe: no node:*.

import { HttpError, defaultFetch, request, retryAfterSeconds, withQuery, type FetchLike, type HttpErrorInit, type SendResult } from "@btkulka/http-kit";
import { parseNotionId } from "./ids.js";
import { blocksToText } from "./text.js";
import type { NotionBlock, NotionDatabase, NotionList, NotionObject, NotionPage, NotionUser } from "./types.js";

export const NOTION_API_URL = "https://api.notion.com";
/** The API version every request names (the `Notion-Version` header). */
export const NOTION_VERSION = "2022-06-28";
/** Notion's ceiling on `page_size`. */
export const MAX_PAGE_SIZE = 100;

/**
 * Notion's own error codes, plus this package's for calls that got no answer: `missing_token`
 * (no token was given), `timeout`, `network`, `aborted`.
 */
export type NotionErrorCode =
  | "unauthorized"
  | "restricted_resource"
  | "object_not_found"
  | "rate_limited"
  | "validation_error"
  | "invalid_json"
  | "invalid_request_url"
  | "invalid_request"
  | "missing_version"
  | "conflict_error"
  | "internal_server_error"
  | "service_unavailable"
  | "database_connection_unavailable"
  | "gateway_timeout"
  | "missing_token"
  | "timeout"
  | "network"
  | "aborted"
  | (string & {});

/** Any failed Notion call. `status` is the HTTP status (0 when no answer came), `code` Notion's error code or this package's. */
export class NotionError extends HttpError {
  readonly code: NotionErrorCode | null;
  constructor(message: string, init: HttpErrorInit & { code?: NotionErrorCode | null } = {}) {
    super(message, init);
    this.name = "NotionError";
    this.code = init.code ?? null;
  }
}

/** No token, or Notion rejected it (401 `unauthorized`). Never retried. */
export class NotionAuthError extends NotionError {
  constructor(message: string, init: HttpErrorInit & { code?: NotionErrorCode | null } = {}) {
    super(message, init);
    this.name = "NotionAuthError";
  }
}

/**
 * True when Notion can't show the integration the object: it doesn't exist, or (the usual
 * case) its page wasn't shared with the integration (`object_not_found`), or the integration's
 * capabilities don't cover it (`restricted_resource`).
 */
export function notShared(err: unknown): boolean {
  return err instanceof NotionError && (err.code === "object_not_found" || err.code === "restricted_resource");
}

export interface NotionClientOptions {
  /** The internal integration's secret (`ntn_…` or `secret_…`). Empty: every call throws NotionAuthError without a request. */
  token: string | null | undefined;
  /** Defaults to the global fetch. `(url, init) => Promise<{ ok, status, headers?, text() }>` is enough. */
  fetch?: FetchLike;
  /** Default https://api.notion.com */
  baseUrl?: string;
  /** The `Notion-Version` header. Default 2022-06-28. */
  version?: string;
  /** Per attempt. Default 15 000. */
  timeoutMs?: number;
  /** Attempts in all for a 429, a 5xx, a timeout or a dropped connection. Default 3. */
  attempts?: number;
  /** The first backoff wait, doubled each retry; a 429's Retry-After replaces it. Default 1 000. */
  baseDelayMs?: number;
}

export interface CallOptions {
  signal?: AbortSignal;
}

export interface SearchOptions extends CallOptions {
  /** Words in a title. Empty: everything shared with the integration. */
  query?: string;
  /** Only pages, or only databases. */
  kind?: "page" | "database";
  /** By last edit. Default Notion's relevance order. */
  sort?: "ascending" | "descending";
  /** Up to 100. */
  pageSize?: number;
  cursor?: string;
}

export interface QueryOptions extends CallOptions {
  /** A Notion filter object, as the API takes it. */
  filter?: Record<string, unknown>;
  /** Notion sort objects: `{ property, direction }` or `{ timestamp, direction }`. */
  sorts?: Record<string, unknown>[];
  /** Up to 100. */
  pageSize?: number;
  cursor?: string;
}

export interface BlocksOptions extends CallOptions {
  /** How many levels below the page to read. Default 4. Child pages and databases are never entered. */
  depth?: number;
  /** Stop after this many blocks in all. Default 2 000. */
  limit?: number;
}

export interface CreatePageInput {
  parent: { database_id: string } | { page_id: string };
  properties: Record<string, unknown>;
  /** Blocks for the body, as the API takes them. */
  children?: unknown[];
  icon?: unknown;
  cover?: unknown;
}

export interface UpdatePageInput {
  properties?: Record<string, unknown>;
  archived?: boolean;
  in_trash?: boolean;
  icon?: unknown;
  cover?: unknown;
}

export interface NotionClient {
  /** GET /v1/users/me: the integration's own user; `bot.workspace_name` says which workspace it's in. */
  me(options?: CallOptions): Promise<NotionUser>;
  /** POST /v1/search: one page of the pages and databases shared with the integration. */
  search(options?: SearchOptions): Promise<NotionList<NotionObject>>;
  /** Every search result up to `limit` (default 100), following cursors. */
  searchAll(options?: SearchOptions, limit?: number): Promise<NotionObject[]>;
  /** GET /v1/pages/{id}. Takes an id or a notion.so address. */
  page(idOrUrl: string, options?: CallOptions): Promise<NotionPage>;
  /** GET /v1/databases/{id}: the database and its property schema. */
  database(idOrUrl: string, options?: CallOptions): Promise<NotionDatabase>;
  /** POST /v1/databases/{id}/query: one page of rows. */
  queryDatabase(idOrUrl: string, options?: QueryOptions): Promise<NotionList<NotionPage>>;
  /** Every row up to `limit` (default 1 000), following cursors. */
  queryAll(idOrUrl: string, options?: QueryOptions, limit?: number): Promise<NotionPage[]>;
  /** GET /v1/blocks/{id}/children: one page of a block's (or page's) direct children. */
  blockChildren(idOrUrl: string, options?: QueryOptions): Promise<NotionList<NotionBlock>>;
  /** A page's (or block's) block tree: every child, each with its own `children` down to `depth`. */
  blocks(idOrUrl: string, options?: BlocksOptions): Promise<NotionBlock[]>;
  /** A page's body as text (`blocks` then `blocksToText`). */
  pageText(idOrUrl: string, options?: BlocksOptions): Promise<string>;
  /** POST /v1/pages. */
  createPage(input: CreatePageInput, options?: CallOptions): Promise<NotionPage>;
  /** PATCH /v1/pages/{id}: properties, archive or restore, icon, cover. */
  updatePage(idOrUrl: string, patch: UpdatePageInput, options?: CallOptions): Promise<NotionPage>;
  /** PATCH /v1/blocks/{id}/children: appends blocks to a page or block. */
  appendBlocks(idOrUrl: string, children: unknown[], options?: CallOptions): Promise<NotionList<NotionBlock>>;
  /** Any other call: `request("GET", "/users")`, `request("POST", "/comments", body)`. `path` is under /v1. */
  request<T = unknown>(method: string, path: string, body?: unknown, options?: CallOptions): Promise<T>;
}

const clampSize = (n: number | undefined) => (n == null ? undefined : Math.max(1, Math.min(MAX_PAGE_SIZE, Math.floor(n))));

/** The id in an id or address, or a NotionError (validation_error) when it isn't one. */
export function idOf(idOrUrl: string): string {
  const id = parseNotionId(idOrUrl);
  if (!id) throw new NotionError(`Not a Notion id or address: ${idOrUrl}`, { status: 400, code: "validation_error" });
  return id;
}

/** Notion's error body is `{ object: "error", status, code, message }`. */
function notionError(r: SendResult, url: string, label: string): NotionError {
  const body = r.json && typeof r.json === "object" ? (r.json as { code?: unknown; message?: unknown }) : undefined;
  const status = r.res.status;
  const code: NotionErrorCode | null = typeof body?.code === "string" ? body.code : status === 401 ? "unauthorized" : status === 429 ? "rate_limited" : null;
  const said = typeof body?.message === "string" && body.message ? body.message : r.text.slice(0, 300) || r.res.statusText || `HTTP ${status}`;
  const after = retryAfterSeconds(r.res);
  const init = { status, code, body: r.json ?? r.text, url, retryAfterMs: after == null ? undefined : after * 1000 };
  const message = `${label} failed (${status}${code ? ` ${code}` : ""}): ${said}`;
  return status === 401 ? new NotionAuthError(message, init) : new NotionError(message, init);
}

/** A failure that got no answer (http-kit's timeout, network or aborted) as a NotionError of the same kind. */
function wrap(err: unknown): NotionError {
  if (err instanceof NotionError) return err;
  if (err instanceof HttpError) return new NotionError(err.message, { kind: err.kind, status: err.status, url: err.url, body: err.body, cause: err, code: err.kind === "http" ? null : err.kind });
  return new NotionError(err instanceof Error ? err.message : String(err), { kind: "network", code: "network", cause: err });
}

export function createNotionClient(options: NotionClientOptions): NotionClient {
  const token = (options.token ?? "").trim();
  const fetchImpl = options.fetch ?? defaultFetch();
  const baseUrl = (options.baseUrl ?? NOTION_API_URL).replace(/\/+$/, "");
  const version = options.version ?? NOTION_VERSION;
  const timeoutMs = options.timeoutMs ?? 15_000;
  const attempts = Math.max(1, Math.floor(options.attempts ?? 3));
  const baseDelayMs = options.baseDelayMs ?? 1_000;

  async function call<T>(method: string, path: string, body?: unknown, o: CallOptions = {}): Promise<T> {
    if (!token) throw new NotionAuthError("No Notion token: pass an internal integration's secret as `token`.", { code: "missing_token" });
    const url = `${baseUrl}/v1${path}`;
    const label = `Notion ${method} ${path.split("?")[0]}`;
    const headers: Record<string, string> = { Authorization: `Bearer ${token}`, "Notion-Version": version, Accept: "application/json" };
    if (body !== undefined) headers["Content-Type"] = "application/json";
    try {
      const r = await request(fetchImpl, url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }, {
        timeoutMs,
        attempts,
        baseDelayMs,
        signal: o.signal,
        label,
        error: (res, u) => notionError(res, u, label),
      });
      return r.json as T;
    } catch (err) {
      throw wrap(err);
    }
  }

  const search = (o: SearchOptions = {}) =>
    call<NotionList<NotionObject>>(
      "POST",
      "/search",
      {
        query: o.query || undefined,
        filter: o.kind ? { property: "object", value: o.kind } : undefined,
        sort: o.sort ? { direction: o.sort, timestamp: "last_edited_time" } : undefined,
        start_cursor: o.cursor,
        page_size: clampSize(o.pageSize),
      },
      o,
    );

  // Methods that take an id are async so a bad id rejects like any other failure instead of throwing before the promise.
  const queryDatabase = async (idOrUrl: string, o: QueryOptions = {}) =>
    call<NotionList<NotionPage>>("POST", `/databases/${idOf(idOrUrl)}/query`, { filter: o.filter, sorts: o.sorts, start_cursor: o.cursor, page_size: clampSize(o.pageSize) }, o);

  /** Direct children of a block whose id Notion gave us (no parsing). */
  const childrenOf = (id: string, o: QueryOptions = {}) =>
    call<NotionList<NotionBlock>>("GET", withQuery(`/blocks/${id}/children`, { page_size: clampSize(o.pageSize) ?? MAX_PAGE_SIZE, start_cursor: o.cursor }), undefined, o);
  const blockChildren = async (idOrUrl: string, o: QueryOptions = {}) => childrenOf(idOf(idOrUrl), o);

  /** Follows cursors until `limit` items or the last page. */
  async function collect<T>(first: (cursor?: string) => Promise<NotionList<T>>, limit: number): Promise<T[]> {
    const out: T[] = [];
    let cursor: string | undefined;
    while (out.length < limit) {
      const page = await first(cursor);
      out.push(...page.results);
      if (!page.has_more || !page.next_cursor) break;
      cursor = page.next_cursor;
    }
    return out.length > limit ? out.slice(0, limit) : out;
  }

  async function blocks(idOrUrl: string, o: BlocksOptions = {}): Promise<NotionBlock[]> {
    const depth = Math.max(1, Math.floor(o.depth ?? 4));
    const limit = Math.max(1, Math.floor(o.limit ?? 2_000));
    let count = 0;
    const read = async (id: string, level: number): Promise<NotionBlock[]> => {
      const list = await collect<NotionBlock>((cursor) => childrenOf(id, { cursor, signal: o.signal }), Math.max(1, limit - count));
      count += list.length;
      for (const b of list) {
        if (count >= limit) break;
        if (!b.has_children || level >= depth || b.type === "child_page" || b.type === "child_database") continue;
        b.children = await read(b.id, level + 1);
      }
      return list;
    };
    return read(idOf(idOrUrl), 1);
  }

  return {
    me: (o) => call<NotionUser>("GET", "/users/me", undefined, o),
    search,
    searchAll: (o = {}, limit = 100) => collect<NotionObject>((cursor) => search({ ...o, cursor, pageSize: o.pageSize ?? MAX_PAGE_SIZE }), limit),
    page: async (idOrUrl, o) => call<NotionPage>("GET", `/pages/${idOf(idOrUrl)}`, undefined, o),
    database: async (idOrUrl, o) => call<NotionDatabase>("GET", `/databases/${idOf(idOrUrl)}`, undefined, o),
    queryDatabase,
    queryAll: (idOrUrl, o = {}, limit = 1_000) => collect<NotionPage>((cursor) => queryDatabase(idOrUrl, { ...o, cursor, pageSize: o.pageSize ?? MAX_PAGE_SIZE }), limit),
    blockChildren,
    blocks,
    pageText: async (idOrUrl, o) => blocksToText(await blocks(idOrUrl, o)),
    createPage: (input, o) => call<NotionPage>("POST", "/pages", input, o),
    updatePage: async (idOrUrl, patch, o) => call<NotionPage>("PATCH", `/pages/${idOf(idOrUrl)}`, patch, o),
    appendBlocks: async (idOrUrl, children, o) => call<NotionList<NotionBlock>>("PATCH", `/blocks/${idOf(idOrUrl)}/children`, { children }, o),
    request: (method, path, body, o) => call(method.toUpperCase(), path.startsWith("/") ? path : `/${path}`, body, o),
  };
}
