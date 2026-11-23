// The fake fetch every test here runs against: canned replies in order, every request recorded.
// Nothing talks to Twilio. It's a .test file so neither build ships it.

import assert from "node:assert/strict";
import { test } from "node:test";
import { createTwilioClient, type FetchLike, type FetchLikeInit, type TwilioClientOptions } from "./index.js";

export type Reply = { status: number; body?: unknown; headers?: Record<string, string> } | Error;

export interface FakeCall {
  url: string;
  /** The path and query, without https://api.twilio.com */
  path: string;
  /** The path without its query. */
  pathname: string;
  /** The query as an object (a repeated name keeps its last value). */
  query: Record<string, string>;
  method: string;
  headers: Record<string, string>;
  /** A form body as an object; undefined when none was sent. */
  form: Record<string, string> | undefined;
  init: FetchLikeInit;
}

/** Replies in order; the last reply repeats. */
export function fakeFetch(replies: Reply[]) {
  const calls: FakeCall[] = [];
  let i = 0;
  const fetch: FetchLike = (url, init = {}) => {
    const path = url.replace(/^https:\/\/api\.twilio\.com/, "");
    const [pathname, qs = ""] = path.split("?");
    calls.push({
      url,
      path,
      pathname: pathname!,
      query: Object.fromEntries(new URLSearchParams(qs)),
      method: init.method ?? "GET",
      headers: init.headers ?? {},
      form: init.body === undefined ? undefined : Object.fromEntries(new URLSearchParams(init.body)),
      init,
    });
    const r = replies[Math.min(i++, replies.length - 1)]!;
    if (r instanceof Error) return Promise.reject(r);
    const h = new Map(Object.entries(r.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
    const text = r.body === undefined ? "" : typeof r.body === "string" ? r.body : JSON.stringify(r.body);
    return Promise.resolve({
      ok: r.status >= 200 && r.status < 300,
      status: r.status,
      headers: { get: (n: string) => h.get(n.toLowerCase()) ?? null },
      text: async () => text,
    });
  };
  return { fetch, calls };
}

export const SID = "AC00000000000000000000000000000000";
export const ACCOUNT = `/2010-04-01/Accounts/${SID}`;

/** A 200 (or 201) with this body. */
export const ok = (body: unknown = {}, status = 200): Reply => ({ status, body });
/** Twilio's error body: `{ code, message, more_info, status }`. */
export const failure = (status: number, code: number, message: string, headers?: Record<string, string>): Reply => ({
  status,
  body: { code, message, more_info: `https://www.twilio.com/docs/errors/${code}`, status },
  headers,
});

/** A client on the fake, signed in with the Auth Token, no backoff unless the test says otherwise. */
export const testClient = (fetch: FetchLike, extra: Partial<TwilioClientOptions> = {}) =>
  createTwilioClient({ accountSid: SID, authToken: "token", fetch, baseDelayMs: 0, ...extra });

/** A Message resource with Twilio's fields; `over` replaces any. */
export const msg = (sid: string, over: Record<string, unknown> = {}) => ({
  sid,
  account_sid: SID,
  from: "+15125550111",
  to: "+18885550100",
  body: `text ${sid}`,
  status: "received",
  direction: "inbound",
  date_sent: "Fri, 23 Oct 2026 15:00:00 +0000",
  date_created: "Fri, 23 Oct 2026 15:00:00 +0000",
  num_media: "0",
  ...over,
});

test("the fake fetch replays its replies in order, repeats the last, and records each request", async () => {
  const { fetch, calls } = fakeFetch([ok({ n: 1 }), failure(400, 21211, "nope")]);
  const a = await fetch("https://api.twilio.com/x?y=1&z=2", { method: "POST", body: "To=%2B1&Body=hi" });
  const b = await fetch("https://api.twilio.com/x");
  const c = await fetch("https://api.twilio.com/x");
  assert.deepEqual(JSON.parse(await a.text()), { n: 1 });
  assert.equal(b.status, 400);
  assert.equal(c.status, 400);
  assert.equal(calls[0]!.pathname, "/x");
  assert.deepEqual(calls[0]!.query, { y: "1", z: "2" });
  assert.equal(calls[0]!.method, "POST");
  assert.deepEqual(calls[0]!.form, { To: "+1", Body: "hi" });
  assert.equal(calls[1]!.method, "GET");
  assert.equal(calls[1]!.form, undefined);
});
