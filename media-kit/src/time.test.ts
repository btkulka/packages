import { test } from "node:test";
import assert from "node:assert/strict";
import { formatFfmpegTime, parseFfmpegDuration, parseFfmpegTime } from "./time.js";

test("formatFfmpegTime pads every field", () => {
  assert.equal(formatFfmpegTime(0), "00:00:00.000");
  assert.equal(formatFfmpegTime(5), "00:00:05.000");
  assert.equal(formatFfmpegTime(5.25), "00:00:05.250");
  assert.equal(formatFfmpegTime(60), "00:01:00.000");
  assert.equal(formatFfmpegTime(3600), "01:00:00.000");
  assert.equal(formatFfmpegTime(3661.5), "01:01:01.500");
  assert.equal(formatFfmpegTime(45296.75), "12:34:56.750");
});

test("formatFfmpegTime keeps and rounds milliseconds", () => {
  assert.equal(formatFfmpegTime(1.001), "00:00:01.001");
  assert.equal(formatFfmpegTime(0.999), "00:00:00.999");
  assert.equal(formatFfmpegTime(1.0004), "00:00:01.000");
  assert.equal(formatFfmpegTime(1.0006), "00:00:01.001");
  assert.equal(formatFfmpegTime(2245.2876), "00:37:25.288");
});

test("formatFfmpegTime never prints 60 seconds (ffmpeg rejects SS > 59)", () => {
  assert.equal(formatFfmpegTime(59.9996), "00:01:00.000");
  assert.equal(formatFfmpegTime(3599.9999), "01:00:00.000");
  for (const s of [0, 0.5, 59.9, 59.9995, 60, 599.123, 3599.999, 7200]) {
    assert.match(formatFfmpegTime(s), /^\d{2}:[0-5]\d:[0-5]\d\.\d{3}$/);
  }
});

test("formatFfmpegTime clamps negative and non-finite input to zero", () => {
  assert.equal(formatFfmpegTime(-3), "00:00:00.000");
  assert.equal(formatFfmpegTime(Number.NaN), "00:00:00.000");
});

test("parseFfmpegTime reads clock, short clock and plain seconds", () => {
  assert.equal(parseFfmpegTime("01:02:03.5"), 3723.5);
  assert.equal(parseFfmpegTime("00:37:25.288"), 2245.288);
  assert.equal(parseFfmpegTime("02:03"), 123);
  assert.equal(parseFfmpegTime("12.25"), 12.25);
  assert.equal(parseFfmpegTime("00:01:23.456000000"), 83.456);
  assert.equal(parseFfmpegTime("-00:00:00.02"), -0.02);
  assert.equal(parseFfmpegTime("N/A"), null);
  assert.equal(parseFfmpegTime(""), null);
  assert.equal(parseFfmpegTime("abc"), null);
});

test("round trip through format and parse", () => {
  for (const s of [0, 1.5, 59.999, 61.25, 3725.125]) {
    assert.equal(parseFfmpegTime(formatFfmpegTime(s)), s);
  }
});

test("parseFfmpegDuration reads the first input's banner duration", () => {
  const banner = "Input #0, mp3, from 'a.mp3':\n  Duration: 00:03:25.43, start: 0.025057, bitrate: 320 kb/s\nInput #1\n  Duration: 00:00:01.00";
  assert.equal(parseFfmpegDuration(banner), 205.43);
  assert.equal(parseFfmpegDuration("  Duration: N/A, start: 0"), null);
  assert.equal(parseFfmpegDuration("nothing here"), null);
});
