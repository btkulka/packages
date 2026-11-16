import assert from "node:assert/strict";
import { test } from "node:test";

import { buildConceptPrompt, buildTrellisPrompt, checkpointName, prune, resolveSwitches, toApi, widgetInputs } from "./workflow.js";
import type { ApiPrompt, ObjectInfo, UiWorkflow } from "./workflow.js";

const info: ObjectInfo = {
  LoadImage: { input: { required: { image: ["COMBO"] } } },
  PrimitiveBoolean: { input: { required: { value: ["BOOLEAN"] } } },
  ComfySwitchNode: { input: { required: { switch: ["BOOLEAN"], on_true: ["*"], on_false: ["*"] } } },
  KSampler: { input: { required: { seed: ["INT", { control_after_generate: true }], steps: ["INT"] } }, input_order: { required: ["seed", "steps"] } },
  Trellis2UpsampleStage: { input: { required: { latent: ["LATENT"], target_resolution: ["INT"] } } },
  PaintMesh: { input: { required: { mesh: ["MESH"] } } },
  Save3DAdvanced: { input: { required: { mesh: ["MESH"] } } },
  CheckpointLoaderSimple: { input: { required: { ckpt_name: [["SDXL\\sd_xl_turbo_1.0.safetensors", "other.safetensors"]] as unknown as [string] } } },
};

const template: UiWorkflow = {
  nodes: [
    { id: 1, type: "LoadImage", widgets_values: ["x.png"] },
    { id: 2, type: "PrimitiveBoolean", widgets_values: [false] },
    { id: 3, type: "ComfySwitchNode", inputs: [{ name: "switch", link: 1 }, { name: "on_true", link: 2 }, { name: "on_false", link: 3 }] },
    { id: 4, type: "KSampler", inputs: [{ name: "image", link: 7 }, { name: "seed", widget: { name: "seed" } }, { name: "steps", widget: { name: "steps" } }], widgets_values: [5, "randomize", 20] },
    { id: 5, type: "Trellis2UpsampleStage", inputs: [{ name: "latent", link: 4 }], widgets_values: [1536] },
    { id: 6, type: "PaintMesh", inputs: [{ name: "mesh", link: 5 }] },
    { id: 7, type: "Save3DAdvanced", inputs: [{ name: "mesh", link: 6 }] },
    { id: 8, type: "Note", widgets_values: ["hello"] },
  ],
  links: [
    [1, 2, 0, 3, 0, "BOOLEAN"],
    [2, 4, 0, 3, 1, "*"],
    [3, 1, 0, 3, 2, "*"],
    [4, 3, 0, 5, 0, "LATENT"],
    [5, 5, 0, 6, 0, "MESH"],
    [6, 6, 0, 7, 0, "MESH"],
    [7, 1, 0, 4, 0, "IMAGE"],
  ],
};

test("widgetInputs maps widgets in order and skips a seed's companion", () => {
  const n = template.nodes[3];
  assert.deepEqual(widgetInputs(n, info.KSampler), { seed: 5, steps: 20 });
});

test("toApi keeps links and drops unknown nodes", () => {
  const p = toApi(template, info);
  assert.equal(p["8"], undefined);
  assert.deepEqual(p["5"].inputs.latent, ["3", 0]);
  assert.equal(p["1"].inputs.image, "x.png");
});

test("resolveSwitches picks the branch the switch says", () => {
  const p = toApi(template, info);
  resolveSwitches(p);
  assert.equal(p["3"], undefined);
  assert.deepEqual(p["5"].inputs.latent, ["1", 0], "false picks on_false (node 1)");
  const q = toApi(template, info);
  q["2"].inputs.value = true;
  resolveSwitches(q);
  assert.deepEqual(q["5"].inputs.latent, ["4", 0], "true picks on_true (node 4)");
});

test("prune keeps only what the output needs", () => {
  const p: ApiPrompt = {
    a: { class_type: "X", inputs: {} },
    b: { class_type: "X", inputs: { in: ["a", 0] } },
    c: { class_type: "X", inputs: {} },
  };
  prune(p, "b");
  assert.deepEqual(Object.keys(p).sort(), ["a", "b"]);
});

test("buildTrellisPrompt sets TRELLIS.2, the image, the seed, the cascade and a SaveGLB of the painted mesh", () => {
  const p = buildTrellisPrompt(template, info, { imageName: "up.png", seed: 42, savePrefix: "3d/trellis/t" });
  assert.equal(p["1"].inputs.image, "up.png");
  assert.equal(p["4"].inputs.seed, 42);
  assert.equal(p["5"].inputs.target_resolution, 1024);
  assert.deepEqual(p["5"].inputs.latent, ["4", 0], "the switch resolved to TRELLIS.2 (true)");
  assert.deepEqual(p.trellis_save, { class_type: "SaveGLB", inputs: { mesh: ["6", 0], filename_prefix: "3d/trellis/t" } });
  assert.equal(p["7"], undefined, "the template's Save3DAdvanced is pruned");
  assert.equal(p["2"], undefined, "the boolean is gone with its switch");
});

test("checkpointName finds a file in any subfolder", () => {
  assert.equal(checkpointName(info, "sd_xl_turbo_1.0.safetensors"), "SDXL\\sd_xl_turbo_1.0.safetensors");
  assert.throws(() => checkpointName(info, "nope.safetensors"));
});

test("buildConceptPrompt is a seven-node SDXL graph with the style appended", () => {
  const p = buildConceptPrompt({ subject: "a brass drawer", ckpt: "c", size: 512, steps: 4, cfg: 1, sampler: "euler", scheduler: "normal", seed: 1, prefix: "trellis/x-concept", style: "plain" });
  assert.equal(Object.keys(p).length, 7);
  assert.equal(p["2"].inputs.text, "a brass drawer, plain");
  assert.equal(p["7"].inputs.filename_prefix, "trellis/x-concept");
});
