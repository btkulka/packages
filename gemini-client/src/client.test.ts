import assert from "node:assert/strict";
import { test } from "node:test";
import { completed, failure, fakeFetch, ok, testClient } from "./fake-fetch.test.js";
import { categoryOf, createGeminiClient, GeminiAuthError, GeminiError, isGeminiError } from "./index.js";

test("every call sends the key in x-goog-api-key, never in the URL", async () => {
  const { fetch, calls } = fakeFetch([ok({ models: [] })]);
  await testClient(fetch).models.list();
  assert.equal(calls[0]!.headers["x-goog-api-key"], "AIza-test");
  assert.equal(calls[0]!.headers["Accept"], "application/json");
  assert.doesNotMatch(calls[0]!.url, /key=/);
  assert.match(calls[0]!.url, /^https:\/\/generativelanguage\.googleapis\.com\/v1beta\/models/);
});

test("without a key every call throws GeminiAuthError before any request", async () => {
  const { fetch, calls } = fakeFetch([ok()]);
  const g = createGeminiClient({ apiKey: "  ", fetch });
  await assert.rejects(g.models.list(), (e: unknown) => e instanceof GeminiAuthError && e.code === "missing_api_key" && e.category === "auth");
  await assert.rejects(g.video.start({ prompt: "a bar" }), GeminiAuthError);
  assert.equal(calls.length, 0);
});

test("an invalid key is a GeminiAuthError with Google's status and reason, not retried", async () => {
  const { fetch, calls } = fakeFetch([failure(400, "INVALID_ARGUMENT", "API key not valid. Please pass a valid API key.", "API_KEY_INVALID")]);
  await assert.rejects(testClient(fetch).models.list(), (e: unknown) => {
    assert.ok(e instanceof GeminiAuthError);
    assert.equal(e.status, 400);
    assert.equal(e.code, "INVALID_ARGUMENT");
    assert.equal(e.reason, "API_KEY_INVALID");
    assert.equal(e.category, "auth");
    assert.match(e.message, /API key not valid/);
    return true;
  });
  assert.equal(calls.length, 1);
});

test("a disabled API, a free-tier quota of 0 and an unsupported country are `setup`, never retried", async () => {
  const cases = [
    failure(403, "PERMISSION_DENIED", "Generative Language API has not been used in project 123 before or it is disabled.", "SERVICE_DISABLED"),
    failure(429, "RESOURCE_EXHAUSTED", "You exceeded your current quota, please check your plan and billing details. Quota exceeded for metric: generate_content_free_tier_requests, limit: 0, model: gemini-omni-1.1-flash"),
    failure(400, "FAILED_PRECONDITION", "User location is not supported for the API use."),
  ];
  for (const reply of cases) {
    const { fetch, calls } = fakeFetch([reply]);
    await assert.rejects(testClient(fetch).models.list(), (e: unknown) => isGeminiError(e, "setup"));
    assert.equal(calls.length, 1);
  }
});

test("an ordinary 429 is rate_limit and waits out Retry-After, then succeeds", async () => {
  const { fetch, calls } = fakeFetch([
    failure(429, "RESOURCE_EXHAUSTED", "You exceeded your current quota, please check your plan and billing details.", undefined, { "Retry-After": "0" }),
    ok({ models: [{ name: "models/gemini-omni-1.1-flash" }] }),
  ]);
  const r = await testClient(fetch).models.list();
  assert.equal(r.models.length, 1);
  assert.equal(calls.length, 2);
});

test("a daily quota 429 isn't retried", async () => {
  const quota = { "@type": "type.googleapis.com/google.rpc.QuotaFailure", violations: [{ quotaId: "GenerateRequestsPerDayPerProjectPerModel" }] };
  const { fetch, calls } = fakeFetch([failure(429, "RESOURCE_EXHAUSTED", "Quota exceeded.", undefined, undefined, [quota])]);
  await assert.rejects(testClient(fetch).models.list(), (e: unknown) => isGeminiError(e, "rate_limit") && (e as GeminiError).quotaIds[0] === "GenerateRequestsPerDayPerProjectPerModel");
  assert.equal(calls.length, 1);
});

test("a 5xx and a dropped connection back off and retry; a 404 is not_found", async () => {
  const { fetch, calls } = fakeFetch([failure(503, "UNAVAILABLE", "busy"), new TypeError("socket hang up"), ok({ models: [] })]);
  await testClient(fetch).models.list();
  assert.equal(calls.length, 3);

  const nf = fakeFetch([failure(404, "NOT_FOUND", "models/nope is not found")]);
  await assert.rejects(testClient(nf.fetch).models.get("nope"), (e: unknown) => isGeminiError(e, "not_found"));
});

test("network failures that outlast the attempts come back as GeminiError, kind network", async () => {
  const { fetch, calls } = fakeFetch([new TypeError("ECONNRESET")]);
  await assert.rejects(testClient(fetch, { attempts: 2 }).models.list(), (e: unknown) => isGeminiError(e, "other") && (e as GeminiError).kind === "network");
  assert.equal(calls.length, 2);
});

test("an abort is never retried", async () => {
  const { fetch, calls } = fakeFetch([ok()]);
  const ac = new AbortController();
  ac.abort();
  await assert.rejects(testClient(fetch).models.list({ signal: ac.signal }), (e: unknown) => isGeminiError(e) && (e as GeminiError).kind === "aborted");
  assert.equal(calls.length, 0);
});

test("categoryOf: safety refusals on a 400 are blocked; other 400s are validation", () => {
  assert.equal(categoryOf(400, "INVALID_ARGUMENT", null, "The prompt was blocked by our safety filters."), "blocked");
  assert.equal(categoryOf(400, "INVALID_ARGUMENT", null, "aspect_ratio must be one of 16:9, 9:16"), "validation");
  assert.equal(categoryOf(401, "UNAUTHENTICATED", null, ""), "auth");
  assert.equal(categoryOf(500, "INTERNAL", null, ""), "other");
});

test("interactionHeaders go on interactions calls only", async () => {
  const { fetch, calls } = fakeFetch([ok({ models: [] }), ok(completed("i1"))]);
  const g = testClient(fetch, { interactionHeaders: { "Api-Revision": "2026-05-20" } });
  await g.models.list();
  await g.video.get("i1");
  assert.equal(calls[0]!.headers["Api-Revision"], undefined);
  assert.equal(calls[1]!.headers["Api-Revision"], "2026-05-20");
});
