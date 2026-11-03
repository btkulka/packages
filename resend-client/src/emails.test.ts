import assert from "node:assert/strict";
import { test } from "node:test";
import { failure, fakeFetch, ok, testClient } from "./fake-fetch.test.js";
import { isResendError, MAX_BATCH, type SendEmailInput } from "./index.js";

const ID = "49a3999c-0ce1-4ea6-ab68-afcd6dc2e794";
const mail = (to: string): SendEmailInput => ({ from: "NHI <hello@nhi-dj.com>", to, subject: "New flip", html: "<p>Out Friday</p>" });

test("send posts the email with the app's Idempotency-Key", async () => {
  const { fetch, calls } = fakeFetch([ok({ id: ID })]);
  const r = await testClient(fetch).emails.send(
    { ...mail("fan@x.com"), cc: ["a@x.com"], reply_to: "ben@nhi-dj.com", tags: [{ name: "kind", value: "flip" }], attachments: [{ filename: "a.txt", content: "aGk=" }] },
    { idempotencyKey: "release/flip-7" },
  );
  assert.equal(r.id, ID);
  assert.equal(calls[0]!.method, "POST");
  assert.equal(calls[0]!.path, "/emails");
  assert.equal(calls[0]!.headers["Idempotency-Key"], "release/flip-7");
  assert.deepEqual(calls[0]!.body, {
    from: "NHI <hello@nhi-dj.com>",
    to: "fan@x.com",
    subject: "New flip",
    html: "<p>Out Friday</p>",
    cc: ["a@x.com"],
    reply_to: "ben@nhi-dj.com",
    tags: [{ name: "kind", value: "flip" }],
    attachments: [{ filename: "a.txt", content: "aGk=" }],
  });
});

test("send without a key makes one, and its retries reuse it so they can't send twice", async () => {
  const { fetch, calls } = fakeFetch([failure(500, "application_error", "oops"), new Error("socket hang up"), ok({ id: ID })]);
  await testClient(fetch).emails.send(mail("fan@x.com"));
  assert.equal(calls.length, 3);
  const key = calls[0]!.headers["Idempotency-Key"]!;
  assert.match(key, /^resend-client\/[0-9a-f-]{36}$/);
  assert.equal(calls[1]!.headers["Idempotency-Key"], key);
  assert.equal(calls[2]!.headers["Idempotency-Key"], key);

  const { fetch: f2, calls: c2 } = fakeFetch([ok({ id: ID })]);
  const resend = testClient(f2);
  await resend.emails.send(mail("a@x.com"));
  await resend.emails.send(mail("a@x.com"));
  assert.notEqual(c2[0]!.headers["Idempotency-Key"], c2[1]!.headers["Idempotency-Key"], "each call is its own send");
});

test("scheduled_at takes a Date (sent as ISO 8601) or Resend's own words", async () => {
  const { fetch, calls } = fakeFetch([ok({ id: ID })]);
  const resend = testClient(fetch);
  await resend.emails.send({ ...mail("fan@x.com"), scheduled_at: new Date("2026-11-06T15:00:00Z") });
  await resend.emails.send({ ...mail("fan@x.com"), scheduled_at: "in 1 hour" });
  assert.equal((calls[0]!.body as { scheduled_at: string }).scheduled_at, "2026-11-06T15:00:00.000Z");
  assert.equal((calls[1]!.body as { scheduled_at: string }).scheduled_at, "in 1 hour");
});

test("batch posts the array with one key, and the validation mode only when asked", async () => {
  const { fetch, calls } = fakeFetch([ok({ data: [{ id: "e1" }, { id: "e2" }] }), ok({ data: [{ id: "e3" }], errors: [{ index: 1, message: "Invalid `to` field." }] })]);
  const resend = testClient(fetch);
  const strict = await resend.emails.batch([mail("a@x.com"), mail("b@x.com")], { idempotencyKey: "batch/1" });
  assert.deepEqual(strict.data, [{ id: "e1" }, { id: "e2" }]);
  assert.equal(calls[0]!.path, "/emails/batch");
  assert.equal(calls[0]!.headers["Idempotency-Key"], "batch/1");
  assert.equal(calls[0]!.headers["x-batch-validation"], undefined);
  assert.deepEqual(calls[0]!.body, [mail("a@x.com"), mail("b@x.com")]);

  const loose = await resend.emails.batch([mail("a@x.com"), mail("not-an-email")], { validation: "permissive" });
  assert.equal(calls[1]!.headers["x-batch-validation"], "permissive");
  assert.match(calls[1]!.headers["Idempotency-Key"]!, /^resend-client\//);
  assert.deepEqual(loose.errors, [{ index: 1, message: "Invalid `to` field." }]);
});

test("batch takes 1 to 100 emails, and says so before any request", async () => {
  const { fetch, calls } = fakeFetch([ok({ data: [] })]);
  const resend = testClient(fetch);
  const many = Array.from({ length: MAX_BATCH + 1 }, (_, i) => mail(`f${i}@x.com`));
  await assert.rejects(resend.emails.batch(many), (e: unknown) => isResendError(e, "validation") && /up to 100 emails, not 101/.test(e.message));
  await assert.rejects(resend.emails.batch([]), (e: unknown) => isResendError(e, "validation"));
  assert.equal(calls.length, 0);
  await resend.emails.batch(many.slice(0, MAX_BATCH));
  assert.equal((calls[0]!.body as unknown[]).length, 100);
});

test("get reads an email by id", async () => {
  const email = { object: "email", id: ID, to: ["fan@x.com"], from: "hello@nhi-dj.com", subject: "s", html: null, text: "t", last_event: "delivered", created_at: "2026-04-03 22:13:42.674981+00", scheduled_at: null };
  const { fetch, calls } = fakeFetch([ok(email)]);
  const got = await testClient(fetch).emails.get(ID);
  assert.equal(got.last_event, "delivered");
  assert.equal(calls[0]!.method, "GET");
  assert.equal(calls[0]!.path, `/emails/${ID}`);
});
