// What the resource files share: the client's one JSON call and its download. Meshy's field names stay as Meshy
// writes them (snake_case); this package's options (signal, aiModel…) are camelCase.

import type { FormFields } from "@btkulka/http-kit";

export interface CallOptions {
  signal?: AbortSignal;
}

export interface CallInit extends CallOptions {
  body?: unknown;
  query?: FormFields;
  /** This call's timeout per attempt, when it isn't the client's. */
  timeoutMs?: number;
  /**
   * "refused": retry only a 429, which Meshy turned away without creating anything; for creating a task (paid).
   * Default "any": 429, 5xx, timeouts and dropped connections.
   */
  retry?: "any" | "refused";
}

/** An answer: the JSON, and the Retry-After Meshy sent with it (it sends one while a polled task is still running). */
export interface Answer<T> {
  data: T;
  retryAfterMs?: number;
}

/** The client's JSON request. `path` is under https://api.meshy.ai. */
export type Call = <T>(method: string, path: string, init?: CallInit) => Promise<Answer<T>>;

export interface Transport {
  call: Call;
}
