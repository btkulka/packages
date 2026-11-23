import assert from "node:assert/strict";
import { test } from "node:test";
import { ACCOUNT, SID, failure, fakeFetch, ok, testClient } from "./fake-fetch.test.js";
import { createTwilioClient, isTwilioError, TwilioAuthError, TwilioError } from "./index.js";

const basic = (user: string, pass: string) => `Basic ${btoa(`${user}:${pass}`)}`;

test("every request signs in with Basic auth (Account SID and Auth Token) and asks for JSON; a form only with a body", async () => {
  const { fetch, calls } = fakeFetch([ok({ sid: SID, friendly_name: "Orange" }), ok({ sid: "SM1" }, 201)]);
  const twilio = testClient(fetch);
  const a = await twilio.account.get();
  assert.equal(a.friendly_name, "Orange");
  assert.equal(calls[0]!.url, `https://api.twilio.com${ACCOUNT}.json`);
  assert.equal(calls[0]!.method, "GET");
  assert.equal(calls[0]!.headers.Authorization, basic(SID, "token"));
  assert.equal(calls[0]!.headers.Accept, "application/json");
  assert.equal(calls[0]!.headers["Content-Type"], undefined);
  assert.equal(calls[0]!.init.body, undefined);

  await twilio.messages.send({ to: "+15125550111", body: "hi", from: "+18885550100" });
  assert.equal(calls[1]!.headers["Content-Type"], "application/x-www-form-urlencoded");
  assert.equal(twilio.accountSid, SID);
});

test("an API key and secret sign in instead of the Auth Token; a key without its secret falls back to the token", async () => {
  const { fetch, calls } = fakeFetch([ok({ sid: SID })]);
  await testClient(fetch, { apiKey: "SKkey", apiSecret: "shh" }).account.get();
  await testClient(fetch, { apiKey: "SKkey" }).account.get();
  assert.equal(calls[0]!.headers.Authorization, basic("SKkey", "shh"));
  assert.equal(calls[0]!.pathname, `${ACCOUNT}.json`);
  assert.equal(calls[1]!.headers.Authorization, basic(SID, "token"));
});

test("no credentials: TwilioAuthError before any request", async () => {
  const { fetch, calls } = fakeFetch([ok()]);
  for (const opts of [{ accountSid: "  ", authToken: "t" }, { accountSid: SID }, { accountSid: SID, apiSecret: "s" }]) {
    const err = await createTwilioClient({ ...opts, fetch }).messages.list().catch((e: unknown) => e);
    assert.ok(err instanceof TwilioAuthError && err instanceof TwilioError);
    assert.equal(err.status, 0);
    assert.match(err.message, /No Twilio credentials/);
  }
  assert.equal(calls.length, 0);
});

test("a Twilio error: status, code, Twilio's message and more_info; message `Twilio <status>: …`; a 4xx thrown once", async () => {
  const { fetch, calls } = fakeFetch([failure(400, 21211, "The 'To' number +1555 is not a valid phone number.")]);
  const err = await testClient(fetch).messages.send({ to: "+1555", body: "x", from: "+18885550100" }).catch((e: unknown) => e);
  assert.ok(err instanceof TwilioError && !(err instanceof TwilioAuthError));
  assert.equal(err.name, "TwilioError");
  assert.equal(err.status, 400);
  assert.equal(err.code, 21211);
  assert.equal(err.twilioMessage, "The 'To' number +1555 is not a valid phone number.");
  assert.equal(err.moreInfo, "https://www.twilio.com/docs/errors/21211");
  assert.equal(err.message, "Twilio 400: The 'To' number +1555 is not a valid phone number.");
  assert.equal(err.url, `https://api.twilio.com${ACCOUNT}/Messages.json`);
  assert.ok(isTwilioError(err));
  assert.ok(isTwilioError(err, 21211));
  assert.ok(!isTwilioError(err, 21610));
  assert.ok(!isTwilioError(new Error("x")));
  assert.equal(calls.length, 1);
});

