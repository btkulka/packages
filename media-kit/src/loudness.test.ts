import { test } from "node:test";
import assert from "node:assert/strict";
import { loudnormArgs, parseLoudnorm, parseVolumedetect, volumedetectArgs } from "./loudness.js";

const loudnormStderr = (inputI: string) =>
  [
    "Input #0, mov,mp4,m4a, from 'clip.mp4':",
    "  Duration: 00:01:00.00, start: 0.000000, bitrate: 1200 kb/s",
    "[Parsed_loudnorm_0 @ 000001] ",
    "{",
    `\t"input_i" : "${inputI}",`,
    '\t"input_tp" : "-1.20",',
    '\t"input_lra" : "6.40",',
    '\t"input_thresh" : "-24.65",',
    '\t"output_i" : "-23.98",',
    '\t"output_tp" : "-2.00",',
    '\t"output_lra" : "5.10",',
    '\t"output_thresh" : "-34.20",',
    '\t"normalization_type" : "dynamic",',
    '\t"target_offset" : "-0.02"',
    "}",
    "size=N/A time=00:01:00.00 bitrate=N/A speed= 120x",
  ].join("\n");

test("parseLoudnorm finds the JSON block among log lines", () => {
  const r = parseLoudnorm(loudnormStderr("-14.30"));
  assert.equal(r.inputI, -14.3);
  assert.equal(r.inputTp, -1.2);
  assert.equal(r.inputLra, 6.4);
  assert.equal(r.inputThresh, -24.65);
  assert.equal(r.targetOffset, -0.02);
  assert.equal(parseLoudnorm(loudnormStderr("0.50")).inputI, 0.5);
});

test("parseLoudnorm rejects -inf and nan (silent or corrupt audio)", () => {
  assert.throws(() => parseLoudnorm(loudnormStderr("-inf")), /Invalid loudness/);
  assert.throws(() => parseLoudnorm(loudnormStderr("nan")), /Invalid loudness/);
});

test("parseLoudnorm needs the report, not just any JSON", () => {
  assert.throws(() => parseLoudnorm("ffmpeg: could not open file"), /Could not parse/);
  assert.throws(() => parseLoudnorm(""), /Could not parse/);
  assert.throws(() => parseLoudnorm('{"streams": [{"codec": "h264"}]}\nno loudnorm here'), /Could not parse/);
});

test("parseLoudnorm: a -inf true peak is null, not a number", () => {
  const r = parseLoudnorm(loudnormStderr("-30.00").replace('"-1.20"', '"-inf"'));
  assert.equal(r.inputI, -30);
  assert.equal(r.inputTp, null);
});

test("loudnormArgs: -t limits the analysed span, -vn skips decoding video", () => {
  assert.deepEqual(loudnormArgs("a.mp4", { maxDurationSec: 300 }), [
    "-hide_banner", "-nostats", "-i", "a.mp4", "-t", "300", "-vn", "-af", "loudnorm=print_format=json", "-f", "null", "-",
  ]);
  assert.ok(!loudnormArgs("a.wav").includes("-t"));
});

test("parseVolumedetect reads mean and max; -inf and missing are null", () => {
  const stderr = [
    "[Parsed_volumedetect_0 @ 0x1] n_samples: 88200",
    "[Parsed_volumedetect_0 @ 0x1] mean_volume: -20.5 dB",
    "[Parsed_volumedetect_0 @ 0x1] max_volume: -3.2 dB",
    "[Parsed_volumedetect_0 @ 0x1] histogram_3db: 5",
  ].join("\n");
  assert.deepEqual(parseVolumedetect(stderr), { meanDb: -20.5, maxDb: -3.2 });
  assert.deepEqual(parseVolumedetect("max_volume: 0.0 dB"), { meanDb: null, maxDb: 0 });
  assert.deepEqual(parseVolumedetect("mean_volume: -inf dB\nmax_volume: -inf dB"), { meanDb: null, maxDb: null });
  assert.deepEqual(parseVolumedetect(""), { meanDb: null, maxDb: null });
});

test("volumedetectArgs", () => {
  assert.deepEqual(volumedetectArgs("a.wav"), ["-hide_banner", "-nostats", "-i", "a.wav", "-vn", "-af", "volumedetect", "-f", "null", "-"]);
});
