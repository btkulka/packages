// One request: global fetch (or an injected one), a per-attempt timeout, the caller's
// AbortSignal, text-first JSON parsing. No node:* imports and no Buffer, so a Vite web app
// can load this file.

import { HttpError, abortedError } from "./errors.js";

/** The part of a fetch Response this package reads. A real Response fits. */
export interface FetchLikeResponse {
  ok: boolean;
  status: number;
  statusText?: string;
  /** Optional so hand-written test stubs can leave it out. */
  headers?: { get(name: string): string | null } | null;
  text(): Promise<string>;
}

/** The part of RequestInit this package sends. */
export interface FetchLikeInit {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  signal?: AbortSignal;
}

/**
 * Global fetch fits this; so does a stub `(url) => ({ ok, status, text })`.
 * `R` is the response type, for clients that read more of it (`arrayBuffer()`, say).
 */
export type FetchLike<R extends FetchLikeResponse = FetchLikeResponse> = (url: string, init?: FetchLikeInit) => Promise<R>;

/** Per attempt, body included, when the caller doesn't say. */
export const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * Wraps the global fetch in a closure. Storing `globalThis.fetch` on an object and
 * calling it as a method throws "Illegal invocation" in browsers.
 */
export function defaultFetch<R extends FetchLikeResponse = FetchLikeResponse>(): FetchLike<R> {
  return (url, init) => {
    if (typeof globalThis.fetch !== "function") {
      return Promise.reject(new HttpError("No global fetch is available in this runtime; pass `fetch` in the options.", { url }));
    }
    return globalThis.fetch(url, init as RequestInit) as unknown as Promise<R>;
  };
}

export interface SendOptions {
  /** Per attempt, body included. 0 or Infinity: none. Default 30 000. */
  timeoutMs?: number;
  /** The caller's signal (or `init.signal`): aborting it aborts the request. */
  signal?: AbortSignal;
  /** Names the request in error messages: `<label> to <host> timed out after …`. Default "Request". */
  label?: string;
  /** false: don't read the body (HEAD, pings). Default true. */
  readBody?: boolean;
}

export interface SendResult<R extends FetchLikeResponse = FetchLikeResponse> {
  res: R;
  text: string;
  /** The body parsed as JSON, or undefined when it was empty or not JSON. */
  json: unknown;
}

/**
 * One request with a timeout. Reads the body as text and parses JSON when it can.
 * Never throws for an HTTP status: check `res.ok`. Throws HttpError with status 0 and
 * kind "timeout", "network" or "aborted" when no usable answer came back.
 */
export async function send<R extends FetchLikeResponse>(
  fetchImpl: FetchLike<R>,
  url: string,
  init: FetchLikeInit = {},
  options: SendOptions = {},
): Promise<SendResult<R>> {
  return sendWith(fetchImpl, url, init, options, async (res) => {
    const text = options.readBody === false ? "" : await res.text();
    return { res, text, json: parseJson(text) };
  });
}

/**
 * `send` with your own reader: `read` runs inside the same timeout and abort handling, so a
 * body download that stalls times out too. HttpErrors thrown by `read` pass through as they
 * are; anything else it throws counts as a network error (or a timeout, if the timer fired).
 */
export async function sendWith<R extends FetchLikeResponse, T>(
  fetchImpl: FetchLike<R>,
  url: string,
  init: FetchLikeInit,
  options: SendOptions,
  read: (res: R) => Promise<T>,
): Promise<T> {
  const label = options.label ?? "Request";
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const signal = options.signal ?? init.signal;
  if (signal?.aborted) throw abortedError(`${label} to ${hostOf(url)} was aborted`, signal, url);
  const ac = new AbortController();
  let timedOut = false;
  const timer =
    Number.isFinite(timeoutMs) && timeoutMs > 0
      ? setTimeout(() => {
          timedOut = true;
          ac.abort();
        }, timeoutMs)
      : undefined;
  const onAbort = (): void => ac.abort();
  signal?.addEventListener("abort", onAbort, { once: true });
  try {
    const res = await fetchImpl(url, { ...init, signal: ac.signal });
    return await read(res);
  } catch (err) {
    if (err instanceof HttpError) throw err;
    if (signal?.aborted) throw abortedError(`${label} to ${hostOf(url)} was aborted`, signal, url);
    if (timedOut) throw new HttpError(`${label} to ${hostOf(url)} timed out after ${timeoutMs}ms`, { kind: "timeout", url, cause: err });
    throw new HttpError(`${label} to ${hostOf(url)} failed: ${messageOf(err)}`, { kind: "network", url, cause: err });
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
  }
}

function parseJson(text: string): unknown {
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

export function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
