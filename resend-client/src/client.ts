// Resend's REST API as Ben's apps call it: an API key in, and the calls they make. Built on
// @btkulka/http-kit: a per-attempt timeout, the caller's AbortSignal, a 429 that waits out
// Retry-After, a 5xx or a dropped connection that backs off, an abort or another 4xx never
// retried. A throttle spaces request starts (2 a second by default) so a bulk sync stays under
// Resend's rate limit. Browser-safe: no node:*.

import { HttpError, defaultFetch, isRetryable, retry, send, withQuery, type FetchLike } from "@btkulka/http-kit";
import { broadcastsApi, type BroadcastsApi } from "./broadcasts.js";
import type { Call, CallInit } from "./call.js";
import { contactsApi, type ContactsApi } from "./contacts.js";
import { domainsApi, type DomainsApi } from "./domains.js";
import { emailsApi, type EmailsApi } from "./emails.js";
import { QUOTA_CODES, ResendAuthError, ResendError, resendError, wrap } from "./errors.js";
import { segmentsApi, type SegmentsApi } from "./segments.js";
import { createThrottle, type Throttle } from "./throttle.js";

export const RESEND_API_URL = "https://api.resend.com";
/** Resend refuses a request without a User-Agent (403). */
export const USER_AGENT = "btkulka-resend-client/0.1.0";

export interface ResendClientOptions {
  /** A Resend API key (`re_…`). Empty: every call throws ResendAuthError (code missing_api_key) without a request. */
  apiKey: string | null | undefined;
  /** Defaults to the global fetch. `(url, init) => Promise<{ ok, status, headers?, text() }>` is enough. */
  fetch?: FetchLike;
  /** Default https://api.resend.com */
  baseUrl?: string;
  /** Default btkulka-resend-client/0.1.0 */
  userAgent?: string;
  /** Per attempt. Default 15 000. */
  timeoutMs?: number;
  /** Attempts in all for a 429, a 5xx, a timeout or a dropped connection. Default 3. */
  attempts?: number;
  /** The first backoff wait, doubled each retry; a 429's Retry-After replaces it. Default 1 000. */
  baseDelayMs?: number;
  /** Request starts a second, for this client's own throttle. Default 2; Infinity turns it off. */
  requestsPerSecond?: number;
  /** A throttle to share with other clients on the same Resend team (`createThrottle`). Replaces `requestsPerSecond`. */
  throttle?: Throttle;
}

export interface ResendClient {
  emails: EmailsApi;
  domains: DomainsApi;
  contacts: ContactsApi;
  segments: SegmentsApi;
  broadcasts: BroadcastsApi;
  /** The throttle every request takes a slot from. */
  readonly throttle: Throttle;
}

/**
 * http-kit's rule (429, 5xx, timeouts, dropped connections) less the sending quotas, which a retry
 * can't fix before they reset, plus the two 409s Resend says to retry: a request still running under
 * the same Idempotency-Key, and a resource another request is changing.
 */
function retryable(err: unknown): boolean {
  if (err instanceof ResendError && err.code && QUOTA_CODES.has(err.code)) return false;
  if (err instanceof ResendError && (err.code === "concurrent_idempotent_requests" || err.code === "resource_locked")) return true;
  return isRetryable(err);
}

/** A 429 Resend refused outright (not a quota): nothing was done, so trying again can't double anything. */
const refused = (err: unknown) => retryable(err) && err instanceof HttpError && err.status === 429;

export function createResendClient(options: ResendClientOptions): ResendClient {
  const apiKey = (options.apiKey ?? "").trim();
  const fetchImpl = options.fetch ?? defaultFetch();
  const baseUrl = (options.baseUrl ?? RESEND_API_URL).replace(/\/+$/, "");
  const userAgent = options.userAgent ?? USER_AGENT;
  const timeoutMs = options.timeoutMs ?? 15_000;
  const attempts = Math.max(1, Math.floor(options.attempts ?? 3));
  const baseDelayMs = options.baseDelayMs ?? 1_000;
  const throttle = options.throttle ?? createThrottle({ requestsPerSecond: options.requestsPerSecond });

  const call: Call = async <T>(method: string, path: string, init: CallInit = {}): Promise<T> => {
    if (!apiKey) throw new ResendAuthError("No Resend API key: pass one as `apiKey`.", { code: "missing_api_key" });
    const url = withQuery(`${baseUrl}${path}`, init.query);
    const label = `Resend ${method} ${path}`;
    const headers: Record<string, string> = { Authorization: `Bearer ${apiKey}`, Accept: "application/json", "User-Agent": userAgent, ...init.headers };
    if (init.body !== undefined) headers["Content-Type"] = "application/json";
    const req = { method, headers, body: init.body === undefined ? undefined : JSON.stringify(init.body) };
    const { signal } = init;
    try {
      const r = await retry(
        async () => {
          // The slot comes first, so waiting in the queue never eats into the attempt's timeout.
          await throttle.wait(signal);
          const res = await send(fetchImpl, url, req, { timeoutMs, signal, label });
          if (res.res.ok) return res;
          throw resendError(res, url, label);
        },
        { attempts, baseDelayMs, signal, retryable: init.retry === "rate_limit" ? refused : retryable },
      );
      return r.json as T;
    } catch (err) {
      throw wrap(err);
    }
  };

  return {
    emails: emailsApi(call),
    domains: domainsApi(call),
    contacts: contactsApi(call),
    segments: segmentsApi(call),
    broadcasts: broadcastsApi(call),
    throttle,
  };
}
