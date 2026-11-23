// Twilio's REST API as Ben's apps call it: an Account SID with its Auth Token (or an API key and
// secret) in, and the calls they make. Built on @btkulka/http-kit: a per-attempt timeout, the
// caller's AbortSignal, a 429 that waits out Retry-After, a 5xx or a dropped connection that backs
// off, an abort or another 4xx never retried; sending a text retries only a 429. Browser-safe: no node:*.

import { HttpError, basicAuth, defaultFetch, formEncode, isRetryable, retry, send, withQuery, type FetchLike } from "@btkulka/http-kit";
import type { Call, CallInit, CallOptions } from "./call.js";
import { callsApi, type CallsApi } from "./calls.js";
import { twilioAuth } from "./credential.js";
import { invalid, TwilioAuthError, twilioError, wrap } from "./errors.js";
import { messagesApi, type MessagesApi } from "./messages.js";

export const TWILIO_API_URL = "https://api.twilio.com";
/** The REST API version in every path. */
export const API_VERSION = "2010-04-01";

export interface TwilioClientOptions {
  /** AC…; every path is under it. Empty: every call throws TwilioAuthError without a request. */
  accountSid: string | null | undefined;
  /** The account's Auth Token: Basic auth as accountSid:authToken, unless an API key and secret are given. */
  authToken?: string | null;
  /** An API key SID (SK…) with its secret: Basic auth as apiKey:apiSecret, used over the Auth Token when both are there. */
  apiKey?: string | null;
  apiSecret?: string | null;
  /** The number texts go out from when a send names no sender. */
  from?: string | null;
  /** A Messaging Service (MG…) texts go through when a send names no sender; used over `from`. */
  messagingServiceSid?: string | null;
  /** Defaults to the global fetch. `(url, init) => Promise<{ ok, status, headers?, text() }>` is enough. */
  fetch?: FetchLike;
  /** Default https://api.twilio.com */
  baseUrl?: string;
  /** Per attempt. Default 20 000. */
  timeoutMs?: number;
  /** Attempts in all for a 429, a 5xx, a timeout or a dropped connection (a send: a 429 only). Default 3. */
  attempts?: number;
  /** The first backoff wait, doubled each retry; a 429's Retry-After replaces it. Default 1 000. */
  baseDelayMs?: number;
}

/** The Account resource, as much of it as an app reads. */
export interface TwilioAccount {
  sid: string;
  friendly_name?: string;
  status?: "active" | "suspended" | "closed" | (string & {});
  type?: "Trial" | "Full" | (string & {});
  owner_account_sid?: string;
  date_created?: string;
  date_updated?: string;
}

export interface AccountApi {
  /** `GET /Accounts/{sid}.json`: the account the credentials sign in to. A cheap check that they work. */
  get(options?: CallOptions): Promise<TwilioAccount>;
}

export interface TwilioClient {
  /** The Account SID every path is under ("" when none was given). */
  readonly accountSid: string;
  messages: MessagesApi;
  calls: CallsApi;
  account: AccountApi;
}

/** A 429 Twilio refused outright: nothing was done, so trying again can't double anything. */
const refused = (err: unknown) => err instanceof HttpError && err.status === 429;

export function createTwilioClient(options: TwilioClientOptions): TwilioClient {
  const auth = twilioAuth(options);
  const accountSid = options.accountSid?.trim() ?? "";
  const fetchImpl = options.fetch ?? defaultFetch();
  const baseUrl = (options.baseUrl ?? TWILIO_API_URL).replace(/\/+$/, "");
  const accountBase = `${baseUrl}/${API_VERSION}/Accounts/${encodeURIComponent(accountSid)}`;
  const timeoutMs = options.timeoutMs ?? 20_000;
  const attempts = Math.max(1, Math.floor(options.attempts ?? 3));
  const baseDelayMs = options.baseDelayMs ?? 1_000;

  const urlFor = (path: string): string => {
    if (path.startsWith(`${baseUrl}/`)) return path;
    if (/^[a-z][a-z0-9+.-]*:/i.test(path)) throw invalid(`Twilio gave a page address on another host (${path}); not following it with the credentials.`);
    if (path.startsWith(`/${API_VERSION}/`)) return `${baseUrl}${path}`;
    return `${accountBase}${path}`;
  };

  const call: Call = async <T>(method: string, path: string, init: CallInit = {}): Promise<T> => {
    if (!auth) throw new TwilioAuthError("No Twilio credentials: pass accountSid and an authToken (or an apiKey and apiSecret).");
    const base = urlFor(path);
    const url = withQuery(base, init.query);
    const label = `Twilio ${method} ${base.slice(baseUrl.length).split("?")[0]}`;
    const headers: Record<string, string> = { Authorization: basicAuth(auth.user, auth.password), Accept: "application/json" };
    let body: string | undefined;
    if (init.form) {
      headers["Content-Type"] = "application/x-www-form-urlencoded";
      body = formEncode(init.form);
    }
    const { signal } = init;
    try {
      const r = await retry(
        async () => {
          const res = await send(fetchImpl, url, { method, headers, body }, { timeoutMs, signal, label });
          if (res.res.ok) return res;
          throw twilioError(res, url);
        },
        { attempts, baseDelayMs, signal, retryable: init.retry === "rate_limit" ? refused : isRetryable },
      );
      return r.json as T;
    } catch (err) {
      throw wrap(err);
    }
  };

  return {
    accountSid,
    messages: messagesApi(call, { from: options.from?.trim() || undefined, messagingServiceSid: options.messagingServiceSid?.trim() || undefined }),
    calls: callsApi(call),
    account: {
      get: (o = {}) => call<TwilioAccount>("GET", ".json", { signal: o.signal }),
    },
  };
}
