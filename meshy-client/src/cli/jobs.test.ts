import assert from "node:assert/strict";
import { test } from "node:test";
import { creditsOf, DEFAULTS, formatsOf, JobError, nameFrom, outBase, parseJobs } from "./jobs.js";

test("names from image files, the files' stem, and formats with the GLB first", () => {
  assert.equal(nameFrom("D:/x/Concept Tower 01.PNG"), "concept-tower-01");
  assert.equal(nameFrom("vault_door.webp"), "vault_door");
  assert.equal(outBase({ name: "tower", texture: false }), "tower");
  assert.equal(outBase({ name: "tower", texture: true }), "tower-textured");
  assert.deepEqual(formatsOf(undefined), ["glb"]);
  assert.deepEqual(formatsOf("obj, fbx,glb"), ["glb", "obj", "fbx"]);
  assert.throws(() => formatsOf("blend"), JobError);
});

test("a jobs file: images relative to it, the flags as defaults, each entry's own options over them", () => {
  const jobs = parseJobs(
    JSON.stringify({ jobs: [{ image: "concept/Tower.png" }, { name: "vault", image: "vault.jpg", texture: true, pbr: true, model: "meshy-6", polycount: 20000 }] }),
    "/kit/piece",
    { ...DEFAULTS, topology: "quad" },
  );
  assert.equal(jobs[0]!.name, "tower");
  assert.match(jobs[0]!.image.replace(/\\/g, "/"), /\/kit\/piece\/concept\/Tower\.png$/);
  assert.equal(jobs[0]!.topology, "quad");
  assert.equal(jobs[0]!.texture, false);
  assert.equal(creditsOf(jobs[0]!).credits, 20);
  assert.equal(jobs[1]!.aiModel, "meshy-6");
  assert.equal(jobs[1]!.polycount, 20000);
  assert.equal(creditsOf(jobs[1]!).credits, 30);
});

test("Smart Topology from the flags picks meshy-t2.5; bad entries are named", () => {
  const [j] = parseJobs('[{"image":"a.png"}]', "/", { ...DEFAULTS, modelType: "smart-topology" });
  assert.equal(j!.aiModel, "meshy-t2.5");
  assert.equal(creditsOf(j!).credits, 5);
  assert.throws(() => parseJobs("[]", "/"), /no jobs/);
  assert.throws(() => parseJobs("{", "/"), /isn't JSON/);
  assert.throws(() => parseJobs('[{"name":"x"}]', "/"), /no image/);
  assert.throws(() => parseJobs('[{"image":"a.png","name":"a b"}]', "/"), /characters a file name can't/);
  assert.throws(() => parseJobs('[{"image":"a.png"},{"image":"b/a.png"}]', "/"), /Two jobs make a\.glb/);
  assert.doesNotThrow(() => parseJobs('[{"image":"a.png"},{"image":"a.png","texture":true}]', "/"), "a.glb and a-textured.glb are different files");
  assert.throws(() => parseJobs('[{"image":"a.png","pbr":true}]', "/"), /Job 1 \(a\): enable_pbr needs should_texture/);
  assert.throws(() => parseJobs('[{"image":"a.png","pose":"x"}]', "/"), /pose is a-pose or t-pose/);
  assert.throws(() => parseJobs('[{"image":"a.png","texture":"yes"}]', "/"), /texture is true or false/);
});
