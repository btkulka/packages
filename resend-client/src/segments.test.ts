import assert from "node:assert/strict";
import { test } from "node:test";
import { fakeFetch, ok, page, testClient } from "./fake-fetch.test.js";

const S = "78261eea-8f8b-4381-83c6-79fa7120f1cf";
const C = "e169aa45-1ecf-4183-9955-b1499d5701d3";

test("create, list, get and delete a segment", async () => {
  const { fetch, calls } = fakeFetch([
    ok({ object: "segment", id: S, name: "NHI fans" }),
    page([{ id: S, name: "NHI fans", created_at: "2026-10-06 22:59:55.977+00" }]),
    ok({ object: "segment", id: S, name: "NHI fans", created_at: "2026-10-06 22:59:55.977+00" }),
    ok({ object: "segment", id: S, deleted: true }),
  ]);
  const resend = testClient(fetch);
  const made = await resend.segments.create({ name: "NHI fans" });
  assert.equal(made.id, S);
  const all = await resend.segments.list({ limit: 10 });
  assert.equal(all.data[0]!.name, "NHI fans");
  const one = await resend.segments.get(S);
  assert.equal(one.name, "NHI fans");
  const gone = await resend.segments.delete(S);
  assert.equal(gone.deleted, true);
  assert.deepEqual(
    calls.map((c) => `${c.method} ${c.path}`),
    ["POST /segments", "GET /segments?limit=10", `GET /segments/${S}`, `DELETE /segments/${S}`],
  );
  assert.deepEqual(calls[0]!.body, { name: "NHI fans" });
});

test("addContact and removeContact go through the contact's path, by id or email, with no body", async () => {
  const { fetch, calls } = fakeFetch([ok({ id: S }), ok({ object: "contact_segment", id: C, deleted: true })]);
  const resend = testClient(fetch);
  await resend.segments.addContact(S, "fan@x.com");
  const removed = await resend.segments.removeContact(S, C);
  assert.equal(removed.deleted, true);
  assert.equal(calls[0]!.method, "POST");
  assert.equal(calls[0]!.path, `/contacts/fan@x.com/segments/${S}`);
  assert.equal(calls[0]!.body, undefined);
  assert.equal(calls[1]!.method, "DELETE");
  assert.equal(calls[1]!.path, `/contacts/${C}/segments/${S}`);
});
