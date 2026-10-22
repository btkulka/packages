// Polling: until a check passes, or an HTTP URL answers, with a deadline.
//
// Everything here resolves a boolean instead of throwing, so callers decide
// whether "not up in time" is fatal (throw), a warning, or a reason to carry on.

/** Resolve after `ms` milliseconds. */
export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export interface WaitOptions {
  /** Give up after this long. Default 30 000. */
  timeoutMs?: number;
  /** Pause between checks. Default 250. */
  intervalMs?: number;
  /** Stop early (resolving false) when this aborts: e.g. when the child you're waiting on exits. */
  signal?: AbortSignal;
}

/**
 * Run `check` now and then every `intervalMs` until it returns true (resolves
 * true) or `timeoutMs` passes (resolves false). A check that throws counts as
 * "not yet".
 */
export async function waitFor(check: () => boolean | Promise<boolean>, opts: WaitOptions = {}): Promise<boolean> {
  const timeoutMs = opts.timeoutMs ?? 30_000;
  const intervalMs = Math.max(1, opts.intervalMs ?? 250);
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (opts.signal?.aborted) return false;
    let ok = false;
    try {
      ok = await check();
    } catch {
      ok = false;
    }
    if (ok) return true;
    const left = deadline - Date.now();
    if (left <= 0 || opts.signal?.aborted) return false;
    await pause(Math.min(intervalMs, left), opts.signal);
  }
}

/** sleep() that wakes early on abort. */
function pause(ms: number, signal?: AbortSignal): Promise<void> {
  if (!signal) return sleep(ms);
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(t);
      signal.removeEventListener("abort", done);
      resolve();
    };
    const t = setTimeout(done, ms);
    signal.addEventListener("abort", done, { once: true });
  });
}

export interface ProbeHttpOptions {
  /** Per-request timeout. Default 1500. */
  timeoutMs?: number;
  /** Default "GET". */
  method?: string;
  headers?: Record<string, string>;
  /**
   * Whether this response means "up". Default: a 2xx (`res.ok`). "Something
   * answered" isn't enough by default: a Vite with a stale dep cache serves 504s,
   * and an API mid-restart can accept a socket and fail. Pass
   * `(r) => r.status < 500` to accept 4xx, or read the body to fingerprint the
   * service (`async (r) => r.ok && (await r.json()).ok === true`).
   */
  accept?: (res: Response) => boolean | Promise<boolean>;
}

/**
 * True when `url` answers and `accept` passes. With several URLs (the same
 * service on 127.0.0.1 and [::1], say), they're tried in parallel and any one
 * passing is enough, so a dead family costs one timeout, not one each. Never
 * throws.
 */
export async function probeHttp(url: string | string[], opts: ProbeHttpOptions = {}): Promise<boolean> {
  const urls = Array.isArray(url) ? url : [url];
  if (urls.length === 0) return false;
  const results = await Promise.all(urls.map((u) => probeOne(u, opts)));
  return results.some(Boolean);
}

async function probeOne(url: string, opts: ProbeHttpOptions): Promise<boolean> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), Math.max(1, opts.timeoutMs ?? 1500));
  try {
    const res = await fetch(url, { method: opts.method ?? "GET", headers: opts.headers, signal: ctrl.signal });
    try {
      return Boolean(await (opts.accept ?? defaultAccept)(res));
    } finally {
      // Free the socket when accept didn't read the body.
      if (res.body && !res.bodyUsed) await res.body.cancel().catch(() => {});
    }
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

const defaultAccept = (res: Response): boolean => res.ok;

export interface WaitForHttpOptions extends WaitOptions {
  /** Per-request timeout. Default 1500. */
  requestTimeoutMs?: number;
  method?: string;
  headers?: Record<string, string>;
  /** See `ProbeHttpOptions.accept`. Default: a 2xx. */
  accept?: (res: Response) => boolean | Promise<boolean>;
}

/** Poll `url` until it answers and `accept` passes (true) or `timeoutMs` passes (false). */
export function waitForHttp(url: string | string[], opts: WaitForHttpOptions = {}): Promise<boolean> {
  const probe: ProbeHttpOptions = {
    timeoutMs: opts.requestTimeoutMs,
    method: opts.method,
    headers: opts.headers,
    accept: opts.accept,
  };
  return waitFor(() => probeHttp(url, probe), opts);
}
