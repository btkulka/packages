// Retries: a 429 waits out Retry-After (capped), a 5xx, a timeout or a network error backs off
// exponentially, and an abort is never retried.

import { HttpError, abortedError } from "./errors.js";
import { hostOf, send, type FetchLike, type FetchLikeInit, type FetchLikeResponse, type SendOptions, type SendResult } from "./fetch.js";

export interface RetryOptions {
  /** Attempts in all, the first one included. Default 3. */
  attempts?: number;
  /** The first backoff wait; it doubles on each retry. Default 1 000. */
  baseDelayMs?: number;
  /** Ceiling on one backoff wait. Default 30 000. */
  maxDelayMs?: number;
  /** Ceiling on a 429's Retry-After wait. Default 60 000. */
  maxRetryAfterMs?: number;
  /** Which failures to retry. Default `isRetryable`. An abort is never retried, whatever this says. */
  retryable?: (err: unknown) => boolean;
  /** Stops the loop: before the next attempt, and during a wait. */
  signal?: AbortSignal;
}

/** 429, 5xx, timeouts and network errors. Never an abort, never another 4xx, never a non-HttpError. */
export function isRetryable(err: unknown): boolean {
  if (!(err instanceof HttpError)) return false;
  if (err.kind === "aborted") return false;
  if (err.kind === "timeout" || err.kind === "network") return true;
  return err.status === 429 || err.status >= 500;
}

/** How long to wait before retry number `attempt + 1`: a 429's Retry-After when it sent one, else the backoff. */
export function retryDelay(err: unknown, attempt: number, options: RetryOptions = {}): number {
  if (err instanceof HttpError && err.status === 429 && err.retryAfterMs != null) {
    return Math.min(Math.max(0, err.retryAfterMs), options.maxRetryAfterMs ?? 60_000);
  }
  return Math.min((options.baseDelayMs ?? 1_000) * 2 ** attempt, options.maxDelayMs ?? 30_000);
}

/**
 * Runs `fn` until it succeeds, it fails with something `retryable` says no to, or the attempts
 * run out; then throws the last error. `fn` gets the attempt number, from 0.
 */
export async function retry<T>(fn: (attempt: number) => Promise<T>, options: RetryOptions = {}): Promise<T> {
  const attempts = Math.max(1, Math.floor(options.attempts ?? 3));
  const retryable = options.retryable ?? isRetryable;
  const { signal } = options;
  for (let attempt = 0; ; attempt++) {
    if (signal?.aborted) throw abortedError("The request was aborted", signal);
    let failure: unknown;
    try {
      return await fn(attempt);
    } catch (err) {
      failure = err;
    }
    if (isAbort(failure) || signal?.aborted || attempt + 1 >= attempts || !retryable(failure)) throw failure;
    await sleep(retryDelay(failure, attempt, options), signal);
  }
}

export interface RequestOptions<R extends FetchLikeResponse = FetchLikeResponse> extends SendOptions, Omit<RetryOptions, "signal"> {
  /**
   * Builds the error thrown for a non-2xx answer. Default `httpError`. Give it `retryAfterMs`
   * so a 429 waits out the server's Retry-After instead of the backoff.
   */
  error?: (r: SendResult<R>, url: string) => Error;
}

/** `send` plus retries. Resolves with a 2xx answer; throws `error(r)` (an HttpError by default) for any other. */
export async function request<R extends FetchLikeResponse>(
  fetchImpl: FetchLike<R>,
  url: string,
  init: FetchLikeInit = {},
  options: RequestOptions<R> = {},
): Promise<SendResult<R>> {
  const toError = options.error ?? ((r: SendResult<R>, u: string) => httpError(r, u, options.label));
  return retry(
    async () => {
      const r = await send(fetchImpl, url, init, options);
      if (r.res.ok) return r;
      throw toError(r, url);
    },
    { ...options, signal: options.signal ?? init.signal },
  );
}

/** `<label> to <host> failed (<status>): <what the server said>`, with status, body, url and Retry-After. */
export function httpError(r: SendResult, url: string, label = "Request"): HttpError {
  const j = r.json && typeof r.json === "object" ? (r.json as { message?: unknown }) : undefined;
  const said = typeof j?.message === "string" && j.message ? j.message : r.text.slice(0, 300) || r.res.statusText || `HTTP ${r.res.status}`;
  const after = retryAfterSeconds(r.res);
  return new HttpError(`${label} to ${hostOf(url)} failed (${r.res.status}): ${said}`, {
    status: r.res.status,
    body: r.json ?? r.text,
    url,
    retryAfterMs: after == null ? undefined : after * 1000,
  });
}

/** Seconds from a Retry-After header (delta-seconds or an HTTP date), never below 0; null when it's missing or unreadable. */
export function retryAfterSeconds(res: { headers?: { get(name: string): string | null } | null }): number | null {
  const raw = res.headers?.get?.("retry-after");
  if (raw == null || raw.trim() === "") return null;
  const n = Number(raw);
  if (Number.isFinite(n)) return Math.max(0, n);
  const at = Date.parse(raw);
  return Number.isFinite(at) ? Math.max(0, (at - Date.now()) / 1000) : null;
}

/** Resolves after `ms`. With a signal, rejects at once when it fires (HttpError, kind "aborted"). */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(abortedError("The wait was aborted", signal));
    const onAbort = (): void => {
      clearTimeout(t);
      reject(abortedError("The wait was aborted", signal));
    };
    // setTimeout treats anything past 2^31-1 ms as 1 ms.
    const t = setTimeout(
      () => {
        signal?.removeEventListener("abort", onAbort);
        resolve();
      },
      Math.min(Math.max(0, ms), 2_147_483_647),
    );
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function isAbort(err: unknown): boolean {
  return err instanceof HttpError && err.kind === "aborted";
}
