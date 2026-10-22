import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { tempDir } from "./_fakes.test.js";
import { MediaRunError } from "./run.js";
import {
  mediaDuration,
  parseFrameRate,
  parseProbeOutput,
  pickFrameRate,
  probeArgs,
  probeMedia,
  videoInfo,
  type ProbeResult,
} from "./probe.js";

const VIDEO_JSON = JSON.stringify({
  streams: [
    { index: 0, codec_type: "video", codec_name: "h264", width: 1920, height: 1080, avg_frame_rate: "30000/1001", r_frame_rate: "60000/1001" },
    { index: 1, codec_type: "audio", codec_name: "aac", sample_rate: "48000", channels: 2 },
  ],
  format: { filename: "a.mp4", format_name: "mov,mp4,m4a,3gp,3g2,mj2", duration: "12.345678" },
});

test("probeArgs asks for format and streams as JSON", () => {
  assert.deepEqual(probeArgs("C:\\a b.mp4"), ["-v", "error", "-print_format", "json", "-show_format", "-show_streams", "C:\\a b.mp4"]);
});

test("parseProbeOutput accepts a Buffer and fills in missing sections", () => {
  const p = parseProbeOutput(Buffer.from(VIDEO_JSON));
  assert.equal(p.streams.length, 2);
  assert.equal(p.format.format_name, "mov,mp4,m4a,3gp,3g2,mj2");
  assert.deepEqual(parseProbeOutput("{}"), { format: {}, streams: [] });
  assert.throws(() => parseProbeOutput("not json"), SyntaxError);
});

test("videoInfo: size, avg_frame_rate preferred, duration floored to ms", () => {
  assert.deepEqual(videoInfo(parseProbeOutput(VIDEO_JSON)), { durationMs: 12345, width: 1920, height: 1080, fps: 29.97 });
});

test("videoInfo skips cover art in an audio file", () => {
  const mp3: ProbeResult = {
    format: { duration: "180.5" },
    streams: [
      { index: 0, codec_type: "audio", codec_name: "mp3" },
      { index: 1, codec_type: "video", codec_name: "mjpeg", width: 600, height: 600, avg_frame_rate: "0/0", r_frame_rate: "90000/1", disposition: { attached_pic: 1 } },
    ],
  };
  assert.deepEqual(videoInfo(mp3), { durationMs: 180500, width: null, height: null, fps: null });
});

test("mediaDuration: container, else the longest stream, else a Matroska DURATION tag", () => {
  assert.equal(mediaDuration({ format: { duration: "2.5" }, streams: [] }), 2.5);
  assert.equal(
    mediaDuration({ format: { duration: "N/A" }, streams: [{ index: 0, duration: "1.0" }, { index: 1, duration: "3.25" }] }),
    3.25,
  );
  assert.equal(
    mediaDuration({ format: {}, streams: [{ index: 0, tags: { DURATION: "00:01:23.456000000" } }] }),
    83.456,
  );
  assert.equal(mediaDuration({ format: {}, streams: [{ index: 0 }] }), null);
});

test("parseFrameRate: rational rates, NTSC rounding, junk rejected", () => {
  assert.equal(parseFrameRate("60/1"), 60);
  assert.equal(parseFrameRate("30000/1001"), 29.97);
  assert.equal(parseFrameRate("24000/1001"), 23.976);
  assert.equal(parseFrameRate("239/1"), 239);
  for (const bad of ["0/0", "30/0", "0/1", "-60/1", "60/-1", "240/1", "1000/1", "30", "", "N/A", null, undefined, 60, {}]) {
    assert.equal(parseFrameRate(bad), null, `parseFrameRate(${JSON.stringify(bad)})`);
  }
});

test("pickFrameRate prefers avg_frame_rate and falls back to r_frame_rate", () => {
  assert.equal(pickFrameRate("30000/1001", "30/1"), 29.97);
  assert.equal(pickFrameRate("0/0", "60/1"), 60);
  assert.equal(pickFrameRate(undefined, "24/1"), 24);
  assert.equal(pickFrameRate("0/0", "N/A"), null);
});

test("probeMedia rejects with MediaRunError when ffprobe is missing", async () => {
  await assert.rejects(probeMedia(path.join(tempDir(), "ffprobe.exe"), "x.mp4"), (e: unknown) => e instanceof MediaRunError && e.reason === "spawn");
});
