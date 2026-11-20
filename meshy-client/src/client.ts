// The Meshy API as Ben's apps call it: an API key in, image to 3D, the balance, and downloads. Built on
// @btkulka/http-kit: a per-attempt timeout, the caller's AbortSignal, a 429 that waits out Retry-After, a 5xx or a
// dropped connection that backs off, an abort or another 4xx never retried. Browser-safe: no node:*, no Buffer.
//
// The key goes only to the API's own origin, as `Authorization: Bearer`. Model and texture files are signed URLs
// on Meshy's asset host: they are fetched without the key.

import { defaultFetch, HttpError, isRetryable, retry, retryAfterSeconds, send, sendWith, withQuery, type FetchLike, type FetchLikeResponse } from "@btkulka/http-kit";
import type { Answer, Call, CallInit, CallOptions } from "./call.js";
import { invalid, MeshyError, meshyError, wrap } from "./errors.js";
import { imageTo3dApi, type ImageTo3dApi } from "./image-to-3d.js";

export const MESHY_API_URL = "https://api.meshy.ai";
export const USER_AGENT = "btkulka-meshy-client/0.1.0";

/** A fetch response this client can also read bytes from (a real Response can). */
export type MeshyFetchResponse = FetchLikeResponse & { arrayBuffer?(): Promise<ArrayBuffer> };
export type MeshyFetch = FetchLike<MeshyFetchResponse>;

export interface MeshyClientOptions {
  /** A Meshy API key from meshy.ai › Developers › API Keys (`msy_…`). Empty: every API call throws MeshyError (code missing_api_key, category auth) without a request. */
  apiKey: string | null | undefined;
  /** Defaults to the global fetch. Downloads need responses with `arrayBuffer()`. */
  fetch?: MeshyFetch;
  /** Default https://api.meshy.ai */
  baseUrl?: string;
  /** Sent as User-Agent where the runtime allows it. */
  userAgent?: string;
  /** Per attempt, for API calls. Default 30 000 (Meshy's own example). */
  timeoutMs?: number;
  /** Per attempt, for a download. Default 300 000. */
  downloadTimeoutMs?: number;
  /** Attempts in all for a 429, a 5xx, a timeout or a dropped connection. Default 3. */
  attempts?: number;
  /** The first backoff wait, doubled each retry; a 429's Retry-After replaces it. Default 1 000. */
  baseDelayMs?: number;
}

/** GET /openapi/v1/balance (free). */
export interface Balance {
  /** Credits that can be spent now (usually monthly + permanent; less under a team's member limit). */
  balance: number;
  /** Credits that expire at the next refresh. */
  monthly_credits?: number;
  /** Credits that don't expire (packs, rewards). */
  permanent_credits?: number;
  /** The next monthly refresh, Unix ms, or null. */
  monthly_resets_at?: number | null;
}

export interface MeshyClient {
  imageTo3d: ImageTo3dApi;
  /** The account's credits (free to call). */
  balance(o?: CallOptions): Promise<Balance>;
  /** A model or texture file by its signed URL (https only; the key is never sent with it). */
  download(url: string, o?: CallOptions): Promise<Uint8Array>;
}

/** http-kit's rule (429, 5xx, timeouts, dropped connections) less what waiting can't fix: the key, credits, a refusal. */
export function retryable(err: unknown): boolean {
  if (err instanceof MeshyError && (err.category === "auth" || err.category === "credits" || err.category === "forbidden")) return false;
  return isRetryable(err);
}

/** What Meshy turned away before creating anything (a 429), so trying again can't make two paid tasks. */
const refused = (err: unknown) => err instanceof HttpError && err.status === 429;

export function createMeshyClient(options: MeshyClientOptions): MeshyClient {
  const apiKey = (options.apiKey ?? "").trim();
  const fetchImpl: MeshyFetch = options.fetch ?? defaultFetch<MeshyFetchResponse>();
  const baseUrl = (options.baseUrl ?? MESHY_API_URL).replace(/\/+$/, "");
  const userAgent = options.userAgent ?? USER_AGENT;
  const timeoutMs = options.timeoutMs ?? 30_000;
  const downloadTimeoutMs = options.downloadTimeoutMs ?? 300_000;
  const attempts = Math.max(1, Math.floor(options.attempts ?? 3));
  const baseDelayMs = options.baseDelayMs ?? 1_000;

  const call: Call = async <T>(method: string, path: string, init: CallInit = {}): Promise<Answer<T>> => {
    if (!apiKey) throw new MeshyError("No Meshy API key: pass one as `apiKey` (meshy.ai › Developers › API Keys).", { code: "missing_api_key", category: "auth" });
    const url = withQuery(`${baseUrl}${path}`, init.query);
    const label = `Meshy ${method} ${path}`;
    const headers: Record<string, string> = { Authorization: `Bearer ${apiKey}`, Accept: "application/json", "User-Agent": userAgent };
    if (init.body !== undefined) headers["Content-Type"] = "application/json";
    const req = { method, headers, body: init.body === undefined ? undefined : JSON.stringify(init.body) };
    const { signal } = init;
    try {
      const r = await retry(
        async () => {
          const res = await send(fetchImpl, url, req, { timeoutMs: init.timeoutMs ?? timeoutMs, signal, label });
          if (res.res.ok) return res;
          throw meshyError(res, url, label);
        },
        { attempts, baseDelayMs, signal, retryable: init.retry === "refused" ? refused : retryable },
      );
      const after = retryAfterSeconds(r.res);
      return { data: r.json as T, retryAfterMs: after == null ? undefined : after * 1000 };
    } catch (err) {
      throw wrap(err);
    }
  };

  const download = async (url: string, o: CallOptions = {}): Promise<Uint8Array> => {
    if (!/^https:\/\//i.test(url ?? "")) throw new MeshyError(`Refusing to download ${String(url).slice(0, 60)}: only https URLs.`, { code: "insecure_url", category: "validation" });
    const label = `Meshy download ${hostPath(url)}`;
    const { signal } = o;
    try {
      return await retry(
        () =>
          // No Authorization: the URL is signed, and the key never leaves the API's origin.
          sendWith(fetchImpl, url, { method: "GET", headers: { "User-Agent": userAgent } }, { timeoutMs: downloadTimeoutMs, signal, label }, async (res) => {
            if (!res.ok) {
              const text = await res.text();
              throw meshyError({ res, text, json: parseJson(text) }, hostPath(url), label);
            }
            if (typeof res.arrayBuffer !== "function") throw invalid("This fetch's responses have no arrayBuffer(), so a file can't be downloaded: pass a fetch that has it (the global fetch does).");
            return new Uint8Array(await res.arrayBuffer());
          }),
        { attempts, baseDelayMs, signal, retryable },
      );
    } catch (err) {
      throw wrap(err);
    }
  };

  return {
    imageTo3d: imageTo3dApi({ call }, download),
    async balance(o = {}) {
      const r = await call<Balance>("GET", "/openapi/v1/balance", { signal: o.signal });
      if (!r.data || typeof r.data.balance !== "number") throw new MeshyError("Meshy answered the balance without a number.", { body: r.data });
      return r.data;
    },
    download,
  };
}

/** A signed URL without its query (the signature), for messages. */
function hostPath(url: string): string {
  try {
    const u = new URL(url);
    return `${u.host}${u.pathname}`;
  } catch {
    return url.split("?")[0] ?? url;
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
