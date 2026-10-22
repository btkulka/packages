// HTTP plumbing: global fetch (or an injected one), a per-request timeout,
// text-first JSON parsing and readable errors. No node:* imports and no Buffer.
// (spotify-client has its own copy of this file on purpose: the two packages
// stay independent.)

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

/** Global fetch fits this; so does a stub `(url) => ({ ok, status, text })`. */
export type FetchLike = (url: string, init?: FetchLikeInit) => Promise<FetchLikeResponse>;

/** Any failed SoundCloud call. `status` is the HTTP status, or 0 for timeouts, network errors and setup errors. */
export class SoundCloudApiError extends Error {
  readonly status: number;
  /** The parsed JSON error body, or the raw text when it wasn't JSON. */
  readonly body: unknown;
  constructor(status: number, message: string, body?: unknown, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "SoundCloudApiError";
    this.status = status;
    this.body = body;
  }
}

/**
 * Wraps the global fetch in a closure. Storing `globalThis.fetch` on an object and
 * calling it as a method throws "Illegal invocation" in browsers.
 */
export function defaultFetch(): FetchLike {
  return (url, init) => {
    if (typeof globalThis.fetch !== "function") {
      return Promise.reject(new SoundCloudApiError(0, "No global fetch is available in this runtime; pass `fetch` in the options."));
    }
    return globalThis.fetch(url, init as RequestInit) as Promise<FetchLikeResponse>;
  };
}

export interface SendResult {
  res: FetchLikeResponse;
  text: string;
  json: unknown;
}

/** One request with a timeout. Reads the body as text and parses JSON when it can. */
export async function send(
  fetchImpl: FetchLike,
  url: string,
  init: FetchLikeInit,
  timeoutMs: number,
  options: { readBody?: boolean } = {},
): Promise<SendResult> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  let res: FetchLikeResponse;
  let text = "";
  try {
    res = await fetchImpl(url, { ...init, signal: ac.signal });
    if (options.readBody !== false) text = await res.text();
  } catch (err) {
    if (ac.signal.aborted) {
      throw new SoundCloudApiError(0, `SoundCloud request to ${hostOf(url)} timed out after ${timeoutMs}ms`, undefined, { cause: err });
    }
    if (err instanceof SoundCloudApiError) throw err;
    throw new SoundCloudApiError(0, `SoundCloud request to ${hostOf(url)} failed: ${messageOf(err)}`, undefined, { cause: err });
  } finally {
    clearTimeout(timer);
  }
  let json: unknown = undefined;
  if (text) {
    try {
      json = JSON.parse(text);
    } catch {
      json = undefined;
    }
  }
  return { res, text, json };
}

/** `label (status): what the provider said`, covering the token endpoint's and the API's error shapes. */
export function errorFrom(label: string, r: SendResult): SoundCloudApiError {
  return new SoundCloudApiError(r.res.status, `${label} (${r.res.status}): ${providerMessage(r)}`, r.json ?? r.text);
}

function providerMessage({ res, text, json }: SendResult): string {
  if (json && typeof json === "object") {
    const j = json as Record<string, unknown>;
    const err = j.error;
    // OAuth: { error: "invalid_client", error_description: "..." }
    if (typeof err === "string" && err) {
      return typeof j.error_description === "string" && j.error_description ? `${err}: ${j.error_description}` : err;
    }
    if (err && typeof err === "object" && typeof (err as { message?: unknown }).message === "string") {
      return (err as { message: string }).message;
    }
    // API: { code, message, errors: [{ error_message }], status: "401 - Unauthorized" }
    if (typeof j.message === "string" && j.message) return j.message;
    if (Array.isArray(j.errors)) {
      const first = j.errors.find((e) => e && typeof e === "object" && typeof (e as { error_message?: unknown }).error_message === "string") as
        | { error_message: string }
        | undefined;
      if (first) return first.error_message;
    }
    if (typeof j.status === "string" && j.status) return j.status;
  }
  if (text) return text.slice(0, 300);
  return res.statusText || `HTTP ${res.status}`;
}

/** Seconds to wait from a Retry-After header (delta-seconds or an HTTP date), capped. */
export function retryAfterSeconds(res: FetchLikeResponse, fallback: number, cap: number): number {
  const raw = res.headers?.get?.("retry-after");
  let secs = fallback;
  if (raw != null && raw.trim() !== "") {
    const n = Number(raw);
    if (Number.isFinite(n)) secs = n;
    else {
      const at = Date.parse(raw);
      if (Number.isFinite(at)) secs = (at - Date.now()) / 1000;
    }
  }
  return Math.min(Math.max(0, secs), cap);
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** UTF-8 safe base64 without Buffer or btoa. */
export function base64(input: string): string {
  const bytes = new TextEncoder().encode(input);
  const abc = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i]!;
    const b = i + 1 < bytes.length ? bytes[i + 1]! : 0;
    const c = i + 2 < bytes.length ? bytes[i + 2]! : 0;
    const n = (a << 16) | (b << 8) | c;
    out += abc[(n >> 18) & 63]! + abc[(n >> 12) & 63]!;
    out += i + 1 < bytes.length ? abc[(n >> 6) & 63]! : "=";
    out += i + 2 < bytes.length ? abc[n & 63]! : "=";
  }
  return out;
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
