import assert from "node:assert/strict";
import { test } from "node:test";
import { ACCOUNT, fakeFetch, ok, testClient } from "./fake-fetch.test.js";
import { callDate } from "./index.js";

const call = (sid: string, over: Record<string, unknown> = {}) => ({
  sid,
  from: "+15125550111",
  to: "+18885550100",
  status: "completed",
  direction: "inbound",
  duration: "42",
  start_time: "Fri, 23 Oct 2026 15:00:00 +0000",
  date_created: "Fri, 23 Oct 2026 14:59:58 +0000",
  ...over,
});

test("calls.list: GET /Calls.json with PageSize; a page without calls is []", async () => {
  const { fetch, calls } = fakeFetch([ok({ calls: [call("CA1"), call("CA2")], next_page_uri: null }), ok(null)]);
  const twilio = testClient(fetch);
  const p = await twilio.calls.list({ pageSize: 50 });
  assert.deepEqual(p.calls.map((c) => c.sid), ["CA1", "CA2"]);
  assert.equal(p.calls[0]!.duration, "42");
  assert.equal(calls[0]!.method, "GET");
  assert.equal(calls[0]!.pathname, `${ACCOUNT}/Calls.json`);
  assert.deepEqual(calls[0]!.query, { PageSize: "50" });

  const empty = await twilio.calls.list();
  assert.deepEqual(empty.calls, []);
  assert.equal(empty.next_page_uri, null);
  assert.deepEqual(calls[1]!.query, {});
});

test("callDate: start_time, else date_created, as ISO; '' when neither reads", () => {
  assert.equal(callDate(call("CA1")), "2026-10-23T15:00:00.000Z");
  assert.equal(callDate(call("CA2", { start_time: null })), "2026-10-23T14:59:58.000Z");
  assert.equal(callDate({ start_time: null }), "");
});
