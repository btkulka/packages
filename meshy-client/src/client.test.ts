import assert from "node:assert/strict";
import { test } from "node:test";
import { failure, fakeFetch, fakeMeshy, GLB, ok, PNG, task, testClient } from "./fake-fetch.test.js";
import { createMeshyClient, isMeshyError, MeshyError } from "./index.js";

const poll = { intervalMs: 0, maxIntervalMs: 0 };

test("balance: GET /openapi/v1/balance with the key as a Bearer token", async () => {
  const f = fakeFetch([ok({ balance: 1000, monthly_credits: 600, permanent_credits: 400, monthly_resets_at: 1793491200000 })]);
  const b = await testClient(f.fetch).balance();
  assert.equal(b.balance, 1000);
  assert.equal(f.calls[0]!.url, "https://api.meshy.ai/openapi/v1/balance");
  assert.equal(f.calls[0]!.headers.Authorization, "Bearer msy_test");
});

test("no key: every call throws an auth MeshyError without a request", async () => {
  const f = fakeFetch([ok({ balance: 1 })]);
  const c = createMeshyClient({ apiKey: "  ", fetch: f.fetch });
  await assert.rejects(c.balance(), (e) => isMeshyError(e, "auth") && e.code === "missing_api_key");
  await assert.rejects(c.imageTo3d.get("t"), (e) => isMeshyError(e, "auth"));
  assert.equal(f.calls.length, 0);
});

test("errors carry Meshy's message and a category; the key, credits and refusals are never retried", async () => {
  for (const [status, category] of [[401, "auth"], [402, "credits"], [403, "forbidden"], [400, "validation"], [422, "validation"], [404, "not_found"], [409, "conflict"]] as const) {
    const f = fakeFetch([failure(status, `nope ${status}`)]);
    await assert.rejects(testClient(f.fetch).balance(), (e) => {
      assert.ok(e instanceof MeshyError);
      assert.equal(e.category, category);
      assert.equal(e.status, status);
      assert.match(e.message, new RegExp(`nope ${status}`));
      return true;
    });
    assert.equal(f.calls.length, 1, `${status} is not retried`);
  }
});

test("reads retry a 429 (after Retry-After) and a 5xx", async () => {
  const f = fakeFetch([failure(429, "Rate limit exceeded.", { "Retry-After": "0" }), failure(503, "busy"), ok({ balance: 5 })]);
  assert.equal((await testClient(f.fetch).balance()).balance, 5);
  assert.equal(f.calls.length, 3);
});

test("create sends the image as a data URI, mesh only by default, and answers the task id", async () => {
  const m = fakeMeshy();
  const id = await testClient(m.fetch).imageTo3d.create({ image: { data: PNG, mimeType: "image/png" } });
  assert.equal(id, "task-1");
  const body = m.posts()[0]!.body as Record<string, unknown>;
  assert.match(String(body.image_url), /^data:image\/png;base64,iVBORw0KGgo=$/);
  assert.equal(body.ai_model, "latest");
  assert.equal(body.should_texture, false);
  assert.equal(body.model_type, undefined);
});

test("create retries a 429 (nothing was made) but never a 5xx or a timeout (the task may exist)", async () => {
  const m = fakeMeshy({ createFails: [failure(429, "NoMorePendingTasks")] });
  assert.equal(await testClient(m.fetch).imageTo3d.create({ image: "https://example.com/a.png" }), "task-1");
  assert.equal(m.posts().length, 2);
  const f = fakeFetch([failure(500, "oops"), ok({ result: "t" })]);
  await assert.rejects(testClient(f.fetch).imageTo3d.create({ image: "https://example.com/a.png" }), (e) => isMeshyError(e, "other") && e.status === 500);
  assert.equal(f.calls.length, 1);
  const g = fakeFetch([new Error("socket hang up"), ok({ result: "t" })]);
  await assert.rejects(testClient(g.fetch).imageTo3d.create({ image: "https://example.com/a.png" }), (e) => isMeshyError(e) && e.code === "network");
  assert.equal(g.calls.length, 1);
});

test("wait polls PENDING → IN_PROGRESS → SUCCEEDED, telling onPoll each time", async () => {
  const m = fakeMeshy();
  const c = testClient(m.fetch);
  const id = await c.imageTo3d.create({ image: "https://example.com/a.png" });
  const seen: string[] = [];
  const done = await c.imageTo3d.wait(id, { ...poll, onPoll: (t) => seen.push(`${t.status} ${t.progress}`) });
  assert.equal(done.status, "SUCCEEDED");
  assert.deepEqual(seen, ["PENDING 0", "IN_PROGRESS 40", "SUCCEEDED 100"]);
  assert.equal(done.consumed_credits, 20);
});

