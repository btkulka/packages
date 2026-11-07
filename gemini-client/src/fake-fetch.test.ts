// The fake fetch every test here runs against: canned replies in order (or a router), every request
// recorded. Nothing talks to Google. It's a .test file so neither build ships it.

import assert from "node:assert/strict";
import { test } from "node:test";
import { createGeminiClient, type FetchLikeInit, type GeminiClientOptions, type GeminiFetch } from "./index.js";

export type Reply = { status: number; body?: unknown; headers?: Record<string, string> } | Error;

export interface FakeCall {
  url: string;
  /** The path and query, without https://generativelanguage.googleapis.com/v1beta */
  path: string;
  method: string;
  headers: Record<string, string>;
  /** The body parsed from JSON; undefined when none was sent. */
  body: unknown;
  init: FetchLikeInit;
}

/** Replies in order (the last repeats), or a function of the request. A Uint8Array body is served as bytes. */
export function fakeFetch(replies: Reply[] | ((call: FakeCall, n: number) => Reply)) {
  const calls: FakeCall[] = [];
  let i = 0;
  const fetch: GeminiFetch = (url, init = {}) => {
    const call: FakeCall = {
      url,
      path: url.replace(/^https:\/\/generativelanguage\.googleapis\.com\/v1beta/, ""),
      method: init.method ?? "GET",
      headers: init.headers ?? {},
      body: init.body === undefined ? undefined : JSON.parse(init.body),
      init,
    };
    calls.push(call);
    const n = i++;
    const r = typeof replies === "function" ? replies(call, n) : replies[Math.min(n, replies.length - 1)]!;
    if (r instanceof Error) return Promise.reject(r);
    const h = new Map(Object.entries(r.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
    const bytes = r.body instanceof Uint8Array ? r.body : undefined;
    const text = bytes ? String.fromCharCode(...bytes) : r.body === undefined ? "" : typeof r.body === "string" ? r.body : JSON.stringify(r.body);
    return Promise.resolve({
      ok: r.status >= 200 && r.status < 300,
      status: r.status,
      headers: { get: (k: string) => h.get(k.toLowerCase()) ?? null },
      text: async () => text,
      arrayBuffer: async () => (bytes ?? new TextEncoder().encode(text)).slice().buffer as ArrayBuffer,
    });
  };
  return { fetch, calls };
}

/** A 200 with this body. */
export const ok = (body: unknown = {}, headers?: Record<string, string>): Reply => ({ status: 200, body, headers });
/** Google's error body: `{ error: { code, message, status, details } }`, with an ErrorInfo reason when given. */
export const failure = (status: number, code: string, message: string, reason?: string, headers?: Record<string, string>, extraDetails: unknown[] = []): Reply => ({
  status,
  body: {
    error: {
      code: status,
      message,
      status: code,
      details: [...(reason ? [{ "@type": "type.googleapis.com/google.rpc.ErrorInfo", reason, domain: "googleapis.com" }] : []), ...extraDetails],
    },
  },
  headers,
});

/** A finished Omni interaction carrying `video` (bytes) inline. */
export const completed = (id: string, video: Uint8Array | null = new Uint8Array([0, 0, 0, 24, 102, 116, 121, 112]), extra: Record<string, unknown> = {}) => ({
  id,
  object: "interaction",
  status: "completed",
  model: "gemini-omni-1.1-flash",
  steps: [
    { type: "thought", summary: [{ type: "text", text: "Planning the shot." }] },
    { type: "model_output", content: video ? [{ type: "video", mime_type: "video/mp4", data: btoa(String.fromCharCode(...video)) }] : [{ type: "text", text: "I can't make that video." }] },
  ],
  usage: { total_input_tokens: 40, total_output_tokens: 46_336, total_thought_tokens: 200, output_tokens_by_modality: [{ modality: "video", tokens: 46_336 }] },
  ...extra,
});

export const inProgress = (id: string) => ({ id, object: "interaction", status: "in_progress", model: "gemini-omni-1.1-flash" });

/** A client on the fake: no backoff unless the test says otherwise. */
export const testClient = (fetch: GeminiFetch, extra: Partial<GeminiClientOptions> = {}) => createGeminiClient({ apiKey: "AIza-test", fetch, baseDelayMs: 0, ...extra });

test("the fake fetch replays its replies in order, repeats the last, serves bytes and records each request", async () => {
  const { fetch, calls } = fakeFetch([ok({ n: 1 }), { status: 200, body: new Uint8Array([1, 2, 255]) }]);
  const a = await fetch("https://generativelanguage.googleapis.com/v1beta/x?y=1", { method: "POST", body: '{"a":1}' });
  const b = await fetch("https://generativelanguage.googleapis.com/v1beta/x");
  const c = await fetch("https://generativelanguage.googleapis.com/v1beta/x");
  assert.deepEqual(JSON.parse(await a.text()), { n: 1 });
  assert.deepEqual([...new Uint8Array(await b.arrayBuffer!())], [1, 2, 255]);
  assert.equal(c.status, 200);
  assert.equal(calls[0]!.path, "/x?y=1");
  assert.equal(calls[0]!.method, "POST");
  assert.deepEqual(calls[0]!.body, { a: 1 });
  assert.equal(calls[1]!.body, undefined);
});
