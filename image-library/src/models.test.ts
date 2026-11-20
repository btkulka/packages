import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, before, test } from "node:test";
import { openLibrary, STARRED, walk, type Library } from "./library.js";
import { companionsOf, conceptStems, isPart, meshInfo, partsOf, sidecarStems } from "./models.js";
import { normPath } from "./paths.js";

// 3D models in the library: what's read from a .glb, an .obj and a set's sidecar; sets folding their
// parts; concept images found through trellis-client's .meta.json or a shared name; the files that go
// with a model when it moves.

function png(width: number, height: number, salt = 0) {
  const b = Buffer.alloc(64 + salt);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]).copy(b, 0);
  b.write("IHDR", 12, "ascii");
  b.writeUInt32BE(width, 16);
  b.writeUInt32BE(height, 20);
  return b;
}

/** A .glb: one triangle (or two, as a quad), vertex colours or an embedded PNG as its base colour. */
function glb(o: { texture?: Buffer; quad?: boolean; salt?: number } = {}): Buffer {
  const verts = o.quad ? [0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0] : [0, 0, 0, 2, 0, 0, 0, 3, 1];
  const pos = Buffer.from(new Float32Array(verts).buffer);
  const idx = o.quad ? Buffer.from(new Uint16Array([0, 1, 2, 0, 2, 3]).buffer) : undefined;
  const col = Buffer.from(new Float32Array(new Array((verts.length / 3) * 3).fill(0.5)).buffer);
  const tex = o.texture ?? Buffer.alloc(0);
  const pad = (b: Buffer) => Buffer.concat([b, Buffer.alloc((4 - (b.length % 4)) % 4)]);
  const chunks = [pad(pos), pad(o.texture ? Buffer.alloc(0) : col), pad(idx ?? Buffer.alloc(0)), pad(tex)];
  let off = 0;
  const views = chunks.map((c, i) => {
    const v = { buffer: 0, byteOffset: off, byteLength: [pos, o.texture ? Buffer.alloc(0) : col, idx ?? Buffer.alloc(0), tex][i].length };
    off += c.length;
    return v;
  });
  const bin = Buffer.concat([...chunks, Buffer.alloc(o.salt ?? 0)]);
  const n = verts.length / 3;
  const json = {
    asset: { version: "2.0" },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0 }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0, ...(o.texture ? {} : { COLOR_0: 1 }) }, ...(idx ? { indices: 2 } : {}), material: 0 }] }],
    materials: [o.texture ? { pbrMetallicRoughness: { baseColorTexture: { index: 0 } } } : { pbrMetallicRoughness: {} }],
    ...(o.texture ? { textures: [{ source: 0 }], images: [{ bufferView: 3, mimeType: "image/png" }] } : {}),
    buffers: [{ byteLength: bin.length }],
    bufferViews: views,
    accessors: [
      { bufferView: 0, componentType: 5126, count: n, type: "VEC3", min: [0, 0, 0], max: o.quad ? [1, 1, 0] : [2, 3, 1] },
      { bufferView: 1, componentType: 5126, count: n, type: "VEC3" },
      ...(idx ? [{ bufferView: 2, componentType: 5123, count: 6, type: "SCALAR" }] : []),
    ],
  };
  const text = JSON.stringify(json);
  const jp = Buffer.from(text.padEnd(Math.ceil(text.length / 4) * 4, " "));
  const head = Buffer.alloc(12);
  head.writeUInt32LE(0x46546c67, 0);
  head.writeUInt32LE(2, 4);
  head.writeUInt32LE(12 + 8 + jp.length + 8 + bin.length, 8);
  const jh = Buffer.alloc(8);
  jh.writeUInt32LE(jp.length, 0);
  jh.writeUInt32LE(0x4e4f534a, 4);
  const bh = Buffer.alloc(8);
  bh.writeUInt32LE(bin.length, 0);
  bh.writeUInt32LE(0x004e4942, 4);
  return Buffer.concat([head, jh, jp, bh, bin]);
}

const tri = "v 0 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 3\n";

let dir: string;
let lib: Library;
const at = (...p: string[]) => normPath(join(dir, ...p));
const put = (rel: string, data: string | Buffer) => {
  const p = join(dir, rel);
  mkdirSync(join(p, ".."), { recursive: true });
  writeFileSync(p, data);
  return normPath(p);
};

