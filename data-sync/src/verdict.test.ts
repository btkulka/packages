import assert from "node:assert/strict";
import { test } from "node:test";
import { decideVerdict, type Agreement } from "./index.js";

const never: Agreement = { local: null, remote: null };
const agreed: Agreement = { local: "L0", remote: "R0" };
const v = (localSha: string | null, remoteSha: string | null, a: Agreement, localTotal = 5) => decideVerdict({ localSha, localTotal, remoteSha, agreed: a });

test("nothing anywhere, or only here", () => {
  assert.equal(v(null, null, never), "in-sync");
  assert.equal(v("L0", null, never), "no-remote");
  assert.equal(v("L1", null, agreed), "no-remote");
});

test("a machine with no data (or no rows) takes the snapshot", () => {
  assert.equal(v(null, "R0", never), "remote-ahead");
  assert.equal(v("E", "R0", never, 0), "remote-ahead");
});

test("each side against what it was when they last agreed", () => {
  assert.equal(v("L0", "R0", agreed), "in-sync");
  assert.equal(v("L1", "R0", agreed), "local-ahead");
  assert.equal(v("L0", "R1", agreed), "remote-ahead");
  assert.equal(v("L1", "R1", agreed), "diverged");
});

test("the same bytes on both sides is in sync whatever the history", () => {
  assert.equal(v("X", "X", never), "in-sync");
  assert.equal(v("X", "X", agreed), "in-sync");
});

test("two machines that never agreed and differ: Ben chooses", () => {
  assert.equal(v("L0", "R0", never), "diverged");
});
