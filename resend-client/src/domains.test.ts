import assert from "node:assert/strict";
import { test } from "node:test";
import { fakeFetch, ok, page, testClient } from "./fake-fetch.test.js";
import { isResendError } from "./index.js";

const ID = "d91cd9bd-1176-453e-8fc1-35364d380206";
const records = [
  { record: "SPF", name: "send", type: "MX", ttl: "Auto", status: "not_started", value: "feedback-smtp.us-east-1.amazonses.com", priority: 10 },
  { record: "SPF", name: "send", value: "v=spf1 include:amazonses.com ~all", type: "TXT", ttl: "Auto", status: "not_started" },
  { record: "DKIM", name: "resend._domainkey", value: "p=MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQDsc4Lh8xilsngyKEgN2S84+21gn+x6SEXtjWvPiAAmnmggr5FWG42WnqczpzQ/mNblqHz4CDwUum6LtY6SdoOlDmrhvp5khA3cd661W9FlK3yp7+jVACQElS7d9O6jv8VsBbVg4COess3gyLE5RyxqF1vYsrEXqyM8TBz1n5AGkQIDAQA2", type: "TXT", status: "not_started", ttl: "Auto" },
];
const domain = { object: "domain", id: ID, name: "nhi-dj.com", status: "not_started", created_at: "2026-11-02 21:00:00.000+00", region: "us-east-1", records };

test("create posts the domain and returns the records to add", async () => {
  const { fetch, calls } = fakeFetch([ok(domain)]);
  const d = await testClient(fetch).domains.create({ name: "nhi-dj.com", region: "us-east-1", custom_return_path: "outbound" });
  assert.equal(d.records?.length, 3);
  assert.equal(d.records?.[2]!.name, "resend._domainkey");
  assert.equal(calls[0]!.method, "POST");
  assert.equal(calls[0]!.path, "/domains");
  assert.deepEqual(calls[0]!.body, { name: "nhi-dj.com", region: "us-east-1", custom_return_path: "outbound" });
});

test("list pages by cursor with a clamped limit, and refuses after with before", async () => {
  const { fetch, calls } = fakeFetch([page([{ id: ID, name: "nhi-dj.com", status: "verified" }], true), page([])]);
  const resend = testClient(fetch);
  const first = await resend.domains.list({ limit: 500 });
  assert.equal(first.has_more, true);
  assert.equal(calls[0]!.path, "/domains?limit=100");
  await resend.domains.list({ after: ID, limit: 0 });
  assert.equal(calls[1]!.path, `/domains?limit=1&after=${ID}`);
  await assert.rejects(resend.domains.list({ after: "a", before: "b" }), (e: unknown) => isResendError(e, "validation"));
  assert.equal(calls.length, 2);
});

test("get reads the domain with its records and status", async () => {
  const { fetch, calls } = fakeFetch([ok({ ...domain, status: "verified" })]);
  const d = await testClient(fetch).domains.get(ID);
  assert.equal(d.status, "verified");
  assert.equal(calls[0]!.path, `/domains/${ID}`);
  assert.equal(calls[0]!.method, "GET");
});

test("verify posts with no body", async () => {
  const { fetch, calls } = fakeFetch([ok({ object: "domain", id: ID })]);
  const r = await testClient(fetch).domains.verify(ID);
  assert.equal(r.id, ID);
  assert.equal(calls[0]!.method, "POST");
  assert.equal(calls[0]!.path, `/domains/${ID}/verify`);
  assert.equal(calls[0]!.body, undefined);
});
