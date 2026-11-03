import assert from "node:assert/strict";
import { test } from "node:test";
import { failure, fakeFetch, ok, testClient } from "./fake-fetch.test.js";
import { createThrottle, DEFAULT_REQUESTS_PER_SECOND, type FetchLike } from "./index.js";

// Real timers. A timer can fire a few ms early against performance.now() (and late on a busy machine), so
// lower bounds allow SLACK and upper bounds are loose.
const SLACK = 15;

/** When each of `n` back-to-back waits got its slot, relative to the first. */
async function starts(wait: () => Promise<void>, n: number): Promise<number[]> {
  const t0 = performance.now();
  const at = await Promise.all(Array.from({ length: n }, () => wait().then(() => performance.now() - t0)));
  return at.sort((a, b) => a - b);
}

test("the default is 2 requests a second: three starts span a second", async () => {
  assert.equal(DEFAULT_REQUESTS_PER_SECOND, 2);
  const t = createThrottle();
  assert.equal(t.requestsPerSecond, 2);
  const at = await starts(() => t.wait(), 3);
  assert.ok(at[0]! < SLACK, `the first start waits for nothing (${at[0]}ms)`);
  assert.ok(at[1]! >= 500 - SLACK, `the second waits half a second (${at[1]}ms)`);
  assert.ok(at[2]! >= 1000 - SLACK, `the third waits a second (${at[2]}ms)`);
  assert.ok(at[2]! < 1400, `and not much longer (${at[2]}ms)`);
});

test("starts are spaced at the configured rate", async () => {
  const t = createThrottle({ requestsPerSecond: 10 });
  const at = await starts(() => t.wait(), 5);
  for (let i = 1; i < at.length; i++) assert.ok(at[i]! >= i * 100 - SLACK, `start ${i} at ${at[i]}ms, not before ${i * 100}`);
  assert.ok(at[4]! < 400 + 250, `five starts at 10 a second take about 400ms, not ${at[4]}ms`);

  const fast = createThrottle({ requestsPerSecond: 40 });
  const quick = await starts(() => fast.wait(), 5);
  assert.ok(quick[4]! >= 100 - SLACK && quick[4]! < 100 + 200, `five starts at 40 a second take about 100ms, not ${quick[4]}ms`);
});

test("an idle throttle doesn't hold the next request back", async () => {
  const t = createThrottle({ requestsPerSecond: 10 });
  await t.wait();
  await new Promise((r) => setTimeout(r, 150));
  const t0 = performance.now();
  await t.wait();
  assert.ok(performance.now() - t0 < SLACK);
});

test("run waits its turn, then runs the function", async () => {
  const t = createThrottle({ requestsPerSecond: 20 });
  const t0 = performance.now();
  const out = await Promise.all([t.run(async () => "a"), t.run(async () => performance.now() - t0)]);
  assert.equal(out[0], "a");
  assert.ok((out[1] as number) >= 50 - SLACK);
});

test("an aborted wait rejects, and gives its slot back", async () => {
  const t = createThrottle({ requestsPerSecond: 5 });
  await t.wait();
  const ac = new AbortController();
  const queued = t.wait(ac.signal);
  ac.abort();
  await assert.rejects(queued, (e: unknown) => (e as { kind?: string }).kind === "aborted");
  const t0 = performance.now();
  await t.wait();
  const waited = performance.now() - t0;
  assert.ok(waited < 200 + 60, `the next request waits one gap, not two (${waited}ms)`);
  await assert.rejects(t.wait(AbortSignal.abort()), (e: unknown) => (e as { kind?: string }).kind === "aborted");
});

test("Infinity means no spacing; zero or below is refused", async () => {
  const t = createThrottle({ requestsPerSecond: Infinity });
  const at = await starts(() => t.wait(), 20);
  assert.ok(at[19]! < SLACK);
  assert.throws(() => createThrottle({ requestsPerSecond: 0 }), RangeError);
  assert.throws(() => createThrottle({ requestsPerSecond: -1 }), RangeError);
  assert.throws(() => createThrottle({ requestsPerSecond: Number.NaN }), RangeError);
});

test("a client's requests go out at its rate, retries included, and a shared throttle spaces two clients", async () => {
  const { fetch, calls } = fakeFetch([ok({ id: "x" })]);
  const resend = testClient(fetch, { requestsPerSecond: 10 });
  await Promise.all(["a", "b", "c", "d"].map((e) => resend.contacts.get(`${e}@x.com`)));
  const gaps = calls.slice(1).map((c, i) => c.at - calls[i]!.at);
  for (const g of gaps) assert.ok(g >= 100 - SLACK, `requests ${Math.round(g)}ms apart, not 100`);

  const { fetch: f2, calls: c2 } = fakeFetch([failure(429, "rate_limit_exceeded", "slow down", { "Retry-After": "0" }), ok({ id: "x" })]);
  await testClient(f2, { requestsPerSecond: 10 }).contacts.get("a@x.com");
  assert.equal(c2.length, 2);
  assert.ok(c2[1]!.at - c2[0]!.at >= 100 - SLACK, "the retry took a slot too");

  const shared = createThrottle({ requestsPerSecond: 10 });
  const { fetch: f3, calls: c3 } = fakeFetch([ok({ id: "x" })]);
  const one = testClient(f3, { throttle: shared });
  const two = testClient(f3, { throttle: shared });
  await Promise.all([one.segments.get("s1"), two.segments.get("s2"), one.segments.get("s3")]);
  const spread = c3[2]!.at - c3[0]!.at;
  assert.ok(spread >= 200 - SLACK, `three requests from two clients share 10 a second (${Math.round(spread)}ms)`);
});

test("waiting for a slot doesn't count against the request's timeout", async () => {
  const { fetch, calls } = fakeFetch([ok({ id: "x" })]);
  const slow: FetchLike = (url, init) => new Promise((r) => setTimeout(r, 30)).then(() => fetch(url, init));
  // Each attempt gets 80ms and takes 30; the third request queues ~200ms before its attempt starts.
  const resend = testClient(slow, { requestsPerSecond: 10, timeoutMs: 80, attempts: 1 });
  const got = await Promise.all([resend.domains.get("a"), resend.domains.get("b"), resend.domains.get("c")]);
  assert.equal(got.length, 3);
  assert.equal(calls.length, 3);
});
