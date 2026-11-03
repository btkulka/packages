import assert from "node:assert/strict";
import { test } from "node:test";
import { failure, fakeFetch, ok, testClient } from "./fake-fetch.test.js";
import { categoryOf, createResendClient, createThrottle, isResendError, ResendAuthError, ResendError, type FetchLike } from "./index.js";

const EMAIL_ID = "4ef9a417-02e9-4d39-ad75-9611e0fcc33c";

test("every request sends the key, a User-Agent and JSON; Content-Type only with a body", async () => {
  const { fetch, calls } = fakeFetch([ok({ object: "email", id: EMAIL_ID }), ok({ object: "domain", id: "d1" })]);
  const resend = testClient(fetch);
  await resend.emails.get(EMAIL_ID);
  await resend.domains.verify("d1");
  assert.equal(calls[0]!.url, `https://api.resend.com/emails/${EMAIL_ID}`);
  assert.equal(calls[0]!.headers.Authorization, "Bearer re_test");
  assert.equal(calls[0]!.headers["User-Agent"], "btkulka-resend-client/0.1.0");
  assert.equal(calls[0]!.headers.Accept, "application/json");
  assert.equal(calls[0]!.headers["Content-Type"], undefined);
  assert.equal(calls[1]!.init.body, undefined);

  const { fetch: f2, calls: c2 } = fakeFetch([ok({ id: "s" })]);
  await testClient(f2, { baseUrl: "https://example.test/", userAgent: "nhi-dash/1.0" }).segments.create({ name: "Fans" });
  assert.equal(c2[0]!.url, "https://example.test/segments");
  assert.equal(c2[0]!.headers["User-Agent"], "nhi-dash/1.0");
  assert.equal(c2[0]!.headers["Content-Type"], "application/json");
});

test("no key: ResendAuthError before any request", async () => {
  const { fetch, calls } = fakeFetch([ok()]);
  const err = await createResendClient({ apiKey: "  ", fetch }).emails.get(EMAIL_ID).catch((e: unknown) => e);
  assert.ok(err instanceof ResendAuthError);
  assert.equal(err.code, "missing_api_key");
  assert.equal(err.category, "auth");
  assert.equal(err.status, 0);
  assert.equal(calls.length, 0);
});

test("401: ResendAuthError with Resend's status, name and message, never retried", async () => {
  const { fetch, calls } = fakeFetch([failure(401, "missing_api_key", "Missing API key in the authorization header.")]);
  const err = await testClient(fetch).emails.get(EMAIL_ID).catch((e: unknown) => e);
  assert.ok(err instanceof ResendAuthError && err instanceof ResendError);
  assert.equal(err.name, "ResendAuthError");
  assert.equal(err.status, 401);
  assert.equal(err.code, "missing_api_key");
  assert.equal(err.category, "auth");
  assert.match(err.message, /^Resend GET \/emails\/[\w-]+ failed \(401 missing_api_key\): Missing API key/);
  assert.equal(calls.length, 1);
});

test("categories: an invalid or restricted key is auth; an unverified domain is validation", () => {
  assert.equal(categoryOf(400, "validation_error", "API key is invalid"), "auth");
  assert.equal(categoryOf(403, "restricted_api_key", "This API key is restricted to only send emails"), "auth");
  assert.equal(categoryOf(403, "suspended_api_key", "x"), "auth");
  assert.equal(categoryOf(403, "invalid_permission", "x"), "auth");
  assert.equal(categoryOf(403, "validation_error", "The nhi-dj.com domain is not verified."), "validation");
  assert.equal(categoryOf(422, "missing_required_field", "x"), "validation");
  assert.equal(categoryOf(409, "invalid_idempotent_request", "x"), "validation");
  assert.equal(categoryOf(404, "not_found", "x"), "not_found");
  assert.equal(categoryOf(429, "rate_limit_exceeded", "x"), "rate_limit");
  assert.equal(categoryOf(429, "daily_quota_exceeded", "x"), "rate_limit");
  assert.equal(categoryOf(500, "application_error", "x"), "other");
  assert.equal(categoryOf(0, "network"), "other");
});

test("a 403 for an unverified domain is a ResendError of category validation, thrown once", async () => {
  const { fetch, calls } = fakeFetch([failure(403, "validation_error", "The nhi-dj.com domain is not verified.")]);
  const err = await testClient(fetch).emails.send({ from: "a@nhi-dj.com", to: "b@x.com", subject: "s", text: "t" }).catch((e: unknown) => e);
  assert.ok(err instanceof ResendError && !(err instanceof ResendAuthError));
  assert.equal(err.category, "validation");
  assert.ok(isResendError(err, "validation"));
  assert.ok(!isResendError(err, "auth"));
  assert.ok(!isResendError(new Error("x")));
  assert.equal(calls.length, 1);
});

