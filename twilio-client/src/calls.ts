// Calls: list a page. `GET /2010-04-01/Accounts/{sid}/Calls.json`.

import { isoDate, pageSize, type Call, type CallOptions, type TwilioPage } from "./call.js";

export type TwilioCallStatus = "queued" | "ringing" | "in-progress" | "canceled" | "completed" | "failed" | "busy" | "no-answer" | (string & {});
export type TwilioCallDirection = "inbound" | "outbound-api" | "outbound-dial" | (string & {});

/** A Call resource as Twilio sends it. `callDate` reads when it started. */
export interface TwilioCall {
  sid: string;
  account_sid?: string;
  from: string;
  to: string;
  status: TwilioCallStatus;
  direction: TwilioCallDirection;
  /** Seconds, sent as a string ("42"); null until the call ends. */
  duration?: string | number | null;
  start_time?: string | null;
  end_time?: string | null;
  date_created?: string;
  date_updated?: string;
  price?: string | null;
  price_unit?: string | null;
  uri?: string;
}

/** One page of calls. */
export interface CallPage extends TwilioPage {
  calls: TwilioCall[];
}

export interface ListCallsOptions extends CallOptions {
  /** 1 to 1000. Left out, Twilio sends 50. */
  pageSize?: number;
}

export interface CallsApi {
  /** One page, newest first (Twilio's order). */
  list(options?: ListCallsOptions): Promise<CallPage>;
}

/** When a call started (`start_time`, else `date_created`) as ISO 8601, or "" when Twilio gave neither or it's unreadable. */
export function callDate(c: Pick<TwilioCall, "start_time" | "date_created">): string {
  return isoDate(c.start_time ?? c.date_created);
}

export function callsApi(call: Call): CallsApi {
  return {
    async list(o = {}) {
      const p = await call<Partial<CallPage> | null>("GET", "/Calls.json", { query: { PageSize: pageSize(o.pageSize) }, signal: o.signal });
      return { ...p, calls: p?.calls ?? [], next_page_uri: p?.next_page_uri ?? null };
    },
  };
}
