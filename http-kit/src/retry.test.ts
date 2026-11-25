import assert from "node:assert/strict";
import { test } from "node:test";
import { HttpError } from "./errors.js";
import { retry, retryDelay } from "./retry.js";

const at = (r: number) => () => r;

test("the backoff doubles from baseDelayMs up to maxDelayMs, with no chance taken", () => {
  const o = { baseDelayMs: 2_000, maxDelayMs: 60_000, random: at(0) };
  assert.deepEqual([0, 1, 2, 3, 4, 5, 6, 9].map((n) => retryDelay(undefined, n, o)), [2_000, 4_000, 8_000, 16_000, 32_000, 60_000, 60_000, 60_000]);
});

test("jitter takes a random part off each wait: half of it by default, all of it at most", () => {
  assert.equal(retryDelay(undefined, 1, { baseDelayMs: 1_000, random: at(0.999999) }), 1_000);
  assert.equal(retryDelay(undefined, 1, { baseDelayMs: 1_000, random: at(0.5) }), 1_500);
  assert.equal(retryDelay(undefined, 1, { baseDelayMs: 1_000, jitter: 0, random: at(0.9) }), 2_000);
  assert.equal(retryDelay(undefined, 1, { baseDelayMs: 1_000, jitter: 1, random: at(0.25) }), 1_500);
  // Out-of-range settings are held to 0..1.
  assert.equal(retryDelay(undefined, 0, { baseDelayMs: 1_000, jitter: 7, random: at(2) }), 0);
  for (let i = 0; i < 200; i++) {
    const d = retryDelay(undefined, 3);
    assert.ok(d >= 4_000 && d <= 8_000, `${d}`);
  }
});

test("a 429's Retry-After is waited out whole, never jittered", () => {
  const err = new HttpError("busy", { status: 429, retryAfterMs: 5_000 });
  assert.equal(retryDelay(err, 0, { random: at(0.9) }), 5_000);
  assert.equal(retryDelay(err, 0, { maxRetryAfterMs: 1_000 }), 1_000);
});

test("retry waits the jittered backoff between attempts", async () => {
  let calls = 0;
  const started = Date.now();
  const v = await retry(
    async () => {
      if (++calls < 3) throw new HttpError("down", { status: 503 });
      return "up";
    },
    { baseDelayMs: 20, random: at(0) },
  );
  assert.equal(v, "up");
  assert.equal(calls, 3);
  assert.ok(Date.now() - started >= 55);
});
