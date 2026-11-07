import assert from "node:assert/strict";
import { test } from "node:test";
import { completed, failure, fakeFetch, inProgress, ok, testClient } from "./fake-fetch.test.js";
import { fileIdOf, GeminiError, interactionBody, isGeminiError, textOf, videosOf, type Interaction } from "./index.js";

const MP4 = new Uint8Array([0, 0, 0, 24, 102, 116, 121, 112, 109, 112, 52, 50]);

test("the body: Omni Flash, a video response format, background and stored", () => {
  const b = interactionBody({ prompt: "A crowded neon bar, phone footage", aspectRatio: "9:16", resolution: "720p", seconds: 8 });
  assert.deepEqual(b, {
    model: "gemini-omni-1.1-flash",
    input: "A crowded neon bar, phone footage",
    response_format: { type: "video", aspect_ratio: "9:16", resolution: "720p", duration: "8s" },
    background: true,
    store: true,
  });
});

test("the body: a negative prompt goes into the prompt; seed and task into generation_config", () => {
  const b = interactionBody({ prompt: "Club dance floor", negativePrompt: "text, logos.", seed: 42, task: "text_to_video", previousInteractionId: " i0 " });
  assert.equal(b.input, "Club dance floor\n\nAvoid: text, logos.");
  assert.deepEqual(b.generation_config, { seed: 42, video_config: { task: "text_to_video" } });
  assert.equal(b.previous_interaction_id, "i0");
  assert.deepEqual(b.response_format, { type: "video" });
});

test("the body: images go first as base64 items, then the prompt", () => {
  const b = interactionBody({ prompt: "<FIRST_FRAME> the crowd jumps", images: [{ data: new Uint8Array([1, 2, 3]), mimeType: "image/png" }, { data: "data:image/jpeg;base64,/9j/", mimeType: "image/jpeg" }] });
  assert.deepEqual(b.input, [
    { type: "image", data: "AQID", mime_type: "image/png" },
    { type: "image", data: "/9j/", mime_type: "image/jpeg" },
    { type: "text", text: "<FIRST_FRAME> the crowd jumps" },
  ]);
});

test("bad fields and retired Veo models are refused before any request", async () => {
  const bad = [
    { prompt: "" },
    { prompt: "x", aspectRatio: "1:1" as never },
    { prompt: "x", resolution: "8k" as never },
    { prompt: "x", seconds: 12 },
    { prompt: "x", seconds: 2.5 },
    { prompt: "x", seed: -1 },
  ];
  for (const req of bad) assert.throws(() => interactionBody(req), (e: unknown) => isGeminiError(e, "validation"));
  const { fetch, calls } = fakeFetch([ok()]);
  for (const model of ["veo-3.1-generate-preview", "veo-3.1-fast-generate-preview", "models/veo-3.0-generate-001", "veo-4-whatever"]) {
    await assert.rejects(testClient(fetch).video.start({ prompt: "x", model }), (e: unknown) => isGeminiError(e, "validation") && (e as GeminiError).code === "retired_model" && /gemini-omni-1\.1-flash/.test((e as Error).message));
  }
  assert.equal(calls.length, 0);
});

test("start POSTs /interactions and returns the id", async () => {
  const { fetch, calls } = fakeFetch([ok(inProgress("int-1"))]);
  const i = await testClient(fetch).video.start({ prompt: "A bar", aspectRatio: "9:16" });
  assert.equal(i.id, "int-1");
  assert.equal(calls[0]!.method, "POST");
  assert.equal(calls[0]!.path, "/interactions");
  assert.equal(calls[0]!.headers["Content-Type"], "application/json");
  assert.equal((calls[0]!.body as { background: boolean }).background, true);
});

test("start is retried on a 429 only: a 5xx could have started a paid generation", async () => {
  const a = fakeFetch([failure(429, "RESOURCE_EXHAUSTED", "Too many requests", undefined, { "Retry-After": "0" }), ok(inProgress("int-2"))]);
  assert.equal((await testClient(a.fetch).video.start({ prompt: "x" })).id, "int-2");
  assert.equal(a.calls.length, 2);
  const b = fakeFetch([failure(500, "INTERNAL", "oops"), ok(inProgress("never"))]);
  await assert.rejects(testClient(b.fetch).video.start({ prompt: "x" }), (e: unknown) => isGeminiError(e, "other") && (e as GeminiError).status === 500);
  assert.equal(b.calls.length, 1);
});

test("start without an id in the answer throws", async () => {
  const { fetch } = fakeFetch([ok({ status: "in_progress" })]);
  await assert.rejects(testClient(fetch).video.start({ prompt: "x" }), GeminiError);
});

test("wait polls GET /interactions/{id} with backoff until completed, then download decodes the inline video", async () => {
  const { fetch, calls } = fakeFetch([ok(inProgress("int-3")), ok(inProgress("int-3")), ok(completed("int-3", MP4))]);
  const g = testClient(fetch);
  const polls: string[] = [];
  const done = await g.video.wait("int-3", { intervalMs: 1, onPoll: (i) => polls.push(i.status) });
  assert.deepEqual(polls, ["in_progress", "in_progress", "completed"]);
  assert.ok(calls.every((c) => c.method === "GET" && c.path === "/interactions/int-3"));
  assert.deepEqual([...(await g.video.download(done))], [...MP4]);
  assert.equal(calls.length, 3);
});

