// What the resource files share: the client's one call, Twilio's list pages and its dates. Twilio's
// own field names stay as Twilio writes them (snake_case in what comes back); this package's
// options are camelCase and become Twilio's PascalCase parameters (To, From, PageSize) on the way out.

import type { FormFields } from "@btkulka/http-kit";

export interface CallOptions {
  signal?: AbortSignal;
}

export interface CallInit extends CallOptions {
  /** A form body (Twilio takes application/x-www-form-urlencoded, never JSON). */
  form?: FormFields;
  query?: FormFields;
  /**
   * "rate_limit": retry only a 429, which Twilio refused without doing anything; for calls a repeat
   * could double, like sending a text. Default "any": 429, 5xx, timeouts and dropped connections.
   */
  retry?: "any" | "rate_limit";
}

/**
 * The client's request, as the resource files call it. `path` is under the account (`/Messages.json`,
 * or `.json` for the account itself), or a whole API path Twilio handed back (`/2010-04-01/…`, a
 * `next_page_uri`).
 */
export type Call = <T>(method: string, path: string, init?: CallInit) => Promise<T>;

/** What every page of a Twilio list carries besides its items. */
export interface TwilioPage {
  page?: number;
  page_size?: number;
  uri?: string;
  first_page_uri?: string;
  previous_page_uri?: string | null;
  /** The next page's path (under https://api.twilio.com), or null on the last page. */
  next_page_uri: string | null;
}

/** Twilio's ceiling on `PageSize`. */
export const MAX_PAGE_SIZE = 1000;

/** `PageSize` from an option: a whole number from 1 to 1000, or left out. */
export function pageSize(n: number | undefined): number | undefined {
  return n == null || !Number.isFinite(n) ? undefined : Math.max(1, Math.min(MAX_PAGE_SIZE, Math.floor(n)));
}

/** A day for Twilio's date filters (GMT, YYYY-MM-DD): a Date's UTC day, or a string as it is. */
export function day(at: Date | string | undefined): string | undefined {
  return at instanceof Date ? at.toISOString().slice(0, 10) : at || undefined;
}

/** One of Twilio's dates (RFC 2822: "Wed, 18 Aug 2010 20:01:40 +0000") as ISO 8601, or "" when it's missing or unreadable. */
export function isoDate(rfc2822: string | null | undefined): string {
  if (!rfc2822) return "";
  const d = new Date(rfc2822);
  return Number.isNaN(d.getTime()) ? "" : d.toISOString();
}
