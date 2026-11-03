import assert from "node:assert/strict";
import { test } from "node:test";
import { failure, fakeFetch, ok, page, testClient } from "./fake-fetch.test.js";
import { isResendError } from "./index.js";

const C = "e169aa45-1ecf-4183-9955-b1499d5701d3";
const FANS = "78261eea-8f8b-4381-83c6-79fa7120f1cf";
const VIP = "5f0c8b51-7f4e-4c5e-9a8f-2b8e1d6f3c11";
const contact = (extra: Record<string, unknown> = {}) => ({
  object: "contact",
  id: C,
  email: "fan@x.com",
  first_name: "Sam",
  last_name: null,
  created_at: "2026-10-06 23:47:56.678+00",
  unsubscribed: false,
  ...extra,
});

test("create posts the contact, segments as { id } whether given as ids or objects", async () => {
  const { fetch, calls } = fakeFetch([ok({ object: "contact", id: C })]);
  const r = await testClient(fetch).contacts.create({ email: "fan@x.com", first_name: "Sam", unsubscribed: false, properties: { city: "Austin" }, segments: [FANS, { id: VIP }] });
  assert.equal(r.id, C);
  assert.equal(calls[0]!.method, "POST");
  assert.equal(calls[0]!.path, "/contacts");
  assert.deepEqual(calls[0]!.body, { email: "fan@x.com", first_name: "Sam", unsubscribed: false, properties: { city: "Austin" }, segments: [{ id: FANS }, { id: VIP }] });
});

test("get, update and delete take an id or an email, @ and + kept and the rest escaped", async () => {
  const { fetch, calls } = fakeFetch([ok(contact()), ok({ object: "contact", id: C }), ok({ object: "contact", contact: C, deleted: true })]);
  const resend = testClient(fetch);
  const got = await resend.contacts.get("ben+nhi@x.com");
  assert.equal(got.first_name, "Sam");
  assert.equal(calls[0]!.path, "/contacts/ben+nhi@x.com");

  await resend.contacts.update(C, { first_name: null, unsubscribed: true, properties: { city: null } });
  assert.equal(calls[1]!.method, "PATCH");
  assert.equal(calls[1]!.path, `/contacts/${C}`);
  assert.deepEqual(calls[1]!.body, { first_name: null, unsubscribed: true, properties: { city: null } });

  const gone = await resend.contacts.delete("odd/one?#@x.com");
  assert.equal(gone.deleted, true);
  assert.equal(calls[2]!.method, "DELETE");
  assert.equal(calls[2]!.path, "/contacts/odd%2Fone%3F%23@x.com");
});

test("list pages every contact, or one segment's through /segments/{id}/contacts", async () => {
  const { fetch, calls } = fakeFetch([page([contact()], true)]);
  const resend = testClient(fetch);
  const all = await resend.contacts.list({ limit: 50, after: "c0" });
  assert.equal(all.data[0]!.email, "fan@x.com");
  assert.equal(calls[0]!.path, "/contacts?limit=50&after=c0");
  await resend.contacts.list({ segment_id: FANS });
  assert.equal(calls[1]!.path, `/segments/${FANS}/contacts`);
});

test("listAll follows after cursors, 100 a page, up to the limit", async () => {
  const batch = (from: number, n: number) => Array.from({ length: n }, (_, i) => contact({ id: `c${from + i}`, email: `f${from + i}@x.com` }));
  const { fetch, calls } = fakeFetch([page(batch(0, 2), true), page(batch(2, 2), true), page(batch(4, 2))]);
  const all = await testClient(fetch).contacts.listAll({ segment_id: FANS });
  assert.deepEqual(all.map((c) => c.id), ["c0", "c1", "c2", "c3", "c4", "c5"]);
  assert.equal(calls[0]!.path, `/segments/${FANS}/contacts?limit=100`);
  assert.equal(calls[1]!.path, `/segments/${FANS}/contacts?limit=100&after=c1`);
  assert.equal(calls[2]!.path, `/segments/${FANS}/contacts?limit=100&after=c3`);

  const { fetch: f2, calls: c2 } = fakeFetch([page(batch(0, 2), true), page(batch(2, 2), true)]);
  assert.equal((await testClient(f2).contacts.listAll({}, 3)).length, 3);
  assert.equal(c2.length, 2);
});

test("upsert creates a contact that doesn't exist, in its segments", async () => {
  const { fetch, calls } = fakeFetch([failure(404, "not_found", "Contact not found"), ok({ object: "contact", id: C })]);
  const r = await testClient(fetch).contacts.upsert({ email: " fan@x.com ", first_name: "Sam", segments: [FANS] });
  assert.deepEqual(r, { id: C, created: true, updated: false, addedTo: [FANS] });
  assert.equal(calls[0]!.path, "/contacts/fan@x.com");
  assert.equal(calls[1]!.method, "POST");
  assert.deepEqual(calls[1]!.body, { email: "fan@x.com", first_name: "Sam", segments: [{ id: FANS }] });
});

test("upsert leaves an unchanged contact alone and adds it only to the segments it's missing", async () => {
  const { fetch, calls } = fakeFetch([ok(contact()), page([{ id: FANS, name: "Fans" }]), ok({ id: VIP })]);
  const r = await testClient(fetch).contacts.upsert({ email: "fan@x.com", first_name: "Sam", segments: [FANS, VIP] });
  assert.deepEqual(r, { id: C, created: false, updated: false, addedTo: [VIP] });
  assert.deepEqual(
    calls.map((c) => `${c.method} ${c.path}`),
    [`GET /contacts/fan@x.com`, `GET /contacts/${C}/segments`, `POST /contacts/${C}/segments/${VIP}`],
  );
});

test("upsert patches only what changed, and never an existing contact's unsubscribed", async () => {
  const existing = contact({ unsubscribed: true, properties: { city: { value: "Austin", type: "string" }, shows: { value: 3, type: "number" } } });
  const { fetch, calls } = fakeFetch([ok(existing), ok({ object: "contact", id: C })]);
  const r = await testClient(fetch).contacts.upsert({ email: "fan@x.com", first_name: "Sammy", unsubscribed: false, properties: { city: "Austin", shows: "3", tier: "vip" } });
  assert.deepEqual(r, { id: C, created: false, updated: true, addedTo: [] });
  assert.equal(calls.length, 2);
  assert.equal(calls[1]!.method, "PATCH");
  assert.equal(calls[1]!.path, `/contacts/${C}`);
  assert.deepEqual(calls[1]!.body, { first_name: "Sammy", properties: { tier: "vip" } });
});

test("upsert rethrows anything but a 404, and needs an email", async () => {
  const { fetch, calls } = fakeFetch([failure(401, "missing_api_key", "Missing API key")]);
  const resend = testClient(fetch);
  await assert.rejects(resend.contacts.upsert({ email: "fan@x.com" }), (e: unknown) => isResendError(e, "auth"));
  assert.equal(calls.length, 1);
  await assert.rejects(resend.contacts.upsert({ email: " " }), (e: unknown) => isResendError(e, "validation"));
  assert.equal(calls.length, 1);
});
