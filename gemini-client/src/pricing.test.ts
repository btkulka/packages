import assert from "node:assert/strict";
import { test } from "node:test";
import { costOfUsage, estimateClipCost, estimateRunCost, formatUsd, PRICES_READ_ON, PRICES_SOURCE, retiredVideoModel, VIDEO_MODELS, VIDEO_PRICES, videoPrice } from "./index.js";

test("the table says when and where it was read", () => {
  assert.equal(PRICES_READ_ON, "2026-11-02");
  assert.equal(PRICES_SOURCE, "https://aistudio.google.com/docs/pricing");
  assert.equal(VIDEO_MODELS[0]!.id, "gemini-omni-1.1-flash");
  assert.ok(VIDEO_PRICES.every((p) => p.usdPerSecond > 0));
});

test("Omni Flash 720p: 5,792 tokens a second at $17.50 per 1M, about $0.10", () => {
  const p = videoPrice("gemini-omni-1.1-flash", "720p")!;
  assert.equal(p.verified, true);
  assert.ok(Math.abs(p.usdPerSecond - 0.10136) < 1e-9);
  assert.equal(videoPrice("models/gemini-omni-1.1-flash")!.resolution, "720p");
  assert.equal(videoPrice("gemini-omni-1.1-flash", "4k")!.verified, false);
  assert.equal(videoPrice("veo-3.1-generate-preview"), undefined);
});

test("a clip's estimate: seconds × the rate, the maximum length when none is given", () => {
  const eight = estimateClipCost({ seconds: 8 });
  assert.equal(eight.usd, 0.8109);
  assert.equal(eight.assumedSeconds, false);
  const open = estimateClipCost({});
  assert.equal(open.seconds, 10);
  assert.equal(open.assumedSeconds, true);
  assert.equal(estimateClipCost({ model: "something-else" }).unknown, true);
});

test("a run's estimate adds the clips and says when it's approximate", () => {
  const r = estimateRunCost([{ seconds: 8 }, { seconds: 8, resolution: "1080p" }]);
  assert.equal(r.usd, 1.6218);
  assert.equal(r.approximate, true);
  assert.equal(estimateRunCost([{ seconds: 5 }]).approximate, false);
});

test("costOfUsage prices video tokens at the video rate and the rest at text and input rates", () => {
  const c = costOfUsage("gemini-omni-1.1-flash", { total_input_tokens: 1_000_000, total_output_tokens: 1_000_000 + 57_920, total_thought_tokens: 0, output_tokens_by_modality: [{ modality: "video", tokens: 57_920 }] })!;
  // 57,920 × 17.5/1M + 1M × 9/1M + 1M × 1.5/1M
  assert.equal(c.usd, 11.5136);
  assert.equal(c.seconds720p, 10);
  assert.equal(costOfUsage("unknown", {}), undefined);
});

test("retired models: every Veo id, and the Omni preview", () => {
  assert.equal(retiredVideoModel("veo-3.1-fast-generate-preview")!.shutDown, "2026-10-22");
  assert.equal(retiredVideoModel("veo-3.0-generate-001")!.shutDown, "2026-06-30");
  assert.ok(retiredVideoModel("gemini-omni-flash-preview"));
  assert.ok(retiredVideoModel("veo-9"));
  assert.equal(retiredVideoModel("gemini-omni-1.1-flash"), undefined);
});

test("formatUsd", () => {
  assert.equal(formatUsd(0.8109), "$0.81");
  assert.equal(formatUsd(0.0042), "$0.0042");
  assert.equal(formatUsd(0), "$0.00");
});
