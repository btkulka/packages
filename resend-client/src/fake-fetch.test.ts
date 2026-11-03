// The fake fetch every test here runs against: canned replies in order, every request recorded.
// Nothing talks to Resend. It's a .test file so neither build ships it.

import assert from "node:assert/strict";
import { test } from "node:test";
import { createResendClient, type FetchLike, type FetchLikeInit, type ResendClientOptions } from "./index.js";

export type Reply = { status: number; body?: unknown; headers?: Record<string, string> } | Error;

export interface FakeCall {
  url: string;
  /** The path and query, without https://api.resend.com */
  path: string;
  method: string;
  headers: Record<string, string>;
  /** The body parsed from JSON; undefined when none was sent. */
  body: unknown;
  init: FetchLikeInit;
  /** performance.now() when the request went out. */
  at: number;
}

/** Replies in order; the last reply repeats. */
export function fakeFetch(replies: Reply[]) {
  const calls: FakeCall[] = [];
  let i = 0;
  const fetch: FetchLike = (url, init = {}) => {
    calls.push({
      url,
      path: url.replace(/^https:\/\/api\.resend\.com/, ""),
      method: init.method ?? "GET",
      headers: init.headers ?? {},
      body: init.body === undefined ? undefined : JSON.parse(init.body),
      init,
      at: performance.now(),
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

/** A 200 with this body. */
export const ok = (body: unknown = {}, headers?: Record<string, string>): Reply => ({ status: 200, body, headers });
/** Resend's error body: `{ statusCode, name, message }`. */
export const failure = (status: number, name: string, message: string, headers?: Record<string, string>): Reply => ({ status, body: { statusCode: status, name, message }, headers });
/** One page of a list. */
export const page = (data: unknown[], has_more = false): Reply => ok({ object: "list", has_more, data });

/** A client on the fake: no backoff, no throttle, unless the test says otherwise. */
export const testClient = (fetch: FetchLike, extra: Partial<ResendClientOptions> = {}) =>
  createResendClient({ apiKey: "re_test", fetch, baseDelayMs: 0, requestsPerSecond: Infinity, ...extra });

test("the fake fetch replays its replies in order, repeats the last, and records each request", async () => {
  const { fetch, calls } = fakeFetch([ok({ n: 1 }), failure(422, "validation_error", "nope")]);
  const a = await fetch("https://api.resend.com/x?y=1", { method: "POST", body: '{"a":1}' });
  const b = await fetch("https://api.resend.com/x");
  const c = await fetch("https://api.resend.com/x");
  assert.deepEqual(JSON.parse(await a.text()), { n: 1 });
  assert.equal(b.status, 422);
  assert.equal(c.status, 422);
  assert.equal(calls[0]!.path, "/x?y=1");
  assert.equal(calls[0]!.method, "POST");
  assert.deepEqual(calls[0]!.body, { a: 1 });
  assert.equal(calls[1]!.method, "GET");
  assert.equal(calls[1]!.body, undefined);
});
