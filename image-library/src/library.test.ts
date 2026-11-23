import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, before, test } from "node:test";
import { formatBytes, markdownImages, openLibrary, parseBytes, parsePick, PICKED, terms, type Library } from "./library.js";
import { markdownSrc, normPath } from "./paths.js";
import { sizeFromHeader } from "./imagesize.js";
import { parseSidecar } from "./sidecar.js";

/** Enough of a PNG for its size to be read: the signature and the IHDR chunk. */
function png(width: number, height: number, salt = 0) {
  const b = Buffer.alloc(64 + salt);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]).copy(b, 0);
  b.write("IHDR", 12, "ascii");
  b.writeUInt32BE(width, 16);
  b.writeUInt32BE(height, 20);
  return b;
}

let dir: string;
let lib: Library;
const at = (...p: string[]) => normPath(join(dir, ...p));

before(() => {
  dir = mkdtempSync(join(tmpdir(), "image-library-"));
  mkdirSync(join(dir, "concept", "r1"), { recursive: true });
  writeFileSync(join(dir, "concept", "r1", "bundle.png"), png(1024, 1024));
  writeFileSync(
    join(dir, "concept", "r1", "bundle.json"),
    JSON.stringify({ name: "bundle", prompt: "A banded bundle of banknotes", model: "gemini-3-pro-image-preview", size: "2K", usd: 0.134, at: "2026-11-18T19:00:00.000Z" }),
  );
  writeFileSync(join(dir, "concept", "sheet.png"), png(1250, 1442, 1));
  mkdirSync(join(dir, "odd dir (v2)"));
  writeFileSync(join(dir, "odd dir (v2)", "ufo #1.png"), png(800, 600, 2));
  lib = openLibrary(DatabaseSync, join(dir, "lib.db"));
});

after(() => {
  lib.close();
  rmSync(dir, { recursive: true, force: true });
});

test("headers and sidecars", () => {
  assert.deepEqual(sizeFromHeader(png(10, 20)), { width: 10, height: 20 });
  assert.equal(parseSidecar("[1]"), null);
  assert.equal(parseSidecar('{"other": 1}'), null);
  assert.equal(parseSidecar('{"prompt": "x", "usd": "free"}')?.usd, undefined);
  assert.deepEqual(parseSidecar('{"model": "m", "refs": ["a.png", {"path": "b.png"}, 3]}')?.refs, [{ path: "a.png" }, { path: "b.png" }]);
});

test("collections: tree, paths, unique names, no cycles", () => {
  const art = lib.ensureCollectionPath("toejam > Money Warehouse > Concept art");
  assert.equal(art.path, "toejam › Money Warehouse › Concept art");
  assert.equal(lib.resolveCollection("toejam/Money Warehouse/Concept art").id, art.id);
  assert.equal(lib.resolveCollection("Concept art").id, art.id);
  assert.equal(lib.resolveCollection(`#${art.id}`).id, art.id);
  assert.throws(() => lib.createCollection({ name: "concept ART", parentId: art.parentId }), /already a collection/);
  const top = lib.resolveCollection("toejam");
  assert.throws(() => lib.updateCollection(top.id, { parentId: art.id }), /inside itself/);
});

test("a watched folder brings images in, files them and reads sidecars", async () => {
  const art = lib.resolveCollection("Concept art");
  const w = lib.addWatch({ folder: join(dir, "concept"), collectionId: art.id });
  const r = await lib.scanWatch(w.id);
  assert.deepEqual({ seen: r.seen, added: r.added, missing: r.missing }, { seen: 2, added: 2, missing: 0 });
  const bundle = await lib.image(at("concept", "r1", "bundle.png"));
  assert.equal(bundle.width, 1024);
  assert.equal(bundle.model, "gemini-3-pro-image-preview");
  assert.equal(bundle.usd, 0.134);
  assert.equal(bundle.created, "2026-11-18T19:00:00.000Z");
  assert.deepEqual(bundle.collections.map((c) => c.path), [art.path]);
  assert.equal(lib.watchFor(at("concept", "r1", "new.png"))?.id, w.id);
  assert.equal((await lib.scanWatch(w.id)).updated, 0, "a second scan changes nothing");
});

