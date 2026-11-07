import assert from "node:assert/strict";
import { test } from "node:test";
import { fakeFetch, ok, testClient } from "./fake-fetch.test.js";
import { modelId } from "./index.js";

test("models.list is one page of GET /models with pageSize and pageToken", async () => {
  const { fetch, calls } = fakeFetch([ok({ models: [{ name: "models/gemini-omni-1.1-flash", supportedGenerationMethods: ["generateContent"] }], nextPageToken: "p2" })]);
  const r = await testClient(fetch).models.list({ pageSize: 5000, pageToken: "p1" });
  assert.equal(calls[0]!.method, "GET");
  assert.equal(calls[0]!.path, "/models?pageSize=1000&pageToken=p1");
  assert.equal(r.models[0]!.name, "models/gemini-omni-1.1-flash");
  assert.equal(r.nextPageToken, "p2");
});

test("models.list copes with an empty answer", async () => {
  const { fetch } = fakeFetch([ok({})]);
  const r = await testClient(fetch).models.list();
  assert.deepEqual(r, { models: [], nextPageToken: undefined });
});

test("models.listAll follows nextPageToken", async () => {
  const { fetch, calls } = fakeFetch([ok({ models: [{ name: "models/a" }], nextPageToken: "t" }), ok({ models: [{ name: "models/b" }] })]);
  const all = await testClient(fetch).models.listAll();
  assert.deepEqual(all.map((m) => m.name), ["models/a", "models/b"]);
  assert.equal(calls[1]!.path, "/models?pageSize=1000&pageToken=t");
});

test("models.get takes an id with or without models/", async () => {
  const { fetch, calls } = fakeFetch([ok({ name: "models/gemini-omni-1.1-flash" })]);
  await testClient(fetch).models.get("models/gemini-omni-1.1-flash");
  assert.equal(calls[0]!.path, "/models/gemini-omni-1.1-flash");
  assert.equal(modelId("models/x"), "x");
});