test("wait: a FAILED task throws task_failed with Meshy's task_error; whether to make it again follows its type", async () => {
  const m = fakeMeshy({ states: (id) => [task(id, "IN_PROGRESS"), task(id, "FAILED")] });
  const c = testClient(m.fetch);
  await assert.rejects(c.imageTo3d.wait(await c.imageTo3d.create({ image: "https://example.com/a.png" }), poll), (e) => {
    assert.ok(isMeshyError(e, "task_failed"));
    assert.equal(e.code, "task_failed");
    assert.equal(e.taskError?.type, "server_error");
    assert.equal(e.taskId, "task-1");
    assert.equal(e.worthRetrying, true);
    return true;
  });
  const bad = fakeMeshy({ states: (id) => [task(id, "FAILED", { task_error: { type: "invalid_input", code: "image_too_complex", message: "too complex", doc_url: "https://docs.meshy.ai/en/api/errors#image-too-complex" } })] });
  const c2 = testClient(bad.fetch);
  await assert.rejects(c2.imageTo3d.wait(await c2.imageTo3d.create({ image: "https://example.com/a.png" }), poll), (e) => isMeshyError(e, "task_failed") && !e.worthRetrying && /image_too_complex/.test(e.message));
  const gone = fakeMeshy({ states: (id) => [task(id, "CANCELED")] });
  const c3 = testClient(gone.fetch);
  await assert.rejects(c3.imageTo3d.wait(await c3.imageTo3d.create({ image: "https://example.com/a.png" }), poll), (e) => isMeshyError(e, "task_failed") && e.code === "task_canceled");
});

test("wait gives up at its timeout (the task carries on) and stops at once on an abort", async () => {
  const m = fakeMeshy({ states: (id) => [task(id, "IN_PROGRESS")] });
  const c = testClient(m.fetch);
  const id = await c.imageTo3d.create({ image: "https://example.com/a.png" });
  await assert.rejects(c.imageTo3d.wait(id, { intervalMs: 5, maxIntervalMs: 5, timeoutMs: 20 }), (e) => isMeshyError(e, "other") && e.code === "wait_timeout" && e.taskId === id);
  const ac = new AbortController();
  const p = c.imageTo3d.wait(id, { intervalMs: 10_000, maxIntervalMs: 10_000, signal: ac.signal });
  setTimeout(() => ac.abort(), 10);
  await assert.rejects(p, (e) => isMeshyError(e) && e.code === "aborted");
});

test("wait honours Meshy's Retry-After up to its cap", async () => {
  let n = 0;
  const f = fakeFetch(() => (n++ === 0 ? ok(task("t", "IN_PROGRESS"), { "Retry-After": "0.05" }) : ok(task("t", "SUCCEEDED"))));
  const t0 = Date.now();
  await testClient(f.fetch).imageTo3d.wait("t", { intervalMs: 0, maxIntervalMs: 1_000 });
  assert.ok(Date.now() - t0 >= 45, "waited for Retry-After");
  n = 0;
  const t1 = Date.now();
  await testClient(f.fetch).imageTo3d.wait("t", { intervalMs: 0, maxIntervalMs: 0 });
  assert.ok(Date.now() - t1 < 45, "capped by maxIntervalMs");
});

test("download fetches a signed URL without the key, https only", async () => {
  const f = fakeFetch([{ status: 200, body: GLB }]);
  const c = testClient(f.fetch);
  const bytes = await c.download("https://assets.meshy.ai/u/tasks/t/output/model.glb?Expires=1&Signature=s");
  assert.deepEqual([...bytes], [...GLB]);
  assert.equal(f.calls[0]!.headers.Authorization, undefined);
  await assert.rejects(c.download("http://assets.meshy.ai/x.glb"), (e) => isMeshyError(e, "validation") && e.code === "insecure_url");
  const g = fakeFetch([failure(403, "Request has expired")]);
  await assert.rejects(testClient(g.fetch).download("https://assets.meshy.ai/x.glb?Signature=secret"), (e) => isMeshyError(e) && !e.url.includes("secret"));
});

test("generate: create, wait, download the GLB", async () => {
  const m = fakeMeshy();
  const r = await testClient(m.fetch).imageTo3d.generate({ image: "https://example.com/a.png", targetFormats: ["glb"] }, poll);
  assert.equal(r.task.status, "SUCCEEDED");
  assert.deepEqual([...r.glb], [...GLB]);
  await assert.rejects(testClient(m.fetch).imageTo3d.generate({ image: "https://example.com/a.png", targetFormats: ["obj"] }), (e) => isMeshyError(e, "validation"));
});

test("list and delete", async () => {
  const f = fakeFetch([ok([task("a", "SUCCEEDED")]), ok(undefined)]);
  const c = testClient(f.fetch);
  const list = await c.imageTo3d.list({ pageSize: 5 });
  assert.equal(list[0]!.id, "a");
  assert.equal(f.calls[0]!.path, "/openapi/v1/image-to-3d?page_size=5&sort_by=-created_at");
  await c.imageTo3d.delete("a");
  assert.equal(f.calls[1]!.method, "DELETE");
  assert.equal(f.calls[1]!.path, "/openapi/v1/image-to-3d/a");
});
