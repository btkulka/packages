import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, before, test } from "node:test";
import { resolveFfmpeg, runMedia } from "@btkulka/media-kit";
import { openLibrary, STARRED, walk, type Library } from "./library.js";
import { normPath } from "./paths.js";
import { videoFacts, videoFrame } from "./video.js";

// Videos (with a real clip ffmpeg makes, when ffmpeg is here), view counts, and the star's old name.

const ffmpeg = resolveFfmpeg();
let dir: string;
let lib: Library;
const at = (...p: string[]) => normPath(join(dir, ...p));

before(async () => {
  dir = mkdtempSync(join(tmpdir(), "image-library-video-"));
  mkdirSync(join(dir, "renders"));
  if (ffmpeg) {
    // A second of colour bars with a tone, 320×240 at 24 fps.
    await runMedia(ffmpeg, ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "testsrc=size=320x240:rate=24:duration=1", "-f", "lavfi", "-i", "sine=frequency=440:duration=1", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", join(dir, "renders", "bars.mp4")]);
    writeFileSync(join(dir, "renders", "bars.json"), JSON.stringify({ prompt: "Colour bars, slow push in", model: "veo-3", usd: 0.4, at: "2026-11-19T12:00:00.000Z" }));
  }
  writeFileSync(join(dir, "renders", "still.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 0, 8, 0, 0, 0, 8, 8, 6, 0, 0, 0, 0, 0, 0, 0]));
  lib = openLibrary(DatabaseSync, join(dir, "lib.db"));
});

after(() => {
  lib.close();
  rmSync(dir, { recursive: true, force: true });
});

test("ffprobe's report in the library's words: an upright frame for a rotated phone clip, silence, no video", () => {
  const facts = videoFacts({
    format: { duration: "12.480000", bit_rate: "8100000", format_name: "mov,mp4,m4a,3gp,3g2,mj2" },
    streams: [
      { index: 0, codec_type: "video", codec_name: "hevc", width: 1920, height: 1080, avg_frame_rate: "30000/1001", side_data_list: [{ rotation: -90 }] },
      { index: 1, codec_type: "audio", codec_name: "aac" },
    ],
  });
  assert.deepEqual(facts, { duration: 12.48, width: 1080, height: 1920, fps: 29.97, codec: "hevc", audio: "aac", bitrate: 8100, container: "mov" });
  const silent = videoFacts({ format: { duration: "2" }, streams: [{ index: 0, codec_type: "video", codec_name: "vp9", width: 640, height: 360, avg_frame_rate: "0/0", r_frame_rate: "25/1" }] });
  assert.equal(silent.audio, null);
  assert.equal(silent.fps, 25);
  assert.match(videoFacts({ format: {}, streams: [{ index: 0, codec_type: "audio", codec_name: "mp3" }] }).error!, /No video/);
});

test("a video comes in as a video: its facts, its sidecar, search by kind, a frame for its thumbnail", { skip: !ffmpeg && "ffmpeg isn't installed" }, async () => {
  assert.deepEqual((await walk(at("renders"))).sort(), [at("renders", "bars.mp4"), at("renders", "still.png")]);
  const add = await lib.addPaths([at("renders")]);
  assert.equal(add.added.length, 2);
  const v = lib.find(at("renders", "bars.mp4"))!;
  assert.equal(v.kind, "video");
  assert.equal(v.width, 320);
  assert.equal(v.height, 240);
  assert.equal(v.video?.codec, "h264");
  assert.equal(v.video?.audio, "aac");
  assert.equal(v.video?.fps, 24);
  assert.ok(Math.abs((v.video?.duration ?? 0) - 1) < 0.1, `about a second long, not ${v.video?.duration}`);
  assert.equal(v.prompt, "Colour bars, slow push in");
  assert.equal(v.created, "2026-11-19T12:00:00.000Z");
  assert.equal(lib.info().videos, 1);
  assert.deepEqual(lib.search({ kind: "video" }).items.map((r) => r.id), [v.id]);
  assert.deepEqual(lib.search({ text: "is:video" }).items.map((r) => r.id), [v.id]);
  assert.equal(lib.search({ text: "-is:video" }).items.some((r) => r.id === v.id), false);
  assert.deepEqual(await lib.companions(v), [at("renders", "bars.json")]);
  assert.equal((await lib.image(v.id)).sidecar?.model, "veo-3");

  const out = join(dir, "thumbs", "bars.jpg");
  assert.equal(await videoFrame(v.path, out, 160, v.video?.duration), true);
  assert.ok(statSync(out).size > 500);
  // Asked for a frame past its end, it settles for the first.
  assert.equal(await videoFrame(v.path, join(dir, "thumbs", "late.jpg"), 160, 400), true);

  // Renamed, it keeps its extension; its sidecar follows.
  const r = await lib.renameImage(v.id, "bars-final");
  assert.equal(r.path, at("renders", "bars-final.mp4"));
  assert.ok(existsSync(join(dir, "renders", "bars-final.json")));
});

test("views count up and sort the most looked-at first", async () => {
  const all = lib.search({}).items;
  if (!all.length) await lib.addPaths([at("renders")]);
  const items = lib.search({ sort: "name" }).items;
  const last = items[items.length - 1];
  assert.equal(last.views, 0);
  assert.equal(last.viewedAt, null);
  assert.deepEqual(lib.markViewed([last.id, last.id]), [{ id: last.id, views: 1 }]);
  lib.markViewed([last.id]);
  const top = lib.search({ sort: "views" }).items[0];
  assert.equal(top.id, last.id);
  assert.equal(top.views, 2);
  assert.match(top.viewedAt!, /^\d{4}-\d\d-\d\dT/);
});

test("the star: is:starred finds it, and an old \"picked\" tag folds into it when the library opens", async () => {
  const still = lib.find(at("renders", "still.png")) ?? lib.find((await lib.addPaths([at("renders", "still.png")])).added[0])!;
  lib.tagImages([still.id], ["picked"]);
  assert.deepEqual(lib.search({ text: "is:starred" }).items.map((r) => r.id), []);
  lib.close();
  lib = openLibrary(DatabaseSync, join(dir, "lib.db"));
  assert.deepEqual(lib.find(still.id)!.tags, [STARRED]);
  assert.equal(lib.listTags().some((t) => t.name === "picked"), false);
  assert.deepEqual(lib.search({ text: "is:starred" }).items.map((r) => r.id), [still.id]);
  assert.deepEqual(lib.search({ text: "is:picked" }).items.map((r) => r.id), [still.id]);
});
