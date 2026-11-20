import assert from "node:assert/strict";
import { test } from "node:test";
import { estimateCredits, estimateRunCredits, formatUsd, PLANS, usdOf, usdPerCreditOf } from "./index.js";

test("credits per task, as docs.meshy.ai/api/pricing gives them (2026-11-19)", () => {
  const c = (o: Parameters<typeof estimateCredits>[0]) => estimateCredits(o).credits;
  assert.equal(c({}), 20, "latest, mesh only");
  assert.equal(c({ shouldTexture: true }), 30, "latest, 2K texture");
  assert.equal(c({ shouldTexture: true, textureResolution: "4k" }), 30);
  assert.equal(c({ shouldTexture: true, textureResolution: "8k" }), 35);
  assert.equal(c({ geometryResolution: "4k" }), 25, "Ultra +5");
  assert.equal(c({ geometryResolution: "standard" }), 20);
  assert.equal(c({ aiModel: "meshy-7.1", shouldTexture: true, geometryResolution: "2k" }), 35);
  assert.equal(c({ aiModel: "meshy-6" }), 20);
  assert.equal(c({ aiModel: "meshy-6-lite" }), 5);
  assert.equal(c({ aiModel: "meshy-6-lite", shouldTexture: true }), 15);
  assert.equal(c({ modelType: "smart-topology" }), 5, "meshy-t2.5 by default");
  assert.equal(c({ aiModel: "meshy-t2", shouldTexture: true, textureResolution: "8k" }), 20);
});

test("what the table can't price is unknown, not guessed", () => {
  assert.deepEqual([estimateCredits({ aiModel: "meshy-99" }).unknown, estimateCredits({ aiModel: "meshy-99" }).credits], [true, 0]);
  assert.equal(estimateCredits({ aiModel: "meshy-6-lite", shouldTexture: true, textureResolution: "4k" }).unknown, true);
  assert.equal(estimateCredits({ aiModel: "meshy-6", geometryResolution: "2k" }).unknown, true);
  const run = estimateRunCredits([{}, { shouldTexture: true }, { aiModel: "meshy-99" }]);
  assert.equal(run.credits, 50);
  assert.equal(run.unknown, true);
});

test("dollars only from a rate: a number or a plan's own (Meshy states none)", () => {
  assert.equal(usdPerCreditOf("pro"), 0.02);
  assert.equal(usdPerCreditOf("0.015"), 0.015);
  assert.equal(usdPerCreditOf("$0.01"), 0.01);
  assert.equal(usdPerCreditOf("nope"), undefined);
  assert.equal(usdPerCreditOf(undefined), undefined);
  assert.equal(PLANS.find((p) => p.id === "ultra")!.usdPerCredit, 0.0125);
  assert.equal(usdOf(60, 0.02), 1.2);
  assert.equal(usdOf(60, undefined), undefined);
  assert.equal(formatUsd(1.2), "$1.20");
  assert.equal(formatUsd(0.004), "$0.0040");
});