test("404 is category not_found", async () => {
  const { fetch } = fakeFetch([failure(404, "not_found", "Contact not found")]);
  const err = await testClient(fetch).contacts.get("nobody@x.com").catch((e: unknown) => e);
  assert.ok(isResendError(err, "not_found"));
  assert.equal(err.status, 404);
});

test("429 rate_limit_exceeded waits out Retry-After and tries again", async () => {
  const { fetch, calls } = fakeFetch([failure(429, "rate_limit_exceeded", "Too many requests", { "Retry-After": "0" }), ok({ object: "email", id: EMAIL_ID })]);
  const email = await testClient(fetch).emails.get(EMAIL_ID);
  assert.equal(email.id, EMAIL_ID);
  assert.equal(calls.length, 2);
});

test("a sending quota 429 is category rate_limit and never retried", async () => {
  const { fetch, calls } = fakeFetch([failure(429, "daily_quota_exceeded", "You have reached your daily email sending quota.")]);
  const err = await testClient(fetch).emails.send({ from: "a@nhi-dj.com", to: "b@x.com", subject: "s", text: "t" }).catch((e: unknown) => e);
  assert.ok(isResendError(err, "rate_limit"));
  assert.equal(err.code, "daily_quota_exceeded");
  assert.equal(calls.length, 1);
});

test("a 5xx backs off and retries until the attempts run out", async () => {
  const { fetch, calls } = fakeFetch([failure(500, "application_error", "Something went wrong")]);
  const err = await testClient(fetch, { attempts: 3 }).segments.list().catch((e: unknown) => e);
  assert.ok(isResendError(err, "other"));
  assert.equal(err.code, "application_error");
  assert.equal(calls.length, 3);
});

test("a 409 for a request still running under the same Idempotency-Key is retried", async () => {
  const { fetch, calls } = fakeFetch([failure(409, "concurrent_idempotent_requests", "Same idempotency key used while original request is still in progress."), ok({ id: EMAIL_ID })]);
  const r = await testClient(fetch).emails.send({ from: "a@nhi-dj.com", to: "b@x.com", subject: "s", text: "t" }, { idempotencyKey: "k1" });
  assert.equal(r.id, EMAIL_ID);
  assert.equal(calls.length, 2);
});

test("a dropped connection becomes a ResendError of kind network once the attempts run out", async () => {
  const { fetch, calls } = fakeFetch([new Error("socket hang up")]);
  const err = await testClient(fetch, { attempts: 2 }).domains.list().catch((e: unknown) => e);
  assert.ok(err instanceof ResendError);
  assert.equal(err.kind, "network");
  assert.equal(err.code, "network");
  assert.equal(err.category, "other");
  assert.equal(err.status, 0);
  assert.equal(calls.length, 2);
});

test("an attempt that outlasts timeoutMs is a timeout", async () => {
  const hang: FetchLike = (_url, init) => new Promise((_res, reject) => init?.signal?.addEventListener("abort", () => reject(new Error("aborted"))));
  const err = await testClient(hang, { timeoutMs: 20, attempts: 1 }).domains.list().catch((e: unknown) => e);
  assert.ok(err instanceof ResendError);
  assert.equal(err.kind, "timeout");
  assert.equal(err.code, "timeout");
});

test("the caller's signal aborts and is never retried", async () => {
  const ac = new AbortController();
  let n = 0;
  let started!: () => void;
  const inFlight = new Promise<void>((r) => (started = r));
  const hang: FetchLike = (_url, init) => {
    n++;
    started();
    return new Promise((_res, reject) => init?.signal?.addEventListener("abort", () => reject(new Error("aborted"))));
  };
  const pending = testClient(hang).emails.get(EMAIL_ID, { signal: ac.signal });
  await inFlight;
  ac.abort();
  const err = await pending.catch((e: unknown) => e);
  assert.ok(err instanceof ResendError);
  assert.equal(err.kind, "aborted");
  assert.equal(n, 1);
});

test("an empty id fails before any request", async () => {
  const { fetch, calls } = fakeFetch([ok()]);
  const resend = testClient(fetch);
  await assert.rejects(resend.emails.get(""), (e: unknown) => isResendError(e, "validation") && e.code === "validation_error");
  await assert.rejects(resend.contacts.get("  "), (e: unknown) => isResendError(e, "validation"));
  await assert.rejects(resend.broadcasts.send(""), (e: unknown) => isResendError(e, "validation"));
  assert.equal(calls.length, 0);
});

test("the client throttles at 2 a second unless told otherwise, and can share a throttle", () => {
  const { fetch } = fakeFetch([ok()]);
  assert.equal(createResendClient({ apiKey: "re_x", fetch }).throttle.requestsPerSecond, 2);
  assert.equal(createResendClient({ apiKey: "re_x", fetch, requestsPerSecond: 5 }).throttle.requestsPerSecond, 5);
  const shared = createThrottle({ requestsPerSecond: 3 });
  assert.equal(createResendClient({ apiKey: "re_x", fetch, throttle: shared }).throttle, shared);
});