test("search: words, fields, negation, collections, dates", () => {
  assert.equal(lib.search({ text: "banknotes" }).total, 1);
  assert.equal(lib.search({ text: "model:gemini" }).total, 1);
  assert.equal(lib.search({ text: "-banknotes" }).total, 1);
  assert.equal(lib.search({ text: 'in:"Concept art"' }).total, 2);
  assert.equal(lib.search({ text: "in:nowhere" }).total, 0);
  assert.equal(lib.search({ collectionId: lib.resolveCollection("toejam").id }).total, 2);
  assert.equal(lib.search({ collectionId: lib.resolveCollection("toejam").id, includeSub: false }).total, 0);
  assert.deepEqual(lib.search({ to: "2026-11-18T19:00:00.000Z" }).items.map((r) => r.name), ["bundle.png"]);
  assert.equal(lib.search({ from: "2026-11-18" }).total, 2, "a bare date covers the whole day");
  assert.equal(lib.search({ text: "100%_" }).total, 0, "LIKE wildcards are literal");
  // The PNGs are 64, 65 and 66 bytes: bundle, sheet, and (later) the ufo.
  assert.equal(lib.search({}).bytes, 64 + 65, "the size on disk of everything that matches");
  assert.deepEqual(lib.search({ sort: "smallest" }).items.map((r) => r.name), ["bundle.png", "sheet.png"]);
  assert.deepEqual(lib.search({ sort: "size" }).items.map((r) => r.name), ["sheet.png", "bundle.png"]);
  assert.deepEqual(lib.search({ text: "size:>64b" }).items.map((r) => r.name), ["sheet.png"]);
  assert.deepEqual(lib.search({ text: "-size:>64b" }).items.map((r) => r.name), ["bundle.png"]);
  assert.equal(lib.search({ text: "size:1mb" }).total, 0, "a bare size is at least that");
  assert.deepEqual(lib.search({ maxBytes: 64 }).items.map((r) => r.name), ["bundle.png"]);
  assert.equal(lib.search({ minBytes: 65, maxBytes: 65 }).bytes, 65);
  assert.equal(parseBytes("1.5 GB"), 1.5 * 1024 ** 3);
  assert.equal(parseBytes("200k"), 200 * 1024);
  assert.equal(parseBytes("3"), 3 * 1024 ** 2, "a bare number is megabytes");
  assert.equal(parseBytes("lots"), undefined);
  assert.equal(formatBytes(5.46 * 1024 ** 3), "5.46 GB");
  assert.equal(formatBytes(24.5 * 1024 ** 2), "24.5 MB");
  assert.equal(formatBytes(512 * 1024), "512 KB");
  assert.equal(formatBytes(0), "0 B");
  assert.deepEqual(terms('-tag:a "b c" model:pro'), [
    { neg: true, field: "tag", value: "a" },
    { neg: false, field: undefined, value: "b c" },
    { neg: false, field: "model", value: "pro" },
  ]);
});

test("the page's filters: kinds, any of some tags, models, the sort reversed, and facets", () => {
  const [bundle, sheet] = ["bundle.png", "sheet.png"].map((n) => lib.search({ text: n }).items[0].id);
  lib.tagImages([bundle], ["hero", "starred"]);
  lib.tagImages([sheet], ["draft"]);
  assert.equal(lib.search({ kinds: ["image", "video"] }).total, 2);
  assert.equal(lib.search({ kinds: ["model"] }).total, 0);
  assert.equal(lib.search({ kinds: [] }).total, 2, "no kinds is every kind");
  assert.equal(lib.search({ anyTags: ["hero", "draft"] }).total, 2);
  assert.equal(lib.search({ anyTags: ["HERO"] }).total, 1, "tags match whatever their case");
  assert.equal(lib.search({ tags: ["hero", "draft"] }).total, 0, "tags needs every one");
  assert.equal(lib.search({ models: ["gemini-3-pro-image-preview"] }).total, 1);
  assert.equal(lib.search({ models: ["gemini"] }).total, 0, "models are whole names");
  assert.deepEqual(lib.search({ sort: "size", reverse: true }).items.map((r) => r.name), ["bundle.png", "sheet.png"]);
  assert.deepEqual(lib.search({ sort: "name", reverse: true }).items.map((r) => r.name), ["sheet.png", "bundle.png"]);

  const f = lib.facets({ kinds: ["video"], tags: ["starred"], anyTags: ["draft"] });
  assert.deepEqual(f.kinds, { image: 0, model: 0, video: 0 }, "kinds counted without the kinds filter, the rest on: nothing starred and tagged draft");
  assert.deepEqual(lib.facets({ tags: ["starred"] }).kinds, { image: 1, model: 0, video: 0 });
  assert.deepEqual(
    lib.facets({}).tags.map((t) => [t.name, t.count]),
    [["draft", 1], ["hero", 1], ["starred", 1]],
  );
  assert.deepEqual(lib.facets({ anyTags: ["draft"] }).tags.length, 3, "the tag counts leave the tag filter off");
  assert.deepEqual(lib.facets({}).models, [{ name: "gemini-3-pro-image-preview", count: 1 }]);
  assert.deepEqual(lib.facets({ anyTags: ["draft"] }).starred, { on: 0, all: 1 });
  assert.deepEqual(lib.facets({ tags: ["starred"] }).starred, { on: 1, all: 2 }, "Starred's own count leaves it off");
  assert.deepEqual(lib.facets({ stacks: "expand", ids: [bundle, sheet] }).models.length, 1, "a search that isn't collapsed counts too");
  lib.tagImages([bundle], [], ["hero", "starred"]);
  lib.tagImages([sheet], [], ["draft"]);
});

