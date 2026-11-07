// What the resource files share: the client's one JSON call and its byte download. Google's own field
// names stay as Google writes them (camelCase on models, snake_case on interactions); this package's
// options (signal, timeoutMs, aspectRatio…) are camelCase.

import type { FormFields } from "@btkulka/http-kit";
import { invalid } from "./errors.js";

export interface CallOptions {
  signal?: AbortSignal;
}

export interface CallInit extends CallOptions {
  body?: unknown;
  query?: FormFields;
  headers?: Record<string, string>;
  /** This call's timeout per attempt, when it isn't the client's. */
  timeoutMs?: number;
  /**
   * "rate_limit": retry only a 429, which Google refused without doing anything; for calls a repeat
   * could double (starting a paid generation). Default "any": 429, 5xx, timeouts and dropped connections.
   */
  retry?: "any" | "rate_limit";
}

/** The client's JSON request. `path` is under https://generativelanguage.googleapis.com/v1beta. */
export type Call = <T>(method: string, path: string, init?: CallInit) => Promise<T>;

export interface BytesInit extends CallOptions {
  timeoutMs?: number;
}

/** The client's binary GET: a full URL on the API's own host (the key never goes anywhere else). */
export type Bytes = (url: string, init?: BytesInit) => Promise<Uint8Array>;

export interface Transport {
  call: Call;
  bytes: Bytes;
  /** https://generativelanguage.googleapis.com/v1beta, no trailing slash. */
  root: string;
}

/** One path segment: an id or a model name, escaped. `models/` in front of a model name is dropped. */
export function seg(value: string | null | undefined, what: string): string {
  const v = (value ?? "").trim();
  if (!v) throw invalid(`No ${what} given.`);
  return encodeURIComponent(v);
}