before(() => {
  dir = mkdtempSync(join(tmpdir(), "image-library-models-"));
  // A toejam piece: concept art, and models made from it.
  put("piece/concept/NHI/nhi_02_banknote_brick.png", png(1024, 1024));
  put("piece/concept/drawer.png", png(800, 800, 1));
  put("piece/models/trellis/brick-px.glb", glb({ salt: 1 }));
  put("piece/models/trellis/brick-px-textured.glb", glb({ texture: png(4096, 4096), quad: true }));
  put("piece/models/trellis/brick-px.meta.json", JSON.stringify({ name: "brick-px", seed: 5, image: "nhi_02_banknote_brick.png", prompt: null, model: "pixal3d", quality: "high", secs: 95, made: "2026-11-17T02:20:21.268Z", tool: "@btkulka/trellis-client" }));
  put("piece/models/trellis/heap.glb", glb({ salt: 2 }));
  put("piece/models/trellis/heap.json", JSON.stringify({ name: "heap", groups: [{ file: "heap_0.obj", hex: "#aca38f", faces: 1 }, { file: "heap_1.obj", hex: "#443b30", faces: 1 }] }));
  put("piece/models/trellis/heap_0.obj", tri);
  put("piece/models/trellis/heap_1.obj", tri + "v 0 0 1\nf 1 2 4\n");
  put("piece/models/trellis/drawer.glb", glb({ salt: 3 }));
  // A Blender export: parts and their sidecar, no .glb.
  put("piece/models/ufo.json", JSON.stringify({ model: "ufo", tris: 3, size: [308.1, 49.1, 308.1], files: [{ file: "ufo_body_beam.obj", part: "body", material: "beam", tris: 1, color: [0.3, 0.25, 0.15] }, { file: "ufo_rim_gold.obj", part: "rim", material: "gold", tris: 2, color: [0.52, 0.31, 0.08] }] }));
  put("piece/models/ufo_body_beam.obj", tri);
  put("piece/models/ufo_rim_gold.obj", tri + "v 0 0 1\nf 1 2 4\n");
  put("piece/models/lamp.obj", "mtllib lamp.mtl\nv 0 0 0 1 0 0\nv 1 0 0 1 0 0\nv 1 1 0 1 0 0\nv 0 1 0 1 0 0\nvt 0 0\nusemtl metal\nf 1 2 3 4\n");
  put("piece/models/lamp.mtl", "newmtl metal\nKd 1 1 1\nmap_Kd -s 1 1 1 tex/lamp_d.png\n");
  put("piece/models/tex/lamp_d.png", png(2048, 1024, 2));
  lib = openLibrary(DatabaseSync, join(dir, "lib.db"));
});

after(() => {
  lib.close();
  rmSync(dir, { recursive: true, force: true });
});

test("a .glb's triangles, vertices, colours, size and embedded texture come from its JSON chunk", async () => {
  const plain = await meshInfo(at("piece/models/trellis/brick-px.glb"));
  assert.equal(plain.format, "glb");
  assert.equal(plain.triangles, 1);
  assert.equal(plain.vertices, 3);
  assert.equal(plain.vertexColors, true);
  assert.deepEqual(plain.size, [2, 3, 1]);
  assert.deepEqual(plain.textures, []);
  const tex = await meshInfo(at("piece/models/trellis/brick-px-textured.glb"));
  assert.equal(tex.triangles, 2);
  assert.equal(tex.vertexColors, false);
  assert.equal(tex.textures.length, 1);
  assert.deepEqual({ w: tex.textures[0].width, h: tex.textures[0].height, role: tex.textures[0].role, mime: tex.textures[0].mime }, { w: 4096, h: 4096, role: "base colour", mime: "image/png" });
});

test("an .obj is counted line by line: quads as two triangles, vertex colours, its .mtl's maps", async () => {
  const m = await meshInfo(at("piece/models/lamp.obj"));
  assert.equal(m.format, "obj");
  assert.equal(m.triangles, 2);
  assert.equal(m.vertices, 4);
  assert.equal(m.vertexColors, true);
  assert.equal(m.uvs, true);
  assert.equal(m.materials, 1);
  assert.deepEqual(m.textures.map((t) => [t.name, t.role, t.width, t.height]), [["lamp_d.png", "base colour", 2048, 1024]]);
});

