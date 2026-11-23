import assert from "node:assert/strict";
import { test } from "node:test";
import { ACCOUNT, failure, fakeFetch, msg, ok, testClient } from "./fake-fetch.test.js";
import { messageDate, TwilioError } from "./index.js";

test("send: POST /Messages.json with To, Body and From", async () => {
  const { fetch, calls } = fakeFetch([ok(msg("SM1", { status: "queued", direction: "outbound-api" }), 201)]);
  const m = await testClient(fetch).messages.send({ to: "+15125550111", body: "Hi & welcome", from: "+18885550100" });
  assert.equal(m.sid, "SM1");
  assert.equal(m.status, "queued");
  assert.equal(calls[0]!.method, "POST");
  assert.equal(calls[0]!.path, `${ACCOUNT}/Messages.json`);
  assert.deepEqual(calls[0]!.form, { To: "+15125550111", Body: "Hi & welcome", From: "+18885550100" });
});

test("send without a sender: the client's Messaging Service, else its number; a sender in the call wins", async () => {
  const { fetch, calls } = fakeFetch([ok(msg("SM1"), 201)]);
  await testClient(fetch, { from: "+18885550100", messagingServiceSid: "MG1" }).messages.send({ to: "+1", body: "a" });
  await testClient(fetch, { from: " +18885550100 " }).messages.send({ to: "+1", body: "b" });
  await testClient(fetch, { from: "+18885550100", messagingServiceSid: "MG1" }).messages.send({ to: "+1", body: "c", from: "+19995550100" });
  await testClient(fetch, { from: "+18885550100" }).messages.send({ to: "+1", body: "d", messagingServiceSid: "MG2", from: "+19995550100" });
  await testClient(fetch).messages.send({ to: "+1", body: "e" });
  assert.deepEqual(calls[0]!.form, { To: "+1", Body: "a", MessagingServiceSid: "MG1" });
  assert.deepEqual(calls[1]!.form, { To: "+1", Body: "b", From: "+18885550100" });
  assert.deepEqual(calls[2]!.form, { To: "+1", Body: "c", From: "+19995550100" });
  assert.deepEqual(calls[3]!.form, { To: "+1", Body: "d", MessagingServiceSid: "MG2", From: "+19995550100" });
  assert.deepEqual(calls[4]!.form, { To: "+1", Body: "e" });
});

test("send retries only a 429: a 5xx or a timeout may have sent the text", async () => {
  const { fetch, calls } = fakeFetch([failure(500, 20500, "Internal")]);
  const err = await testClient(fetch).messages.send({ to: "+1", body: "x", from: "+2" }).catch((e: unknown) => e);
  assert.ok(err instanceof TwilioError);
  assert.equal(err.status, 500);
  assert.equal(calls.length, 1);

  const { fetch: f2, calls: c2 } = fakeFetch([new TypeError("socket hang up")]);
  const e2 = await testClient(f2).messages.send({ to: "+1", body: "x", from: "+2" }).catch((e: unknown) => e);
  assert.ok(e2 instanceof TwilioError);
  assert.equal(e2.kind, "network");
  assert.equal(c2.length, 1);

  const { fetch: f3, calls: c3 } = fakeFetch([failure(429, 20429, "Too Many Requests"), ok(msg("SM9"), 201)]);
  const m = await testClient(f3).messages.send({ to: "+1", body: "x", from: "+2" });
  assert.equal(m.sid, "SM9");
  assert.equal(c3.length, 2);
});

test("a STOPped number: code 21610, a 400 that isn't retried", async () => {
  const { fetch, calls } = fakeFetch([failure(400, 21610, "Attempt to send to unsubscribed recipient")]);
  const err = await testClient(fetch).messages.send({ to: "+1", body: "x", from: "+2" }).catch((e: unknown) => e);
  assert.ok(err instanceof TwilioError);
  assert.equal(err.code, 21610);
  assert.equal(err.status, 400);
  assert.equal(calls.length, 1);
});

test("list: To, From, DateSent> (a Date's UTC day) and PageSize (1 to 1000); a page without messages is []", async () => {
  const { fetch, calls } = fakeFetch([ok({ messages: [msg("SM1")], next_page_uri: null, page: 0, page_size: 50 }), ok({})]);
  const twilio = testClient(fetch);
  const p = await twilio.messages.list({ to: "+18885550100", from: "+15125550111", dateSentAfter: new Date("2026-10-23T23:30:00-05:00"), pageSize: 100 });
  assert.equal(p.messages.length, 1);
  assert.equal(p.page_size, 50);
  assert.equal(calls[0]!.pathname, `${ACCOUNT}/Messages.json`);
  assert.deepEqual(calls[0]!.query, { To: "+18885550100", From: "+15125550111", "DateSent>": "2026-10-24", PageSize: "100" });
  assert.match(calls[0]!.path, /DateSent%3E=2026-10-24/);

  const empty = await twilio.messages.list({ pageSize: 5000, dateSentAfter: "2026-10-01" });
  assert.deepEqual(empty.messages, []);
  assert.equal(empty.next_page_uri, null);
  assert.deepEqual(calls[1]!.query, { "DateSent>": "2026-10-01", PageSize: "1000" });

  await twilio.messages.list({ pageSize: 0 });
  assert.deepEqual(calls[2]!.query, { PageSize: "1" });
  await twilio.messages.list();
  assert.equal(calls[3]!.path, `${ACCOUNT}/Messages.json`);
});