test("carousel lines and picks round-trip, odd paths included", async () => {
  const add = await lib.addPaths([join(dir, "odd dir (v2)")], { tags: ["ufo"] });
  assert.equal(add.added.length, 1);
  const ufo = lib.find(add.added[0])!;
  const line = markdownImages([ufo]);
  assert.match(line, /^!\[#\d+ ufo #1\]\(file:\/\/\/.*odd%20dir%20%28v2%29\/ufo%20%231\.png\)$/);
  assert.equal(normPath(markdownSrc(ufo.path)), ufo.path);
  const src = /\((.*)\)$/.exec(line)![1];
  const text = `Picked 2 of 3: #${ufo.id} ufo #1 (${src})`;
  assert.deepEqual(parsePick(text), { at: 2, of: 3, alt: `#${ufo.id} ufo #1`, ref: src, id: ufo.id });
  const d = await lib.pick({ text });
  assert.deepEqual(d.tags, [PICKED, "ufo"]);
  assert.equal(lib.search({ tags: [PICKED] }).total, 1);
  await lib.pick({ id: ufo.id, unpick: true });
  assert.equal(lib.search({ tags: [PICKED] }).total, 0);
  assert.equal(lib.listTags().some((t) => t.name === PICKED), true, "picked stays as a tag");
});

test("moving and renaming files keep the sidecar and the collections", async () => {
  const id = lib.find(at("concept", "r1", "bundle.png"))!.id;
  const mv = await lib.moveFiles([id], join(dir, "out"));
  assert.equal(mv.moved[0].to, at("out", "bundle.png"));
  assert.ok(existsSync(join(dir, "out", "bundle.json")));
  const rn = await lib.renameImage(id, "bundle final");
  assert.equal(rn.path, at("out", "bundle final.png"));
  assert.ok(existsSync(join(dir, "out", "bundle final.json")));
  assert.equal((await lib.image(id)).sidecar?.prompt, "A banded bundle of banknotes");
  await assert.rejects(lib.renameImage(id, "a/b"), /can't be a file name/);
  writeFileSync(join(dir, "out", "taken.png"), png(2, 2));
  await assert.rejects(lib.renameImage(id, "taken"), /already exists/);
  assert.equal((await lib.image(id)).collections.length, 1);
});

test("filing: add, move, remove", async () => {
  const ufo = lib.search({ text: "ufo" }).items[0];
  const art = lib.resolveCollection("Concept art");
  const picks = lib.ensureCollectionPath("toejam > Picks");
  lib.fileImages([ufo.id], art.id, "add");
  lib.fileImages([ufo.id], picks.id, "add");
  assert.equal((await lib.image(ufo.id)).collections.length, 2);
  lib.fileImages([ufo.id], picks.id, "move");
  assert.deepEqual((await lib.image(ufo.id)).collections.map((c) => c.id), [picks.id]);
  lib.fileImages([ufo.id], picks.id, "remove");
  assert.equal((await lib.image(ufo.id)).collections.length, 0);
  assert.equal(lib.search({ unfiled: true }).total, 1);
  assert.equal(lib.deleteCollection(lib.resolveCollection("toejam").id).removed, 4);
  assert.equal(lib.listCollections().length, 0);
});

test("a file renamed outside the library keeps its row; a gone one is marked missing", async () => {
  const sheet = lib.find(at("concept", "sheet.png"))!;
  lib.tagImages([sheet.id], ["keep"]);
  renameSync(join(dir, "concept", "sheet.png"), join(dir, "concept", "sheet-2.png"));
  assert.equal(await lib.onDiskChange(join(dir, "concept", "sheet-2.png")), true);
  const moved = lib.find(sheet.id)!;
  assert.equal(moved.path, at("concept", "sheet-2.png"));
  assert.deepEqual(moved.tags, ["keep"]);
  rmSync(join(dir, "concept", "sheet-2.png"));
  assert.equal(await lib.onDiskChange(join(dir, "concept", "sheet-2.png")), true);
  assert.equal(lib.find(sheet.id)!.missing, true);
  assert.equal(lib.search({}).items.some((r) => r.id === sheet.id), false);
  assert.equal(lib.purgeMissing().removed, 1);
});

test("tags: rename merges, delete; view requests; once", () => {
  const ids = lib.search({}).items.map((r) => r.id);
  lib.tagImages(ids, ["money"]);
  lib.tagImages(ids, ["cash"]);
  assert.deepEqual(lib.renameTag("money", "cash"), { merged: true });
  assert.equal(lib.listTags().find((t) => t.name === "cash")?.count, ids.length);
  lib.deleteTag("cash");
  assert.equal(lib.listTags().some((t) => t.name === "cash"), false);
  lib.requestView({ text: "ufo" });
  assert.equal(lib.takeViewRequest()?.text, "ufo");
  assert.equal(lib.takeViewRequest(), undefined);
  let n = 0;
  assert.equal(lib.once("seed", () => n++), true);
  assert.equal(lib.once("seed", () => n++), false);
  assert.equal(n, 1);
});