test("a set is read through its sidecar: parts, colours, triangles; a broken file says why", async () => {
  assert.deepEqual(partsOf({ groups: [{ file: "a_0.obj" }, { file: "../x.obj" }], files: [{ file: "b.obj" }, { file: "c.png" }] }), ["a_0.obj", "b.obj"]);
  const ufo = await meshInfo(at("piece/models/ufo.json"));
  assert.equal(ufo.format, "set");
  assert.equal(ufo.triangles, 3);
  assert.deepEqual(ufo.parts?.map((p) => [p.label, p.triangles]), [["body · beam", 1], ["rim · gold", 2]]);
  assert.match(ufo.parts![0].color!, /^#[0-9a-f]{6}$/);
  assert.deepEqual(ufo.size, [308.1, 49.1, 308.1]);
  const broken = await meshInfo(put("piece/broken.glb", "not a glb at all, nope"));
  assert.equal(broken.triangles, null);
  assert.match(broken.error!, /glTF header/);
  rmSync(at("piece/broken.glb"));
});

test("stems: a variant shares its base's sidecar, and a model's name can be its concept's", () => {
  assert.deepEqual(sidecarStems("brick-px-textured.glb"), ["brick-px-textured", "brick-px"]);
  assert.deepEqual(conceptStems("ufo-t2-textured.glb"), ["ufo-t2-textured", "ufo-t2", "ufo"]);
  assert.deepEqual(conceptStems("drawer.glb"), ["drawer"]);
});

test("walk folds a set's parts into its .glb, or into its sidecar when there's no .glb", async () => {
  const found = (await walk(at("piece/models"))).map((p) => p.slice(at("piece/models").length + 1)).sort();
  assert.deepEqual(found, ["lamp.obj", "tex/lamp_d.png", "trellis/brick-px-textured.glb", "trellis/brick-px.glb", "trellis/drawer.glb", "trellis/heap.glb", "ufo.json"]);
  assert.equal(await isPart(at("piece/models/trellis/heap_1.obj")), true);
  assert.equal(await isPart(at("piece/models/ufo_rim_gold.obj")), true);
  assert.equal(await isPart(at("piece/models/lamp.obj")), false);
});

test("a watched models folder brings models in, and a sidecar's concept image with them", async () => {
  const models = lib.ensureCollectionPath("toejam > Money Warehouse > Models");
  const w = lib.addWatch({ folder: at("piece/models"), collectionId: models.id });
  const r = await lib.scanWatch(w.id);
  assert.equal(r.errors.length, 0);
  const got = lib.search({ kind: "model", limit: 50, stacks: "expand" }).items;
  assert.deepEqual(got.map((m) => m.name).sort(), ["brick-px-textured.glb", "brick-px.glb", "drawer.glb", "heap.glb", "lamp.obj", "ufo.json"]);
  assert.ok(got.every((m) => m.kind === "model" && m.width === null && m.mesh));
  assert.equal(got.find((m) => m.name === "heap.glb")!.tris, 1);
  assert.equal(got.find((m) => m.name === "ufo.json")!.mesh!.format, "set");
  assert.equal(lib.info().meshes, 6);
  assert.equal(lib.search({ text: "is:model", limit: 50, stacks: "expand" }).total, 6);
  assert.equal(lib.search({ text: "is:model", limit: 50 }).total, 5, "the brick's textured and untextured meshes are one stack");
  assert.equal(lib.search({ text: "-is:model", collectionId: models.id, limit: 50 }).total, 1, "the .mtl's texture is a picture in the folder too");
  assert.equal(lib.search({ text: "model:pixal3d", limit: 50, stacks: "expand" }).total, 2, "the variant reads its base's sidecar");

  // The meta named nhi_02_banknote_brick.png only by name: found under the piece's concept folder and added.
  const brick = await lib.image(at("piece/models/trellis/brick-px.glb"));
  assert.equal(brick.concept?.name, "nhi_02_banknote_brick.png");
  assert.equal(brick.concept?.how, "sidecar");
  assert.equal(brick.created, "2026-11-17T02:20:21.268Z");
  assert.equal(brick.model, "pixal3d");
  assert.equal((brick.sidecar as { seed?: number } | null)?.seed, 5);
  assert.equal((await lib.image(at("piece/models/trellis/brick-px-textured.glb"))).concept?.id, brick.concept?.id);
  assert.equal(lib.find(at("piece/concept/NHI/nhi_02_banknote_brick.png"))?.kind, "image");
  const art = await lib.image(brick.concept!.id);
  assert.deepEqual(art.models.map((m) => m.name), ["brick-px-textured.glb", "brick-px.glb"]);

  // drawer.glb ↔ drawer.png by name, once the picture is in the library.
  assert.equal(lib.conceptOf(lib.find(at("piece/models/trellis/drawer.glb"))!.id), null);
  await lib.addPaths([at("piece/concept/drawer.png")]);
  const drawer = lib.conceptOf(lib.find(at("piece/models/trellis/drawer.glb"))!.id);
  assert.equal(drawer?.name, "drawer.png");
  assert.equal(drawer?.how, "name");

  // By hand, and back.
  const heap = lib.find(at("piece/models/trellis/heap.glb"))!;
  assert.equal(lib.setConcept(heap.id, at("piece/concept/drawer.png"))?.how, "set");
  assert.equal(lib.setConcept(heap.id, null), null);
  assert.throws(() => lib.setConcept(heap.id, heap.id), /isn't a picture/);
});

test("a model's companions: sidecars, a set's parts, an .obj's .mtl and maps", async () => {
  const heap = await companionsOf(at("piece/models/trellis/heap.glb"));
  assert.deepEqual(heap.map((p) => p.split("/").pop()).sort(), ["heap.json", "heap_0.obj", "heap_1.obj"]);
  const lamp = await companionsOf(at("piece/models/lamp.obj"));
  assert.deepEqual(lamp.map((p) => p.split("/").pop()).sort(), ["lamp.mtl", "lamp_d.png"]);
  const brick = (await lib.image(at("piece/models/trellis/brick-px.glb"))).companions;
  assert.deepEqual(brick.map((p) => p.split("/").pop()), ["brick-px.meta.json"]);
});

test("moving a model takes its companions; a set can't be renamed; a model's rename takes its sidecars", async () => {
  const heap = lib.find(at("piece/models/trellis/heap.glb"))!;
  const r = await lib.moveFiles([heap.id], at("piece/models/kept"));
  assert.equal(r.failed.length, 0);
  for (const f of ["heap.glb", "heap.json", "heap_0.obj", "heap_1.obj"]) assert.ok(existsSync(at("piece/models/kept", f)), f);
  assert.equal(existsSync(at("piece/models/trellis/heap_0.obj")), false);
  assert.equal(lib.find(heap.id)?.path, at("piece/models/kept/heap.glb"));

  const ufo = lib.find(at("piece/models/ufo.json"))!;
  await assert.rejects(lib.renameImage(ufo.id, "saucer"), /is a set/);
  const brick = lib.find(at("piece/models/trellis/brick-px.glb"))!;
  const renamed = await lib.renameImage(brick.id, "brick-pixal");
  assert.equal(renamed.name, "brick-pixal.glb");
  assert.ok(existsSync(at("piece/models/trellis/brick-pixal.meta.json")));
});

test("parts that arrive before their sidecar fold into the set when it's written", async () => {
  put("piece/models/late/crate.glb", glb({ salt: 4 }));
  put("piece/models/late/crate_0.obj", tri);
  for (const f of ["crate.glb", "crate_0.obj"]) await lib.onDiskChange(at("piece/models/late", f));
  assert.ok(lib.find(at("piece/models/late/crate_0.obj")), "on its own until the sidecar says otherwise");
  put("piece/models/late/crate.json", JSON.stringify({ name: "crate", groups: [{ file: "crate_0.obj", hex: "#ffffff", faces: 1 }] }));
  assert.equal(await lib.onDiskChange(at("piece/models/late/crate.json")), true);
  assert.equal(lib.find(at("piece/models/late/crate_0.obj")), undefined, "out of the library");
  assert.ok(existsSync(at("piece/models/late/crate_0.obj")), "its file stays");
  assert.equal(lib.find(at("piece/models/late/crate.glb"))?.kind, "model");
  // A part changing again doesn't bring it back.
  put("piece/models/late/crate_0.obj", tri + "\n");
  await lib.onDiskChange(at("piece/models/late/crate_0.obj"));
  assert.equal(lib.find(at("piece/models/late/crate_0.obj")), undefined);
});

test("a picked model not in the library yet comes in", async () => {
  const p = put("elsewhere/rock.glb", glb({ salt: 5 }));
  const d = await lib.pick({ text: `Picked 1 of 2: rock (${p})` });
  assert.equal(d.kind, "model");
  assert.ok(d.tags.includes(STARRED));
});

test("a textured model and its untextured twin stack, textured in front; stacks open, reorder and break up", async () => {
  // The scan stacked the brick's pair; a rename keeps it.
  const brick = lib.find(at("piece/models/trellis/brick-px-textured.glb"))!;
  assert.deepEqual(brick.stack?.ids, [brick.id, lib.find(at("piece/models/trellis/brick-pixal.glb"))!.id]);

  // Either twin may come first: the pair stacks with the textured one in front.
  put("piece/models/stack/cup.glb", glb({ salt: 6 }));
  put("piece/models/stack/cup-textured.glb", glb({ salt: 7 }));
  await lib.addPaths([at("piece/models/stack/cup.glb")]);
  assert.equal(lib.find(at("piece/models/stack/cup.glb"))!.stack, null, "alone until its twin comes");
  await lib.addPaths([at("piece/models/stack/cup-textured.glb")]);
  const tex = lib.find(at("piece/models/stack/cup-textured.glb"))!;
  const plain = lib.find(at("piece/models/stack/cup.glb"))!;
  assert.deepEqual(tex.stack?.ids, [tex.id, plain.id]);
  assert.equal(tex.stack?.front, true);
  assert.equal(plain.stack?.front, false);
  assert.deepEqual((await lib.image(plain.id)).stacked.map((m) => m.name), ["cup-textured.glb", "cup.glb"]);

  // Collapsed, the stack is its front; a search the front doesn't match shows the member that does.
  const names = (q: Parameters<typeof lib.search>[0] = {}) => lib.search({ kind: "model", sort: "name", limit: 50, ...q }).items.map((m) => m.name);
  assert.ok(names().includes("cup-textured.glb") && !names().includes("cup.glb"));
  assert.deepEqual(names({ text: "cup -textured" }), ["cup.glb"]);
  // Open, its members sit side by side in stack order, whatever the sort says.
  const open = names({ openStacks: [tex.stack!.id] });
  assert.deepEqual(open.slice(open.indexOf("cup-textured.glb"), open.indexOf("cup-textured.glb") + 2), ["cup-textured.glb", "cup.glb"]);
  assert.equal(lib.search({ ids: [tex.id, plain.id] }).total, 2, "asking by ids shows every member");

  // A new front, a third member, and out again.
  assert.deepEqual(lib.setStackFront(plain.id).map((m) => m.id), [plain.id, tex.id]);
  const heap = lib.find(at("piece/models/kept/heap.glb"))!;
  assert.deepEqual(lib.stackImages([heap.id, tex.id]).map((m) => m.id), [plain.id, heap.id, tex.id], "joining keeps the stack's front");
  assert.deepEqual(lib.unstackImages([heap.id]), { unstacked: 1 });
  assert.equal(lib.find(heap.id)!.stack, null);
  assert.throws(() => lib.stackImages([heap.id]), /two or more/);

  // A stack left with one member is no stack: by unstacking, or when a member leaves the library.
  lib.unstackImages([plain.id]);
  assert.equal(lib.find(tex.id)!.stack, null);
  assert.equal(lib.stackVariants(), 0, "taken out by hand, it stays apart");
  lib.stackImages([tex.id, plain.id]);
  lib.removeImages([plain.id]);
  assert.equal(lib.find(tex.id)!.stack, null);
  await lib.addPaths([at("piece/models/stack/cup.glb")]);
  assert.equal(lib.find(at("piece/models/stack/cup.glb"))!.stack?.front, false, "back in, it stacks behind its textured twin");
  lib.unstackImages([tex.id], true);
  assert.equal(lib.find(tex.id)!.stack, null);
  await lib.scanAll();
  assert.equal(lib.find(tex.id)!.stack, null, "a scan leaves a pair broken up by hand apart");

  assert.equal(lib.stackVariants(), 0);
  lib.stackImages([tex.id, lib.find(at("piece/models/stack/cup.glb"))!.id]);
  assert.equal(lib.find(tex.id)!.stack?.front, true, "stacked by hand, it pairs again");

  // Twins an older copy of the package let in (in no stack, never taken apart) stack on the next scan.
  lib.db.prepare("UPDATE images SET stack_id = NULL, stack_pos = 0 WHERE stack_id IS NOT NULL").run();
  await lib.scanAll();
  assert.equal(lib.find(tex.id)!.stack?.front, true);
});