test("wait on an interaction that is already completed makes no request", async () => {
  const { fetch, calls } = fakeFetch([ok()]);
  const done = await testClient(fetch).video.wait(completed("int-4") as Interaction);
  assert.equal(done.id, "int-4");
  assert.equal(calls.length, 0);
});

test("a failed interaction throws generation_failed; a safety failure is blocked", async () => {
  const f = fakeFetch([ok({ id: "i", status: "failed", errors: [{ code: "https://x/internal", message: "Something broke" }] })]);
  await assert.rejects(testClient(f.fetch).video.wait("i"), (e: unknown) => isGeminiError(e, "other") && (e as GeminiError).code === "generation_failed" && /Something broke/.test((e as Error).message));
  const s = fakeFetch([ok({ id: "i", status: "failed", errors: [{ message: "The output was blocked by safety filters." }] })]);
  await assert.rejects(testClient(s.fetch).video.wait("i"), (e: unknown) => isGeminiError(e, "blocked"));
  const c = fakeFetch([ok({ id: "i", status: "cancelled" })]);
  await assert.rejects(testClient(c.fetch).video.wait("i"), (e: unknown) => (e as GeminiError).code === "cancelled");
});

test("completed without a video is blocked (no_video), with what the model said", async () => {
  const { fetch } = fakeFetch([ok(completed("i", null))]);
  await assert.rejects(testClient(fetch).video.wait("i"), (e: unknown) => isGeminiError(e, "blocked") && (e as GeminiError).code === "no_video" && /can't make that video/.test((e as Error).message));
});

test("wait gives up with wait_timeout, and stops at once on abort", async () => {
  const t = fakeFetch([ok(inProgress("i"))]);
  await assert.rejects(testClient(t.fetch).video.wait("i", { intervalMs: 5, timeoutMs: 20 }), (e: unknown) => (e as GeminiError).code === "wait_timeout");
  const a = fakeFetch([ok(inProgress("i"))]);
  const ac = new AbortController();
  const p = testClient(a.fetch).video.wait("i", { intervalMs: 60_000, signal: ac.signal });
  setTimeout(() => ac.abort(), 10);
  await assert.rejects(p, (e: unknown) => isGeminiError(e) && (e as GeminiError).kind === "aborted");
  assert.equal(a.calls.length, 1);
});

test("download by uri waits for the file to be ACTIVE, then GETs :download?alt=media as bytes", async () => {
  const { fetch, calls } = fakeFetch((c) =>
    c.path === "/files/abc-123" ? ok({ name: "files/abc-123", state: "ACTIVE" }) : c.path === "/files/abc-123:download?alt=media" ? { status: 200, body: MP4 } : { status: 500 },
  );
  const bytes = await testClient(fetch).video.download({ mimeType: "video/mp4", uri: "https://generativelanguage.googleapis.com/v1beta/files/abc-123" });
  assert.deepEqual([...bytes], [...MP4]);
  assert.deepEqual(calls.map((c) => c.path), ["/files/abc-123", "/files/abc-123:download?alt=media"]);
  assert.equal(calls[1]!.headers["x-goog-api-key"], "AIza-test");
});

test("download never sends the key to another host", async () => {
  const { fetch, calls } = fakeFetch([ok()]);
  await assert.rejects(testClient(fetch).video.download({ mimeType: "video/mp4", uri: "https://evil.example.com/video.mp4" }), (e: unknown) => isGeminiError(e, "validation"));
  assert.equal(calls.length, 0);
});

test("generate: start, wait, download", async () => {
  const { fetch, calls } = fakeFetch([ok(inProgress("g1")), ok(inProgress("g1")), ok(completed("g1", MP4))]);
  const r = await testClient(fetch).video.generate({ prompt: "A bar", aspectRatio: "9:16" }, { intervalMs: 1 });
  assert.equal(r.interaction.id, "g1");
  assert.equal(r.mimeType, "video/mp4");
  assert.deepEqual([...r.bytes], [...MP4]);
  assert.deepEqual(calls.map((c) => `${c.method} ${c.path}`), ["POST /interactions", "GET /interactions/g1", "GET /interactions/g1"]);
});

test("cancel and delete", async () => {
  const { fetch, calls } = fakeFetch([ok({ id: "i", status: "cancelled" }), ok({})]);
  const g = testClient(fetch);
  await g.video.cancel("i");
  await g.video.delete("i");
  assert.deepEqual(calls.map((c) => `${c.method} ${c.path}`), ["POST /interactions/i/cancel", "DELETE /interactions/i"]);
});

test("videosOf, textOf and fileIdOf", () => {
  const i = completed("x", MP4) as Interaction;
  assert.equal(videosOf(i).length, 1);
  assert.equal(videosOf({ id: "y", status: "completed", outputs: [{ type: "video", uri: "files/q" }] })[0]!.uri, "files/q");
  assert.equal(textOf(completed("z", null) as Interaction), "I can't make that video.");
  assert.equal(fileIdOf("files/abc-123"), "abc-123");
  assert.equal(fileIdOf("https://generativelanguage.googleapis.com/v1beta/files/abc-123:download?alt=media"), "abc-123");
  assert.equal(fileIdOf("https://example.com/v.mp4"), undefined);
});
