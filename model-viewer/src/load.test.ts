import assert from "node:assert/strict";
import { test } from "node:test";
import { formatOf, loadModel, type ModelSource } from "./load.js";
import { setFiles, setParts } from "./sets.js";

// Reading models without a GPU: the loaders and the counts run in Node (no textures here, which need a
// browser to decode).

/** A .glb holding one triangle with vertex colours, made by hand. */
function triangleGlb(): ArrayBuffer {
  const pos = new Float32Array([0, 0, 0, 1, 0, 0, 0, 2, 0]);
  const col = new Float32Array([1, 0, 0, 0, 1, 0, 0, 0, 1]);
  const bin = new Uint8Array(pos.byteLength + col.byteLength);
  bin.set(new Uint8Array(pos.buffer), 0);
  bin.set(new Uint8Array(col.buffer), pos.byteLength);
  const json = {
    asset: { version: "2.0" },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0 }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0, COLOR_0: 1 } }] }],
    buffers: [{ byteLength: bin.byteLength }],
    bufferViews: [
      { buffer: 0, byteOffset: 0, byteLength: pos.byteLength },
      { buffer: 0, byteOffset: pos.byteLength, byteLength: col.byteLength },
    ],
    accessors: [
      { bufferView: 0, componentType: 5126, count: 3, type: "VEC3", min: [0, 0, 0], max: [1, 2, 0] },
      { bufferView: 1, componentType: 5126, count: 3, type: "VEC3" },
    ],
  };
  let j = new TextEncoder().encode(JSON.stringify(json));
  const jl = Math.ceil(j.length / 4) * 4;
  const jp = new Uint8Array(jl).fill(0x20);
  jp.set(j);
  j = jp;
  const total = 12 + 8 + jl + 8 + bin.byteLength;
  const out = new ArrayBuffer(total);
  const v = new DataView(out);
  v.setUint32(0, 0x46546c67, true);
  v.setUint32(4, 2, true);
  v.setUint32(8, total, true);
  v.setUint32(12, jl, true);
  v.setUint32(16, 0x4e4f534a, true);
  new Uint8Array(out, 20, jl).set(j);
  v.setUint32(20 + jl, bin.byteLength, true);
  v.setUint32(24 + jl, 0x004e4942, true);
  new Uint8Array(out, 28 + jl).set(bin);
  return out;
}

const enc = (s: string) => new TextEncoder().encode(s).buffer as ArrayBuffer;
const files = (name: string, map: Record<string, ArrayBuffer>): ModelSource => ({
  name,
  read: async (rel) => {
    const b = map[rel || name];
    if (!b) throw new Error(`no ${rel}`);
    return b;
  },
});

test("formats come from the extension", () => {
  assert.equal(formatOf("a.GLB"), "glb");
  assert.equal(formatOf("D:/m/a.gltf"), "gltf");
  assert.equal(formatOf("a.obj"), "obj");
  assert.equal(formatOf("ufo.json"), "set");
  assert.equal(formatOf("a.png"), undefined);
});

test("a .glb loads and counts its triangle, vertices and colours", async () => {
  const m = await loadModel(files("tri.glb", { "tri.glb": triangleGlb() }));
  assert.equal(m.stats.format, "glb");
  assert.equal(m.stats.triangles, 1);
  assert.equal(m.stats.vertices, 3);
  assert.equal(m.stats.vertexColors, true);
  assert.deepEqual(m.stats.size.map((x) => Math.round(x)), [1, 2, 0]);
  m.release();
});

test("an .obj counts quads as two triangles and gets a plain material without an .mtl", async () => {
  const obj = "v 0 0 0\nv 1 0 0\nv 1 1 0\nv 0 1 0\nf 1 2 3 4\n";
  const m = await loadModel(files("q.obj", { "q.obj": enc(obj) }));
  assert.equal(m.stats.triangles, 2);
  assert.equal(m.stats.materials, 1);
  assert.equal(m.stats.vertexColors, false);
});

test("an .obj whose .mtl is missing still loads and says what's missing", async () => {
  const obj = "mtllib gone.mtl\nv 0 0 0\nv 1 0 0\nv 1 1 0\nf 1 2 3\n";
  const m = await loadModel(files("t.obj", { "t.obj": enc(obj) }));
  assert.equal(m.stats.triangles, 1);
  assert.deepEqual(m.stats.missing, ["gone.mtl"]);
});

test("a set's sidecar names its parts, and the set loads them in their colours", async () => {
  const sidecar = {
    name: "heap",
    groups: [
      { file: "heap_0.obj", hex: "#aca38f", faces: 1 },
      { file: "heap_1.obj", srgb: [0.5, 0.4, 0.3], faces: 1 },
      { file: "../escape.obj", hex: "#000000" },
      { file: "notes.txt" },
    ],
  };
  assert.deepEqual(setFiles(sidecar), ["heap_0.obj", "heap_1.obj"]);
  const tri = enc("v 0 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 3\n");
  const m = await loadModel(files("heap.json", { "heap.json": enc(JSON.stringify(sidecar)), "heap_0.obj": tri, "heap_1.obj": tri }));
  assert.equal(m.stats.format, "set");
  assert.equal(m.stats.triangles, 2);
  assert.equal(m.stats.materials, 2);
});

test("a Blender export's parts carry linear colours, roughness and a held-down glow", () => {
  const [p] = setParts({ files: [{ file: "ufo_body_beam.obj", part: "body", material: "beam", color: [0.3, 0.25, 0.15], roughness: 0.5, metallic: 0, emission: [1, 0.78, 0.42], emission_strength: 8 }] });
  assert.equal(p.label, "body · beam");
  assert.deepEqual(p.linear, [0.3, 0.25, 0.15]);
  assert.equal(p.roughness, 0.5);
  assert.deepEqual(p.emissive, [1, 0.78, 0.42]);
  assert.equal(setParts({ files: [{ file: "a.obj", emission: [1, 1, 1], emission_strength: 0 }] })[0].emissive, undefined);
  assert.deepEqual(setParts({ prompt: "x" }), []);
});

test("a set whose parts are all gone says so", async () => {
  await assert.rejects(loadModel(files("s.json", { "s.json": enc(JSON.stringify({ groups: [{ file: "s_0.obj", hex: "#ffffff" }] })) })), /None of s\.json's parts/);
});
