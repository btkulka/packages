/**
 * Why a call to Benhäus failed.
 *
 * - `offline`: no discovery file, or nothing answered at its address (Benhäus is closed).
 * - `unauthorized`: the token was refused (Benhäus restarted with a new one; the next call re-reads it).
 * - `http`: any other non-2xx answer.
 * - `protocol`: a 2xx answer that isn't a JSON-RPC tool result.
 * - `tool`: the tool ran and reported an error (its text is the message). `needs` is set when the
 *   message says a Google account has to be connected or signed in again.
 * - `timeout`, `aborted`: the time limit ran out, or the caller's signal fired.
 */
export type BenhausErrorKind = "offline" | "unauthorized" | "http" | "protocol" | "tool" | "timeout" | "aborted";

export class BenhausError extends Error {
  readonly kind: BenhausErrorKind;
  readonly status?: number;
  readonly tool?: string;
  readonly needs?: "signin" | "connect";

  constructor(kind: BenhausErrorKind, message: string, extra: { status?: number; tool?: string; needs?: "signin" | "connect"; cause?: unknown } = {}) {
    super(message, extra.cause === undefined ? undefined : { cause: extra.cause });
    this.name = "BenhausError";
    this.kind = kind;
    this.status = extra.status;
    this.tool = extra.tool;
    this.needs = extra.needs;
  }
}

export function isBenhausError(e: unknown, kind?: BenhausErrorKind): e is BenhausError {
  return e instanceof BenhausError && (kind === undefined || e.kind === kind);
}

/** Benhäus's Google errors say what to do in words; this reads them back. */
export function needsFrom(message: string): "signin" | "connect" | undefined {
  if (/OAuth client is missing|Add a Google account|No connected Google account/i.test(message)) return "connect";
  if (/sign(ed)? (in|out)|needs signing in/i.test(message)) return "signin";
  return undefined;
}
