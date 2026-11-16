import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { glbToObj, meshStats, oklabToSrgb, parseGlb, splitByColor, srgbToOklab, writeObj } from "./glb.js";

/** A GLB of two triangles (a quad), the first red and the second blue, with normals, under a translated node. */
function quadGlb(): Buffer {
  const positions = new Float32Array([0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0]);
  const normals = new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1]);
  const colors = new Uint8Array([255, 0, 0, 255, 255, 0, 0, 255, 0, 0, 255, 255, 0, 0, 255, 255]); // RGBA ubyte normalized
  const indices = new Uint16Array([0, 1, 2, 0, 2, 3]);
  const bin = Buffer.concat([Buffer.from(positions.buffer), Buffer.from(normals.buffer), Buffer.from(colors.buffer), Buffer.from(indices.buffer)]);
  const json = {
    asset: { version: "2.0" },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0, translation: [10, 0, 0], name: "quad" }],
    meshes: [{ name: "quadmesh", primitives: [{ attributes: { POSITION: 0, NORMAL: 1, COLOR_0: 2 }, indices: 3 }] }],
    accessors: [
      { bufferView: 0, componentType: 5126, count: 4, type: "VEC3" },
      { bufferView: 1, componentType: 5126, count: 4, type: "VEC3" },
      { bufferView: 2, componentType: 5121, count: 4, type: "VEC4", normalized: true },
      { bufferView: 3, componentType: 5123, count: 6, type: "SCALAR" },
    ],
    bufferViews: [
      { buffer: 0, byteOffset: 0, byteLength: 48 },
      { buffer: 0, byteOffset: 48, byteLength: 48 },
      { buffer: 0, byteOffset: 96, byteLength: 16 },
      { buffer: 0, byteOffset: 112, byteLength: 12 },
    ],
    buffers: [{ byteLength: bin.length }],
  };
  let jsonBuf = Buffer.from(JSON.stringify(json));
  while (jsonBuf.length % 4) jsonBuf = Buffer.concat([jsonBuf, Buffer.from(" ")]);
  const header = Buffer.alloc(12);
  header.writeUInt32LE(0x46546c67, 0);
  header.writeUInt32LE(2, 4);
  header.writeUInt32LE(12 + 8 + jsonBuf.length + 8 + bin.length, 8);
  const jh = Buffer.alloc(8);
  jh.writeUInt32LE(jsonBuf.length, 0);
  jh.writeUInt32LE(0x4e4f534a, 4);
  const bh = Buffer.alloc(8);
  bh.writeUInt32LE(bin.length, 0);
  bh.writeUInt32LE(0x004e4942, 4);
  return Buffer.concat([header, jh, jsonBuf, bh, bin]);
}

test("parseGlb reads positions (transformed), normals, colours and indices", () => {
  const [m] = parseGlb(quadGlb());
  assert.equal(m.name, "quadmesh");
  assert.equal(m.positions[0], 10, "the node's translation is applied");
  assert.equal(m.positions[3], 11);
  assert.deepEqual([...m.indices], [0, 1, 2, 0, 2, 3]);
  assert.ok(m.normals && m.normals[2] === 1);
  assert.ok(m.colors);
  assert.equal(m.colors![0], 1, "red, normalized");
  assert.equal(m.colors![9 + 2], 1, "blue");
  const s = meshStats([m]);
  assert.equal(s.triangles, 2);
  assert.deepEqual(s.bounds.min, [10, 0, 0]);
});

test("parseGlb rejects a file without the magic", () => {
  assert.throws(() => parseGlb(Buffer.from("not a glb at all")), /glTF magic/);
});

test("OKLab round-trips sRGB", () => {
  for (const c of [[0.2, 0.5, 0.9], [1, 1, 1], [0, 0, 0], [0.75, 0.59, 0.31]] as [number, number, number][]) {
    const back = oklabToSrgb(...srgbToOklab(...c));
    for (let k = 0; k < 3; k++) assert.ok(Math.abs(back[k] - c[k]) < 1e-3, `${c} -> ${back}`);
  }
});

test("splitByColor separates the red and blue faces and writeObj writes one file per group", () => {
  const [m] = parseGlb(quadGlb());
  const { group, groups } = splitByColor(m, 2);
  assert.equal(groups.length, 2);
  assert.notEqual(group[0], group[1]);
  assert.equal(groups[0].faces + groups[1].faces, 2);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "trellis-glb-"));
  const out = writeObj(m, group, groups, path.join(dir, "quad"));
  assert.equal(out.files.length, 2);
  const text = fs.readFileSync(out.files[0], "utf8");
  assert.match(text, /^v 1[01]\.00000 /m);
  assert.match(text, /^f \d+\/\/\d+ \d+\/\/\d+ \d+\/\/\d+$/m);
  const manifest = JSON.parse(fs.readFileSync(out.manifest, "utf8")) as { groups: { hex: string }[] };
  assert.equal(manifest.groups.length, 2);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("glbToObj runs end to end from a file", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "trellis-glb-"));
  const glb = path.join(dir, "q.glb");
  fs.writeFileSync(glb, quadGlb());
  const out = glbToObj(glb, path.join(dir, "out", "q"), { colors: 2, scale: 2 });
  assert.equal(out.files.length, 2);
  assert.match(fs.readFileSync(out.files[0], "utf8"), /^v 2[02]\.00000 /m);
  fs.rmSync(dir, { recursive: true, force: true });
});
