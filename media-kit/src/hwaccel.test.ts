import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { tempDir } from "./_fakes.test.js";
import { HW_ENCODERS, clearHwCache, parseHwCapabilities, probeHwCapabilities } from "./hwaccel.js";

const ENCODERS_HEADER = `Encoders:
 V..... = Video
 A..... = Audio
 ------
 V....D libx264              libx264 H.264 / AVC / MPEG-4 AVC / MPEG-4 part 10 (codec h264)
`;
const line = (id: string, desc = "x") => ` V....D ${id.padEnd(20)} ${desc}\n`;

test("NVIDIA build: nvenc encoder, cuvid decoder, cuda hwaccel, all four listed encoders", () => {
  const enc = ENCODERS_HEADER + line("h264_amf") + line("h264_nvenc", "NVIDIA NVENC H.264 encoder (codec h264)") + line("hevc_nvenc") + line("h264_qsv");
  const dec = " V..... h264_cuvid           Nvidia CUVID H264 decoder (codec h264)\n V....D h264_qsv  x\n";
  const caps = parseHwCapabilities(enc, dec);
  assert.equal(caps.encoder, "h264_nvenc");
  assert.equal(caps.decoder, "h264_cuvid");
  assert.equal(caps.hwaccel, "cuda");
  assert.deepEqual(
    caps.encoders.map((e) => e.id),
    ["h264_nvenc", "hevc_nvenc", "h264_qsv", "h264_amf"],
  );
});

test("Intel only: qsv everywhere", () => {
  const caps = parseHwCapabilities(ENCODERS_HEADER + line("h264_qsv"), line("h264_qsv"));
  assert.deepEqual([caps.encoder, caps.decoder, caps.hwaccel], ["h264_qsv", "h264_qsv", "qsv"]);
});

test("AMD only: amf with d3d11va decode", () => {
  const caps = parseHwCapabilities(ENCODERS_HEADER + line("h264_amf"), "");
  assert.deepEqual([caps.encoder, caps.decoder, caps.hwaccel], ["h264_amf", null, "d3d11va"]);
  assert.deepEqual(caps.encoders.map((e) => e.vendor), ["amd"]);
});

test("a CUVID decoder alone still means cuda", () => {
  const caps = parseHwCapabilities(ENCODERS_HEADER, line("h264_cuvid"));
  assert.deepEqual([caps.encoder, caps.decoder, caps.hwaccel], [null, "h264_cuvid", "cuda"]);
});

test("software build, and ids that only appear in descriptions or as prefixes, are not matches", () => {
  const enc = ENCODERS_HEADER + line("libx264", "mentions h264_nvenc in passing") + line("h264_nvenc_fake");
  const caps = parseHwCapabilities(enc, "");
  assert.deepEqual(caps, { encoder: null, decoder: null, hwaccel: null, encoders: [] });
  assert.deepEqual(parseHwCapabilities("", ""), { encoder: null, decoder: null, hwaccel: null, encoders: [] });
});

test("HW_ENCODERS is the list apps can drive", () => {
  assert.deepEqual(
    HW_ENCODERS.map((e) => e.id),
    ["h264_nvenc", "hevc_nvenc", "h264_qsv", "h264_amf"],
  );
});

test("probeHwCapabilities never throws: a missing ffmpeg reports software, and is cached", async () => {
  clearHwCache();
  const missing = path.join(tempDir(), "ffmpeg.exe");
  const caps = await probeHwCapabilities(missing);
  assert.deepEqual(caps, { encoder: null, decoder: null, hwaccel: null, encoders: [] });
  assert.equal(await probeHwCapabilities(missing), caps);
});
