// The Gemini API (Google AI Studio) as Ben's apps call it: an API key in, the models list and video
// generation. Built on @btkulka/http-kit: a per-attempt timeout, the caller's AbortSignal, a 429 that
// waits out Retry-After, a 5xx or a dropped connection that backs off, an abort or another 4xx never
// retried. Browser-safe: no node:*, no Buffer.

import { HttpError, defaultFetch, isRetryable, retry, send, sendWith, withQuery, type FetchLike, type FetchLikeResponse } from "@btkulka/http-kit";
import type { Bytes, Call, CallInit, Transport } from "./call.js";
import { GeminiAuthError, GeminiError, geminiError, invalid, redactKey, wrap } from "./errors.js";
import { modelsApi, type ModelsApi } from "./models.js";
import { videoApi, type VideoApi } from "./video.js";

export const GEMINI_API_URL = "https://generativelanguage.googleapis.com";
export const GEMINI_API_VERSION = "v1beta";
export const USER_AGENT = "btkulka-gemini-client/0.1.0";

/** A fetch response this client can also read bytes from (a real Response can). */
export type GeminiFetchResponse = FetchLikeResponse & { arrayBuffer?(): Promise<ArrayBuffer> };
export type GeminiFetch = FetchLike<GeminiFetchResponse>;

export interface GeminiClientOptions {
  /** A Gemini API key from aistudio.google.com/apikey (`AIza…`). Empty: every call throws GeminiAuthError (code missing_api_key) without a request. */
  apiKey: string | null | undefined;
  /** Defaults to the global fetch. Downloading a video by `uri` needs responses with `arrayBuffer()`. */
  fetch?: GeminiFetch;
  /** Default https://generativelanguage.googleapis.com */
  baseUrl?: string;
  /** Default v1beta (the Interactions API is beta). */
  apiVersion?: string;
  /** Sent as User-Agent where the runtime allows it. Default btkulka-gemini-client/0.1.0 */
  userAgent?: string;
  /** Per attempt, for ordinary calls. Default 60 000 (a finished interaction carries its video inline). */
  timeoutMs?: number;
  /** Per attempt, for a video download by `uri`. Default 300 000. */
  downloadTimeoutMs?: number;
  /** Attempts in all for a 429, a 5xx, a timeout or a dropped connection. Default 3. */
  attempts?: number;
  /** The first backoff wait, doubled each retry; a 429's Retry-After replaces it. Default 1 000. */
  baseDelayMs?: number;
  /** Extra headers on every interactions call, e.g. `{ "Api-Revision": "2026-05-20" }` to pin the Interactions API revision. */
  interactionHeaders?: Record<string, string>;
}

export interface GeminiClient {
  models: ModelsApi;
  video: VideoApi;
}

/**
 * http-kit's rule (429, 5xx, timeouts, dropped connections) less what waiting can't fix: a key or
 * project problem, a safety block, or a daily quota.
 */
export function retryable(err: unknown): boolean {
  if (err instanceof GeminiError && (err.category === "auth" || err.category === "setup" || err.category === "blocked")) return false;
  if (err instanceof GeminiError && err.quotaIds.some((q) => /per ?day/i.test(q))) return false;
  return isRetryable(err);
}

/** A 429 Google refused outright: nothing was started, so trying again can't start two. */
const refused = (err: unknown) => retryable(err) && err instanceof HttpError && err.status === 429;

export function createGeminiClient(options: GeminiClientOptions): GeminiClient {
  const apiKey = (options.apiKey ?? "").trim();
  const fetchImpl: GeminiFetch = options.fetch ?? defaultFetch<GeminiFetchResponse>();
  const baseUrl = (options.baseUrl ?? GEMINI_API_URL).replace(/\/+$/, "");
  const root = `${baseUrl}/${(options.apiVersion ?? GEMINI_API_VERSION).replace(/^\/+|\/+$/g, "")}`;
  const userAgent = options.userAgent ?? USER_AGENT;
  const timeoutMs = options.timeoutMs ?? 60_000;
  const downloadTimeoutMs = options.downloadTimeoutMs ?? 300_000;
  const attempts = Math.max(1, Math.floor(options.attempts ?? 3));
  const baseDelayMs = options.baseDelayMs ?? 1_000;

  const needKey = (): void => {
    if (!apiKey) throw new GeminiAuthError("No Gemini API key: pass one as `apiKey` (aistudio.google.com/apikey).", { code: "missing_api_key" });
  };
  const authHeaders = (): Record<string, string> => ({ "x-goog-api-key": apiKey, "User-Agent": userAgent });

  const call: Call = async <T>(method: string, path: string, init: CallInit = {}): Promise<T> => {
    needKey();
    const url = withQuery(`${root}${path}`, init.query);
    const label = `Gemini ${method} ${path}`;
    const extra = path.startsWith("/interactions") ? options.interactionHeaders : undefined;
    const headers: Record<string, string> = { ...authHeaders(), Accept: "application/json", ...extra, ...init.headers };
    if (init.body !== undefined) headers["Content-Type"] = "application/json";
    const req = { method, headers, body: init.body === undefined ? undefined : JSON.stringify(init.body) };
    const { signal } = init;
    try {
      const r = await retry(
        async () => {
          const res = await send(fetchImpl, url, req, { timeoutMs: init.timeoutMs ?? timeoutMs, signal, label });
          if (res.res.ok) return res;
          throw geminiError(res, url, label);
        },
        { attempts, baseDelayMs, signal, retryable: init.retry === "rate_limit" ? refused : retryable },
      );
      return r.json as T;
    } catch (err) {
      throw wrap(err);
    }
  };

  const bytes: Bytes = async (url, init = {}) => {
    needKey();
    // The key rides in a header; it only ever goes to the API's own host.
    if (!sameOrigin(url, baseUrl)) throw invalid(`Refusing to send the Gemini key to ${originOf(url)}: only ${originOf(baseUrl)} gets it.`);
    const label = `Gemini download ${redactKey(url).replace(root, "")}`;
    const { signal } = init;
    try {
      return await retry(
        () =>
          sendWith(fetchImpl, url, { method: "GET", headers: authHeaders() }, { timeoutMs: init.timeoutMs ?? downloadTimeoutMs, signal, label }, async (res) => {
            if (!res.ok) {
              const text = await res.text();
              throw geminiError({ res, text, json: parseJson(text) }, url, label);
            }
            if (typeof res.arrayBuffer !== "function") {
              throw new GeminiError("This fetch's responses have no arrayBuffer(), so a video can't be downloaded by uri: pass a fetch that has it (the global fetch does).", { code: "INVALID_ARGUMENT", category: "validation", url: redactKey(url) });
            }
            return new Uint8Array(await res.arrayBuffer());
          }),
        { attempts, baseDelayMs, signal, retryable },
      );
    } catch (err) {
      throw wrap(err);
    }
  };

  const transport: Transport = { call, bytes, root };
  return { models: modelsApi(transport), video: videoApi(transport) };
}

function parseJson(text: string): unknown {
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function originOf(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return url;
  }
}

function sameOrigin(a: string, b: string): boolean {
  return originOf(a) === originOf(b);
}
