import assert from "node:assert/strict";
import { test } from "node:test";
import { PNG } from "./fake-fetch.test.js";
import { imageTo3dBody, isMeshyError, type ImageTo3dRequest } from "./index.js";

const url = "https://example.com/concept.png";
const refused = (req: ImageTo3dRequest, re: RegExp) => assert.throws(() => imageTo3dBody(req), (e) => isMeshyError(e, "validation") && re.test(e.message));

test("the default body: latest, mesh only, nothing else sent", () => {
  assert.deepEqual(imageTo3dBody({ image: url }), { image_url: url, ai_model: "latest", should_texture: false });
});

test("images: bytes and base64 become data URIs; other strings are refused", () => {
  assert.equal(imageTo3dBody({ image: { data: PNG, mimeType: "image/png" } }).image_url, "data:image/png;base64,iVBORw0KGgo=");
  assert.equal(imageTo3dBody({ image: { data: "iVBO Rw0K\nGgo=", mimeType: "image/jpeg" } }).image_url, "data:image/jpeg;base64,iVBORw0KGgo=");
  assert.equal(imageTo3dBody({ image: "data:image/webp;base64,AAAA" }).image_url, "data:image/webp;base64,AAAA");
  refused({ image: "C:/concept.png" }, /https URL/);
  refused({ image: { data: PNG, mimeType: "image/gif" as "image/png" } }, /PNG, JPEG or WebP/);
  refused({ image: { data: new Uint8Array(0), mimeType: "image/png" } }, /empty/);
});

test("texturing: on when asked, with its options; those options alone are refused", () => {
  const b = imageTo3dBody({ image: url, shouldTexture: true, enablePbr: true, textureResolution: "4k", texturePrompt: " rusty steel " });
  assert.equal(b.should_texture, true);
  assert.equal(b.enable_pbr, true);
  assert.equal(b.texture_resolution, "4k");
  assert.equal(b.texture_prompt, "rusty steel");
  refused({ image: url, enablePbr: true }, /enable_pbr needs should_texture/);
  refused({ image: url, textureResolution: "4k" }, /needs should_texture/);
  refused({ image: url, shouldTexture: true, texturePrompt: "x".repeat(801) }, /800/);
  refused({ image: url, aiModel: "meshy-6-lite", shouldTexture: true, textureResolution: "4k" }, /no 4k texture/);
});

test("Smart Topology: set by its models, meshy-t2.5 by default, triangles only, its own polycount range", () => {
  assert.deepEqual(imageTo3dBody({ image: url, aiModel: "meshy-t2" }), { image_url: url, ai_model: "meshy-t2", model_type: "smart-topology", should_texture: false });
  const b = imageTo3dBody({ image: url, modelType: "smart-topology", targetPolycount: 8000 });
  assert.equal(b.ai_model, "meshy-t2.5");
  assert.equal(b.target_polycount, 8000);
  assert.equal(b.should_remesh, undefined, "Smart Topology ignores should_remesh, so it isn't sent");
  refused({ image: url, aiModel: "meshy-t2", targetPolycount: 20_000 }, /100 to 15000/);
  refused({ image: url, modelType: "smart-topology", topology: "quad" }, /triangles only/);
  refused({ image: url, aiModel: "meshy-6", modelType: "smart-topology" }, /runs under model_type standard/);
});

test("remeshing: topology and polycount turn it on; off with them is refused", () => {
  const b = imageTo3dBody({ image: url, topology: "quad", targetPolycount: 12_000 });
  assert.equal(b.should_remesh, true);
  assert.equal(b.topology, "quad");
  assert.equal(b.target_polycount, 12_000);
  assert.equal(imageTo3dBody({ image: url, shouldRemesh: false }).should_remesh, false);
  refused({ image: url, shouldRemesh: false, targetPolycount: 5000 }, /only apply when remeshing/);
  refused({ image: url, targetPolycount: 50 }, /100 to 300000/);
  refused({ image: url, topology: "hex" as "quad" }, /triangle or quad/);
});

test("pose, Ultra, image enhancement, formats and extras", () => {
  const b = imageTo3dBody({ image: url, poseMode: "a-pose", geometryResolution: "4k", imageEnhancement: false, targetFormats: ["glb", "GLB" as "glb", "obj"], extra: { auto_size: true, should_texture: true } });
  assert.equal(b.pose_mode, "a-pose");
  assert.equal(b.geometry_resolution, "4k");
  assert.equal(b.image_enhancement, false);
  assert.deepEqual(b.target_formats, ["glb", "obj"]);
  assert.equal(b.auto_size, true);
  assert.equal(b.should_texture, true, "extra goes over the fields");
  refused({ image: url, aiModel: "meshy-6", geometryResolution: "2k" }, /no 2k Ultra/);
  refused({ image: url, aiModel: "meshy-7", geometryResolution: "4k" }, /no 4k Ultra/);
  refused({ image: url, aiModel: "meshy-6-lite", imageEnhancement: false }, /image_enhancement/);
  refused({ image: url, poseMode: "x-pose" as "a-pose" }, /a-pose or t-pose/);
  refused({ image: url, targetFormats: ["blend" as "glb"] }, /not blend/);
  assert.equal(imageTo3dBody({ image: url, aiModel: "meshy-99" }).ai_model, "meshy-99", "a model the table doesn't know is sent as given");
});
