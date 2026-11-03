import assert from "node:assert/strict";
import { test } from "node:test";
import { failure, fakeFetch, ok, page, testClient } from "./fake-fetch.test.js";
import { isResendError, mergeTag, RESEND_UNSUBSCRIBE_URL, type CreateBroadcastInput } from "./index.js";

const B = "49a3999c-0ce1-4ea6-ab68-afcd6dc2e794";
const S = "78261eea-8f8b-4381-83c6-79fa7120f1cf";
const html = `<p>Hi ${mergeTag("first_name", "there")}, the flip is out.</p><a href="${RESEND_UNSUBSCRIBE_URL}">Unsubscribe</a>`;
const input: CreateBroadcastInput = { segment_id: S, from: "NHI <news@nhi-dj.com>", reply_to: "ben@nhi-dj.com", subject: "New flip", html, text: "The flip is out.", name: "Flip 7" };

test("create posts a draft with only a broadcast's fields: a stray send or scheduled_at never reaches Resend", async () => {
  const { fetch, calls } = fakeFetch([ok({ object: "broadcast", id: B })]);
  const sneaky = { ...input, send: true, scheduled_at: "in 1 min" } as CreateBroadcastInput;
  const r = await testClient(fetch).broadcasts.create(sneaky);
  assert.equal(r.id, B);
  assert.equal(calls[0]!.method, "POST");
  assert.equal(calls[0]!.path, "/broadcasts");
  assert.deepEqual(calls[0]!.body, input);
  assert.match((calls[0]!.body as { html: string }).html, /\{\{\{contact\.first_name\|there\}\}\}.*\{\{\{RESEND_UNSUBSCRIBE_URL\}\}\}/);
});

test("get, list, update and delete", async () => {
  const full = { object: "broadcast", id: B, name: "Flip 7", segment_id: S, audience_id: S, from: input.from, subject: input.subject, reply_to: null, preview_text: null, html, text: null, status: "draft", created_at: "2026-11-01 15:13:31.723+00", scheduled_at: null, sent_at: null };
  const { fetch, calls } = fakeFetch([ok(full), page([{ id: B, name: "Flip 7", segment_id: S, status: "draft", created_at: full.created_at, scheduled_at: null, sent_at: null }]), ok({ object: "broadcast", id: B }), ok({ object: "broadcast", id: B, deleted: true })]);
  const resend = testClient(fetch);
  assert.equal((await resend.broadcasts.get(B)).status, "draft");
  assert.equal((await resend.broadcasts.list({ limit: 20 })).data.length, 1);
  await resend.broadcasts.update(B, { subject: "New flip, out Friday", send: true } as never);
  assert.equal((await resend.broadcasts.delete(B)).deleted, true);
  assert.deepEqual(
    calls.map((c) => `${c.method} ${c.path}`),
    [`GET /broadcasts/${B}`, "GET /broadcasts?limit=20", `PATCH /broadcasts/${B}`, `DELETE /broadcasts/${B}`],
  );
  assert.deepEqual(calls[2]!.body, { subject: "New flip, out Friday" });
});

test("send goes now with an empty body, or at scheduled_at (a Date as ISO 8601)", async () => {
  const { fetch, calls } = fakeFetch([ok({ id: B })]);
  const resend = testClient(fetch);
  await resend.broadcasts.send(B);
  await resend.broadcasts.send(B, { scheduled_at: "in 1 hour" });
  await resend.broadcasts.send(B, { scheduled_at: new Date("2026-11-06T15:00:00Z") });
  assert.equal(calls[0]!.method, "POST");
  assert.equal(calls[0]!.path, `/broadcasts/${B}/send`);
  assert.deepEqual(calls[0]!.body, {});
  assert.deepEqual(calls[1]!.body, { scheduled_at: "in 1 hour" });
  assert.deepEqual(calls[2]!.body, { scheduled_at: "2026-11-06T15:00:00.000Z" });
});

test("send retries a 429, but not a 5xx or a dropped connection, which may have gone out", async () => {
  const { fetch, calls } = fakeFetch([failure(429, "rate_limit_exceeded", "Too many requests", { "Retry-After": "0" }), ok({ id: B })]);
  await testClient(fetch).broadcasts.send(B);
  assert.equal(calls.length, 2);

  const { fetch: f2, calls: c2 } = fakeFetch([failure(500, "application_error", "oops")]);
  await assert.rejects(testClient(f2).broadcasts.send(B), (e: unknown) => isResendError(e, "other") && e.status === 500);
  assert.equal(c2.length, 1);

  const { fetch: f3, calls: c3 } = fakeFetch([new Error("socket hang up")]);
  await assert.rejects(testClient(f3).broadcasts.send(B), (e: unknown) => isResendError(e) && e.kind === "network");
  assert.equal(c3.length, 1);

  const { fetch: f4, calls: c4 } = fakeFetch([failure(429, "monthly_quota_exceeded", "quota")]);
  await assert.rejects(testClient(f4).broadcasts.send(B), (e: unknown) => isResendError(e, "rate_limit"));
  assert.equal(c4.length, 1);
});
