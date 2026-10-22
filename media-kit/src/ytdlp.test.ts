import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { tempDir } from "./_fakes.test.js";
import {
  classifyYtDlpError,
  getYtDlpVersion,
  parseJsonLines,
  parseYtDlpProgress,
  parseYtDlpVersion,
  readPrintedPath,
  ytDlpDownloadArgs,
  ytDlpStaleness,
} from "./ytdlp.js";

test("parseYtDlpProgress: plain and ~estimated totals, binary and decimal units", () => {
  assert.deepEqual(parseYtDlpProgress("[download]  50.0% of 10.00MiB at 1.00MiB/s ETA 00:05"), {
    percent: 50,
    downloadedBytes: 5 * 1024 * 1024,
    totalBytes: 10 * 1024 * 1024,
  });
  assert.equal(parseYtDlpProgress("[download]  12.5% of ~  2.00GiB at 3MiB/s")?.totalBytes, 2 * 1024 ** 3);
  assert.equal(parseYtDlpProgress("[download]   1.0% of ~2.00KiB")?.totalBytes, 2048);
  assert.equal(parseYtDlpProgress("[download] 100.0% of 1.50MB in 00:00:02")?.totalBytes, 1_500_000);
  assert.equal(parseYtDlpProgress("[download] 100% of 7.00B")?.downloadedBytes, 7);
});

test("parseYtDlpProgress: anything that isn't a progress reading is null", () => {
  for (const line of [
    "[download] Destination: C:\\x\\a.mp4",
    "[download] 12.30MiB at 1.20MiB/s (00:00:05)",
    "[youtube] abc: Downloading webpage",
    "",
  ]) {
    assert.equal(parseYtDlpProgress(line), null, line);
  }
});

test("classifyYtDlpError separates extractor breaks from unavailable videos", () => {
  assert.equal(classifyYtDlpError("ERROR: [youtube] x: Unable to extract player response"), "extractor");
  assert.equal(classifyYtDlpError("ERROR: Unsupported URL: https://example.com"), "extractor");
  assert.equal(classifyYtDlpError("ERROR: [youtube] x: Video unavailable"), "unavailable");
  assert.equal(classifyYtDlpError("ERROR: [youtube] x: Private video"), "unavailable");
  assert.equal(classifyYtDlpError("ERROR: Sign in to confirm your age"), "auth");
  assert.equal(classifyYtDlpError("OSError: [Errno 28] No space left on device"), "disk");
  assert.equal(classifyYtDlpError("ERROR: HTTP Error 503: Service Unavailable"), "network");
  assert.equal(classifyYtDlpError("ERROR: read timed out"), "network");
  assert.equal(classifyYtDlpError("something odd"), "unknown");
});

test("parseYtDlpVersion reads release and nightly strings", () => {
  assert.equal(parseYtDlpVersion("2026.05.31\n")?.toISOString(), "2026-05-31T00:00:00.000Z");
  assert.equal(parseYtDlpVersion("2026.08.18.122307")?.toISOString(), "2026-08-18T00:00:00.000Z");
  assert.equal(parseYtDlpVersion("not a version"), null);
  assert.equal(parseYtDlpVersion(""), null);
});

test("ytDlpStaleness thresholds: <30 fresh, <90 aging, else stale", () => {
  assert.equal(ytDlpStaleness(0), "fresh");
  assert.equal(ytDlpStaleness(29), "fresh");
  assert.equal(ytDlpStaleness(30), "aging");
  assert.equal(ytDlpStaleness(89), "aging");
  assert.equal(ytDlpStaleness(90), "stale");
  assert.equal(ytDlpStaleness(null), "unknown");
});

test("getYtDlpVersion never throws for a missing binary", async () => {
  const v = await getYtDlpVersion(path.join(tempDir(), "yt-dlp.exe"));
  assert.deepEqual(v, { version: null, releasedAt: null, ageDays: null, staleness: "unknown" });
});

test("parseJsonLines keeps JSON objects and skips warnings and broken lines", () => {
  const text = 'WARNING: something\n{"id":"a","title":"A"}\r\n{"id":"b"\n\n  {"id":"c"}  \nnull\n';
  assert.deepEqual(parseJsonLines(text), [{ id: "a", title: "A" }, { id: "c" }]);
});

test("ytDlpDownloadArgs: safe defaults, then caller args, then output and the path file", () => {
  const args = ytDlpDownloadArgs(
    {
      url: "https://youtu.be/x",
      output: "C:\\out\\%(title)s [%(id)s].%(ext)s",
      format: "bv*+ba/b",
      ffmpegPath: "C:\\ffmpeg\\bin\\ffmpeg.exe",
      args: ["-x", "--audio-format", "mp3"],
    },
    "C:\\tmp\\p.txt",
  );
  assert.deepEqual(args, [
    "--ignore-config", "--no-playlist", "--newline", "--progress", "--no-colors",
    "-f", "bv*+ba/b",
    "--ffmpeg-location", "C:\\ffmpeg\\bin\\ffmpeg.exe",
    "-x", "--audio-format", "mp3",
    "-o", "C:\\out\\%(title)s [%(id)s].%(ext)s",
    "--print-to-file", "after_move:filepath", "C:\\tmp\\p.txt",
    "https://youtu.be/x",
  ]);
  assert.ok(!ytDlpDownloadArgs({ url: "u", output: "o", ignoreConfig: false }, "p").includes("--ignore-config"));
});

test("readPrintedPath: last printed line, only if the file exists", () => {
  const dir = tempDir();
  const real = path.join(dir, "Ünïcode clip.mp4");
  fs.writeFileSync(real, "x");
  const pf = path.join(dir, "p.txt");
  fs.writeFileSync(pf, `${path.join(dir, "old.mp4")}\r\n${real}\r\n`);
  assert.equal(readPrintedPath(pf), real);
  fs.writeFileSync(pf, path.join(dir, "missing.mp4"));
  assert.equal(readPrintedPath(pf), null);
  assert.equal(readPrintedPath(path.join(dir, "never-written.txt")), null);
});
