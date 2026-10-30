/**
 * What went wrong:
 * - "http": the server answered with an error (or the caller made the error by hand),
 * - "timeout": no answer within the per-attempt timeout,
 * - "network": no answer at all (DNS, refused, reset, a body that broke off),
 * - "aborted": the caller's AbortSignal fired.
 */
export type HttpErrorKind = "http" | "timeout" | "network" | "aborted";

export interface HttpErrorInit {
  /** The HTTP status. Default 0: no response came back. */
  status?: number;
  /** The parsed JSON error body, or the raw text when it wasn't JSON. */
  body?: unknown;
  url?: string;
  /** How long the server asked to wait (its Retry-After header), when it said. */
  retryAfterMs?: number;
  /** Default "http". */
  kind?: HttpErrorKind;
  cause?: unknown;
}

/** A failed request. API clients extend it with their own name and fields. */
export class HttpError extends Error {
  /** The HTTP status, or 0 when no response came back. */
  readonly status: number;
  /** The parsed JSON error body, or the raw text when it wasn't JSON. */
  readonly body: unknown;
  /** The URL that was called, when known. */
  readonly url: string;
  /** The Retry-After the server sent, in ms, when it sent one. */
  readonly retryAfterMs: number | undefined;
  readonly kind: HttpErrorKind;
  constructor(message: string, init: HttpErrorInit = {}) {
    super(message, init.cause === undefined ? undefined : { cause: init.cause });
    this.name = "HttpError";
    this.status = init.status ?? 0;
    this.body = init.body;
    this.url = init.url ?? "";
    this.retryAfterMs = init.retryAfterMs;
    this.kind = init.kind ?? "http";
  }
}

/** The error an aborted request or wait rejects with: kind "aborted", the signal's reason as the cause. */
export function abortedError(message: string, signal: AbortSignal | undefined, url?: string): HttpError {
  return new HttpError(message, { kind: "aborted", url, cause: signal?.reason });
}
