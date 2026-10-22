/**
 * The one error every call here throws, so an app can tell a slow model from a
 * dead one from a bad reply without matching on message text.
 *
 *   http         the server answered with a non-2xx status (`status`, `body`)
 *   timeout      `timeoutMs` ran out
 *   aborted      the caller's AbortSignal fired
 *   unreachable  the request never got an answer (connection refused, DNS, reset)
 *   empty        the model replied with no text
 *   bad-response the server answered 2xx with something that isn't the expected shape
 *   not-found    the claude CLI isn't installed where we looked
 *   spawn        the claude CLI couldn't be started
 *   exit         the claude CLI exited non-zero (`exitCode`, `stderr`)
 *   result       the claude CLI finished with an error result (`result`)
 */
export type LlmErrorKind =
  | "http"
  | "timeout"
  | "aborted"
  | "unreachable"
  | "empty"
  | "bad-response"
  | "not-found"
  | "spawn"
  | "exit"
  | "result";

export interface LlmErrorDetails {
  status?: number;
  body?: string;
  exitCode?: number | null;
  stdout?: string;
  stderr?: string;
  result?: unknown;
  cause?: unknown;
}

export class LlmError extends Error {
  readonly kind: LlmErrorKind;
  /** HTTP status, for `http`. */
  readonly status?: number;
  /** The response body (first 2000 characters), for `http`. */
  readonly body?: string;
  /** The CLI's exit code, for `exit` (null when it was killed by a signal). */
  readonly exitCode?: number | null;
  readonly stdout?: string;
  readonly stderr?: string;
  /** The CLI's `result` event, for `result`. */
  readonly result?: unknown;

  constructor(kind: LlmErrorKind, message: string, details: LlmErrorDetails = {}) {
    super(message, details.cause === undefined ? undefined : { cause: details.cause });
    this.name = "LlmError";
    this.kind = kind;
    if (details.status !== undefined) this.status = details.status;
    if (details.body !== undefined) this.body = details.body;
    if (details.exitCode !== undefined) this.exitCode = details.exitCode;
    if (details.stdout !== undefined) this.stdout = details.stdout;
    if (details.stderr !== undefined) this.stderr = details.stderr;
    if (details.result !== undefined) this.result = details.result;
  }
}

export const isLlmError = (e: unknown, kind?: LlmErrorKind): e is LlmError =>
  e instanceof LlmError && (kind === undefined || e.kind === kind);
