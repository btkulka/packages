// What the resource files share: the client's one call, Resend's list paging, path segments and
// dates. Resend's own field names stay as Resend writes them (snake_case); this package's options
// (signal, idempotencyKey, validation) are camelCase.

import type { FormFields } from "@btkulka/http-kit";
import { invalid } from "./errors.js";

export interface CallOptions {
  signal?: AbortSignal;
}

export interface CallInit extends CallOptions {
  body?: unknown;
  query?: FormFields;
  headers?: Record<string, string>;
  /**
   * "rate_limit": retry only a 429, which Resend refused without doing anything; for calls a repeat
   * could double, like sending a broadcast. Default "any": 429, 5xx, timeouts and dropped connections.
   */
  retry?: "any" | "rate_limit";
}

/** The client's request, as the resource files call it. `path` is under https://api.resend.com. */
export type Call = <T>(method: string, path: string, init?: CallInit) => Promise<T>;

/** One page of a Resend list. */
export interface ResendList<T> {
  object: "list";
  has_more: boolean;
  data: T[];
}

/** Resend's cursor paging: by id, the cursor itself left out. One of `after` and `before`, not both. */
export interface ListOptions extends CallOptions {
  /** 1 to 100. Left out, most lists return everything; the full contact list returns 20. */
  limit?: number;
  /** The page after this id. */
  after?: string;
  /** The page before this id. */
  before?: string;
}

/** Resend's ceiling on `limit`. */
export const MAX_LIMIT = 100;

export function listQuery(o: ListOptions = {}): FormFields {
  if (o.after && o.before) throw invalid("Pass `after` or `before`, not both.");
  return {
    limit: o.limit == null ? undefined : Math.max(1, Math.min(MAX_LIMIT, Math.floor(o.limit))),
    after: o.after || undefined,
    before: o.before || undefined,
  };
}

/**
 * One path segment: an id, or a contact's email. Anything that would break the path is escaped;
 * `@` and `+` stay as they are, the way Resend's own examples and SDK send an address.
 */
export function seg(value: string | null | undefined, what: string): string {
  const v = (value ?? "").trim();
  if (!v) throw invalid(`No ${what} given.`);
  return encodeURIComponent(v).replace(/%40/g, "@").replace(/%2B/gi, "+");
}

/** A `scheduled_at`: a Date as ISO 8601; a string (ISO 8601, or Resend's natural language like "in 1 hour") as it is. */
export function when(at: string | Date | undefined): string | undefined {
  return at instanceof Date ? at.toISOString() : at;
}
