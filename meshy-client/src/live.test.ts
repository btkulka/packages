// A live check against Meshy, off unless MESHY_LIVE=1. It reads the balance only, which Meshy says is free, so it
// spends nothing. The key comes from Benhäus (credential `meshy`) or MESHY_API_KEY, and is never printed. Meshy's
// shared test-mode key was retired on 2026-09-16 (it answers 401), so there is no free key to make models with.
//
//   MESHY_LIVE=1 npm test

import assert from "node:assert/strict";
import { test } from "node:test";
import { createMeshyClient } from "./index.js";
import { loadMeshyKey } from "./key.js";

const live = process.env.MESHY_LIVE === "1";

test("live: the key reads the balance (free)", { skip: live ? false : "set MESHY_LIVE=1 to call Meshy (a free balance read)" }, async () => {
  const apiKey = await loadMeshyKey({ app: "meshy-client tests" });
  assert.ok(apiKey, "no key: add the Benhäus credential meshy, or set MESHY_API_KEY");
  const b = await createMeshyClient({ apiKey }).balance();
  assert.equal(typeof b.balance, "number");
});
