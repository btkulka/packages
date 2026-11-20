import assert from "node:assert/strict";
import { test } from "node:test";
import { failure, fakeFetch, ok, testClient } from "./fake-fetch.test.js";
import { bytesToBase64, costOfImageUsage, DEFAULT_IMAGE_MODEL, estimateImageCost, imageBody, imageModel, isGeminiError, outputImagesOf, thoughtImagesOf } from "./index.js";

const PNG = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
const DRAFT = new Uint8Array([1, 2, 3]);
/** A finished image interaction, the way the Interactions API writes it. */
const drawn = (extra: Record<string, unknown> = {}) => ({
  id: "int-1",
  status: "completed",
  model: DEFAULT_IMAGE_MODEL,
  steps: [
    { type: "thought", summary: [{ type: "text", text: "Planning the drawer…" }, { type: "image", mime_type: "image/png", data: bytesToBase64(DRAFT) }] },
    { type: "model_output", content: [{ type: "text", text: "Here is the drawer." }, { type: "image", mime_type: "image/png", data: bytesToBase64(PNG) }] },
  ],
  usage: { total_input_tokens: 600, total_output_tokens: 1130, total_thought_tokens: 200, output_tokens_by_modality: [{ modality: "image", tokens: 1120 }] },
  ...extra,
});

test("imageBody: references before the text, the house style ahead of the prompt, response_format only as asked", () => {
  const b = imageBody({ prompt: " a brass drawer ", images: [{ data: PNG, mimeType: "image/png" }], aspectRatio: "3:4", size: "2K", system: "Toon, about 20%." });
  assert.equal(b.model, DEFAULT_IMAGE_MODEL);
  assert.deepEqual(b.input, [
    { type: "image", data: bytesToBase64(PNG), mime_type: "image/png" },
    { type: "text", text: "Toon, about 20%.\n\na brass drawer" },
  ]);
  assert.deepEqual(b.response_format, { type: "image", aspect_ratio: "3:4", image_size: "2K" });
  const plain = imageBody({ prompt: "x", model: "2.1", text: true });
  assert.equal(plain.model, "gemini-nano-banana-2.1");
  assert.equal(plain.input, "x");
  assert.deepEqual(plain.response_format, [{ type: "text" }, { type: "image" }]);
});

test("imageBody refuses what Google would: no prompt, a lower-case size, a ratio Pro lacks, 15 references", () => {
  assert.throws(() => imageBody({ prompt: "  " }), /No prompt/);
  assert.throws(() => imageBody({ prompt: "x", size: "2k" as "2K" }), /capital K/);
  assert.throws(() => imageBody({ prompt: "x", aspectRatio: "7:5" as "1:1" }), /Aspect ratio/);
  assert.throws(() => imageBody({ prompt: "x", aspectRatio: "8:1" }), /Pro has no 8:1/);
  assert.doesNotThrow(() => imageBody({ prompt: "x", aspectRatio: "8:1", model: "flash" }));
  const ref = { data: PNG, mimeType: "image/png" as const };
  assert.throws(() => imageBody({ prompt: "x", images: Array(15).fill(ref) }), /most a call takes is 14/);
});

test("model names: ids, aliases, and the retired previews mapped to their replacements", () => {
  assert.equal(imageModel("nano-banana-pro")?.id, "gemini-3-pro-image");
  assert.equal(imageModel("models/gemini-3-pro-image-preview")?.id, "gemini-3-pro-image");
  assert.equal(imageModel("gemini-3.1-flash-image-preview")?.id, "gemini-nano-banana-2.1");
  assert.equal(imageModel("flash")?.id, "gemini-3.1-flash-image");
  assert.equal(imageModel("nope"), undefined);
});

test("generate posts one interaction and keeps the finished image apart from thought drafts", async () => {
  const { fetch, calls } = fakeFetch([ok(drawn())]);
  const r = await testClient(fetch).image.generate({ prompt: "a drawer", size: "2K" });
  assert.equal(calls[0]!.method, "POST");
  assert.equal(calls[0]!.path, "/interactions");
  assert.deepEqual([...r.image.bytes], [...PNG]);
  assert.equal(r.thoughts.length, 1);
  assert.deepEqual([...r.thoughts[0]!.bytes], [...DRAFT]);
  assert.equal(r.text, "Here is the drawer.");
  assert.equal(r.interaction.id, "int-1");
});

test("outputImagesOf and thoughtImagesOf read steps, and outputs from older revisions", () => {
  assert.equal(outputImagesOf({ id: "a", status: "completed", outputs: [{ type: "image", data: bytesToBase64(PNG) }] }).length, 1);
  assert.deepEqual(outputImagesOf(undefined), []);
  assert.equal(thoughtImagesOf(drawn() as never).length, 1);
});

test("an interaction without an image, or a failed one, throws; a safety reason is category blocked", async () => {
  const empty = fakeFetch([ok({ id: "a", status: "completed", steps: [{ type: "model_output", content: [{ type: "text", text: "I can't draw that." }] }] })]);
  await assert.rejects(testClient(empty.fetch).image.generate({ prompt: "x" }), (e: unknown) => isGeminiError(e, "blocked") && e.code === "no_image" && /can't draw/.test(e.message));
  const failed = fakeFetch([ok({ id: "b", status: "failed", errors: [{ code: "SAFETY", message: "blocked by safety policy" }] })]);
  await assert.rejects(testClient(failed.fetch).image.generate({ prompt: "x" }), (e: unknown) => isGeminiError(e, "blocked") && e.code === "generation_failed");
});

test("a paid image isn't sent twice on a 500; a 429 or a 503 (refused before drawing) is retried", async () => {
  const broken = fakeFetch([failure(500, "INTERNAL", "oops"), ok(drawn())]);
  await assert.rejects(testClient(broken.fetch).image.generate({ prompt: "x" }));
  assert.equal(broken.calls.length, 1);
  const limited = fakeFetch([failure(429, "RESOURCE_EXHAUSTED", "slow down"), ok(drawn())]);
  await testClient(limited.fetch).image.generate({ prompt: "x" });
  assert.equal(limited.calls.length, 2);
  const busy = fakeFetch([failure(503, "UNAVAILABLE", "gemini-3-pro-image is currently experiencing high demand"), ok(drawn())]);
  await testClient(busy.fetch).image.generate({ prompt: "x" });
  assert.equal(busy.calls.length, 2);
});

test("prices: Google's per-image figures, references at the input rate, and the real cost from usage", () => {
  const e = estimateImageCost([{ size: "2K" }, { size: "4K", references: 2 }, { model: "2.1", size: "2K" }, { model: "nope", size: "1K" }]);
  assert.equal(e.images[0]!.usd, 0.134);
  assert.equal(e.images[1]!.usd, 0.2422);
  assert.equal(e.images[2]!.usd, 0.0504);
  assert.equal(e.unknown, true);
  assert.equal(e.images[3]!.usd, 0);
  const c = costOfImageUsage(DEFAULT_IMAGE_MODEL, "2K", drawn().usage)!;
  assert.equal(c.imageTokens, 1120);
  assert.equal(c.usd, 0.1381);
});