test("401, or code 20003: TwilioAuthError, never retried", async () => {
  const { fetch, calls } = fakeFetch([failure(401, 20003, "Authenticate")]);
  const err = await testClient(fetch).messages.list().catch((e: unknown) => e);
  assert.ok(err instanceof TwilioAuthError);
  assert.equal(err.name, "TwilioAuthError");
  assert.equal(err.code, 20003);
  assert.equal(err.message, "Twilio 401: Authenticate");
  assert.equal(calls.length, 1);
});

test("an error body that isn't JSON: its first 200 characters", async () => {
  const { fetch } = fakeFetch([{ status: 502, body: `<html>${"x".repeat(300)}</html>` }]);
  const err = await testClient(fetch, { attempts: 1 }).calls.list().catch((e: unknown) => e);
  assert.ok(err instanceof TwilioError);
  assert.equal(err.status, 502);
  assert.equal(err.code, null);
  assert.equal(err.twilioMessage, null);
  assert.equal(err.message, `Twilio 502: <html>${"x".repeat(194)}`);
});

test("a read retries a 5xx and a 429 (waiting out Retry-After), up to `attempts`", async () => {
  const { fetch, calls } = fakeFetch([failure(500, 20500, "Internal"), failure(429, 20429, "Too Many Requests", { "Retry-After": "0" }), ok({ messages: [], next_page_uri: null })]);
  const page = await testClient(fetch).messages.list();
  assert.deepEqual(page.messages, []);
  assert.equal(calls.length, 3);

  const { fetch: f2, calls: c2 } = fakeFetch([failure(503, 20503, "Unavailable")]);
  const err = await testClient(f2, { attempts: 2 }).messages.list().catch((e: unknown) => e);
  assert.ok(err instanceof TwilioError);
  assert.equal(err.status, 503);
  assert.equal(c2.length, 2);
});

test("no answer: a TwilioError of kind network or timeout, status 0", async () => {
  const { fetch, calls } = fakeFetch([new TypeError("fetch failed")]);
  const err = await testClient(fetch, { attempts: 2 }).account.get().catch((e: unknown) => e);
  assert.ok(err instanceof TwilioError);
  assert.equal(err.kind, "network");
  assert.equal(err.status, 0);
  assert.match(err.message, /^Twilio GET \/2010-04-01\/Accounts\/AC0+\.json to api\.twilio\.com failed: fetch failed/);
  assert.equal(calls.length, 2);

  const hang = (_url: string, init?: { signal?: AbortSignal }) =>
    new Promise<never>((_, reject) => init?.signal?.addEventListener("abort", () => reject(new Error("aborted"))));
  const t = await testClient(hang, { timeoutMs: 20, attempts: 1 }).account.get().catch((e: unknown) => e);
  assert.ok(t instanceof TwilioError);
  assert.equal(t.kind, "timeout");
  assert.match(t.message, /timed out after 20ms/);
});

test("the caller's AbortSignal stops a call, and it isn't retried", async () => {
  const ac = new AbortController();
  ac.abort();
  const { fetch, calls } = fakeFetch([ok()]);
  const err = await testClient(fetch).messages.list({ signal: ac.signal }).catch((e: unknown) => e);
  assert.ok(err instanceof TwilioError);
  assert.equal(err.kind, "aborted");
  assert.equal(calls.length, 0);
});

test("baseUrl and the account in every path; a page address on another host isn't followed", async () => {
  const { fetch, calls } = fakeFetch([ok({ calls: [] })]);
  await createTwilioClient({ accountSid: SID, authToken: "t", fetch, baseUrl: "https://example.test/" }).calls.list();
  assert.equal(calls[0]!.url, `https://example.test${ACCOUNT}/Calls.json`);

  const { fetch: f2, calls: c2 } = fakeFetch([ok({ messages: [], next_page_uri: "https://evil.test/steal" })]);
  const err = await testClient(f2).messages.listAll().catch((e: unknown) => e);
  assert.ok(err instanceof TwilioError);
  assert.match(err.message, /another host/);
  assert.equal(c2.length, 1);
});