test("listAll follows next_page_uri up to maxPages", async () => {
  const next = (n: number) => `${ACCOUNT}/Messages.json?PageSize=1&Page=${n}&PageToken=PA${n}`;
  const { fetch, calls } = fakeFetch([
    ok({ messages: [msg("SM1")], next_page_uri: next(1) }),
    ok({ messages: [msg("SM2")], next_page_uri: next(2) }),
    ok({ messages: [msg("SM3")], next_page_uri: next(3) }),
  ]);
  const all = await testClient(fetch).messages.listAll({ pageSize: 1, maxPages: 3 });
  assert.deepEqual(all.map((m) => m.sid), ["SM1", "SM2", "SM3"]);
  assert.equal(calls.length, 3);
  assert.equal(calls[1]!.path, next(1));
  assert.equal(calls[2]!.path, next(2));

  const { fetch: f2, calls: c2 } = fakeFetch([ok({ messages: [msg("SM1")], next_page_uri: null })]);
  await testClient(f2).messages.listAll();
  assert.equal(c2.length, 1);
});

test("inbound: texts that came in to the number since the instant, oldest first, five pages of 100 at most", async () => {
  const since = new Date("2026-10-23T15:00:00Z");
  const pages = Array.from({ length: 7 }, (_, n) =>
    ok({
      messages:
        n === 0
          ? [
              msg("late", { date_sent: "Fri, 23 Oct 2026 16:00:00 +0000" }),
              msg("out", { direction: "outbound-api", date_sent: "Fri, 23 Oct 2026 15:30:00 +0000" }),
              msg("early", { date_sent: "Fri, 23 Oct 2026 14:59:59 +0000" }),
              msg("exact", { date_sent: "Fri, 23 Oct 2026 15:00:00 +0000" }),
              msg("unsent", { date_sent: null, date_created: "Fri, 23 Oct 2026 15:10:00 +0000" }),
            ]
          : [msg(`p${n}`, { date_sent: `Fri, 23 Oct 2026 17:0${n}:00 +0000` })],
      next_page_uri: `${ACCOUNT}/Messages.json?Page=${n + 1}`,
    }),
  );
  const { fetch, calls } = fakeFetch(pages);
  const got = await testClient(fetch).messages.inbound("+18885550100", since);
  assert.deepEqual(got.map((m) => m.sid), ["exact", "unsent", "late", "p1", "p2", "p3", "p4"]);
  assert.equal(calls.length, 5);
  assert.deepEqual(calls[0]!.query, { To: "+18885550100", "DateSent>": "2026-10-23", PageSize: "100" });
});

test("thread: every text from and to the number, each once, oldest first; a blank number asks nothing", async () => {
  const { fetch, calls } = fakeFetch([
    ok({ messages: [msg("in2", { date_sent: "Fri, 23 Oct 2026 15:02:00 +0000" }), msg("both", { date_sent: "Fri, 23 Oct 2026 15:01:00 +0000" })], next_page_uri: null }),
    ok({ messages: [msg("out1", { direction: "outbound-api", date_sent: "Fri, 23 Oct 2026 15:00:00 +0000" }), msg("both", { date_sent: "Fri, 23 Oct 2026 15:01:00 +0000" })], next_page_uri: null }),
  ]);
  const twilio = testClient(fetch);
  const t = await twilio.messages.thread(" +15125550111 ");
  assert.deepEqual(t.map((m) => m.sid), ["out1", "both", "in2"]);
  assert.deepEqual(calls[0]!.query, { From: "+15125550111", PageSize: "100" });
  assert.deepEqual(calls[1]!.query, { To: "+15125550111", PageSize: "100" });

  assert.deepEqual(await twilio.messages.thread("   "), []);
  assert.equal(calls.length, 2);
});

test("messageDate: date_sent, else date_created, as ISO; '' when neither reads", () => {
  assert.equal(messageDate({ date_sent: "Fri, 23 Oct 2026 15:00:00 +0000" }), "2026-10-23T15:00:00.000Z");
  assert.equal(messageDate({ date_sent: null, date_created: "Fri, 23 Oct 2026 15:10:00 +0000" }), "2026-10-23T15:10:00.000Z");
  assert.equal(messageDate({ date_sent: null }), "");
  assert.equal(messageDate({ date_sent: "not a date" }), "");
});
