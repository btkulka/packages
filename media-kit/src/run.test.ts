import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { FAKE_SCRIPT, NODE, isAlive, tempDir } from "./_fakes.test.js";
import {
  MediaRunError,
  getFfmpegVersion,
  runMedia,
  runMediaSync,
  spawnMedia,
  summarizeFfmpegError,
  type FfmpegProgress,
} from "./run.js";

const fake = (...args: string[]) => [FAKE_SCRIPT, ...args];

async function rejection(p: Promise<unknown>): Promise<MediaRunError> {
  try {
    await p;
  } catch (err) {
    assert.ok(err instanceof MediaRunError, `expected MediaRunError, got ${err}`);
    return err;
  }
  assert.fail("expected a rejection");
}

test("runMedia collects stdout as a Buffer and stderr as text, even on success", async () => {
  const r = await runMedia(NODE, fake("both", "out-bytes", "the report"));
  assert.equal(r.code, 0);
  assert.ok(Buffer.isBuffer(r.stdout));
  assert.equal(r.stdout.toString(), "out-bytes");
  assert.equal(r.stderr, "the report");
});

test("arguments pass through untouched: spaces, quotes, ampersands", async () => {
  const tricky = `C:\\My Music\\a & b "c" 'd'.mp3`;
  const r = await runMedia(NODE, fake("stdout", tricky));
  assert.equal(r.stdout.toString(), tricky);
});

test("a non-zero exit rejects with the code, the stderr and a useful message", async () => {
  const stderr = "Input #0\n[aiff @ 0000021] could not find COMM tag or invalid block_align value\nError opening input files: Invalid data\n";
  const err = await rejection(runMedia(NODE, fake("stderr", stderr, "1")));
  assert.equal(err.reason, "exit");
  assert.equal(err.code, 1);
  assert.equal(err.stderr, stderr);
  assert.match(err.message, /^node exited with code 1: Error opening input files: Invalid data$/);
  assert.match(err.stderr, /could not find COMM tag/);
});

test("check: false resolves with the exit code instead", async () => {
  const r = await runMedia(NODE, fake("stderr", "bad", "3"), { check: false });
  assert.equal(r.code, 3);
  assert.equal(r.stderr, "bad");
});

test("a missing binary rejects with reason spawn", async () => {
  const err = await rejection(runMedia(path.join(tempDir(), "no-ffmpeg-here.exe"), ["-version"]));
  assert.equal(err.reason, "spawn");
  assert.equal(err.code, null);
});

test("progress from stderr: banner duration, \\r lines split across chunks, monotonic, 99 cap then 100", async () => {
  const seen: FfmpegProgress[] = [];
  await runMedia(NODE, fake("progress"), { onProgress: (p) => seen.push(p) });
  assert.deepEqual(
    seen.map((p) => p.percent),
    [10, 25, 50, 99, 100],
  );
  assert.ok(seen.every((p) => p.durationSec === 10));
  assert.equal(seen[0].timeSec, 1);
  assert.equal(seen.at(-1)!.timeSec, 10);
});

test("progress: an explicit durationSec wins over the banner", async () => {
  const seen: FfmpegProgress[] = [];
  await runMedia(NODE, fake("progress"), { durationSec: 20, onProgress: (p) => seen.push(p) });
  assert.deepEqual(
    seen.map((p) => p.percent),
    [5, 13, 25, 50, 100],
  );
});

test("progress: no final 100 when the run fails", async () => {
  const seen: FfmpegProgress[] = [];
  await rejection(runMedia(NODE, fake("progress", "1"), { onProgress: (p) => seen.push(p) }));
  assert.ok(seen.length > 0);
  assert.ok(seen.every((p) => p.percent !== 100));
});

test("progress from -progress pipe:1 key=value lines on stdout (out_time_ms is microseconds)", async () => {
  const seen: FfmpegProgress[] = [];
  await runMedia(NODE, [...fake("progress-pipe"), "-progress", "pipe:1"], { onProgress: (p) => seen.push(p) });
  assert.deepEqual(
    seen.map((p) => p.percent),
    [13, 25, 50, 99, 100],
  );
  assert.equal(seen[0].timeSec, 0.5);
});

test("progress without a known duration reports time with a null percent", async () => {
  const seen: FfmpegProgress[] = [];
  await runMedia(NODE, fake("no-duration"), { onProgress: (p) => seen.push(p) });
  assert.deepEqual(
    seen.map((p) => [p.timeSec, p.percent]),
    [
      [1, null],
      [3, null],
      [3, 100],
    ],
  );
});

test("onLine splits \\n, \\r\\n and bare \\r, flushing the last partial line", async () => {
  const lines: string[] = [];
  await runMedia(NODE, fake("lines"), { onLine: (l, s) => lines.push(`${s}:${l}`) });
  assert.deepEqual(lines.sort(), ["stderr:c", "stderr:d", "stdout:a", "stdout:b"]);
});

test("timeout kills the process and rejects with reason timeout after it exits", async () => {
  const started = Date.now();
  const err = await rejection(runMedia(NODE, fake("sleep", "60000"), { timeoutMs: 300 }));
  assert.equal(err.reason, "timeout");
  assert.match(err.message, /timed out after 300ms/);
  assert.ok(Date.now() - started < 10_000);
});

test("abort kills the process and rejects with reason aborted", async () => {
  const ac = new AbortController();
  const p = runMedia(NODE, fake("sleep", "60000"), { signal: ac.signal });
  setTimeout(() => ac.abort(), 200);
  const err = await rejection(p);
  assert.equal(err.reason, "aborted");
});

test("an already-aborted signal never starts the process", async () => {
  const ac = new AbortController();
  ac.abort();
  const err = await rejection(runMedia(NODE, fake("sleep", "60000"), { signal: ac.signal }));
  assert.equal(err.reason, "aborted");
});

test("MediaProcess.kill() stops the run", async () => {
  const proc = spawnMedia(NODE, fake("sleep", "60000"));
  setTimeout(() => proc.kill(), 200);
  const err = await rejection(proc.result);
  assert.equal(err.reason, "aborted");
});

test("kill takes the whole tree (Windows: a grandchild such as yt-dlp's ffmpeg)", async () => {
  let grandchild = 0;
  const proc = spawnMedia(NODE, fake("grandchild"), {
    onLine: (line, stream) => {
      if (stream === "stdout" && /^\d+$/.test(line)) {
        grandchild = Number(line);
        proc.kill();
      }
    },
  });
  await rejection(proc.result);
  assert.ok(grandchild > 0);
  if (process.platform === "win32") {
    for (let i = 0; i < 50 && isAlive(grandchild); i++) await new Promise((r) => setTimeout(r, 100));
    assert.equal(isAlive(grandchild), false, "grandchild survived the kill");
  } else {
    try { process.kill(grandchild); } catch { /* gone */ }
  }
});

test("stdout over maxBuffer kills the process with reason maxBuffer", async () => {
  const err = await rejection(runMedia(NODE, fake("big", String(4 * 1024 * 1024)), { maxBuffer: 1024 }));
  assert.equal(err.reason, "maxBuffer");
});

test("stdin: pipe streams bytes into the process", async () => {
  const proc = spawnMedia(NODE, fake("stdin-count"), { stdin: "pipe" });
  assert.ok(proc.stdin);
  proc.stdin.write(Buffer.alloc(1000));
  proc.stdin.write(Buffer.alloc(24));
  proc.stdin.end();
  const r = await proc.result;
  assert.equal(r.stdout.toString(), "1024");
});

test("writing to stdin after the process died does not crash (EPIPE is swallowed)", async () => {
  const proc = spawnMedia(NODE, fake("stderr", "boom", "1"), { stdin: "pipe" });
  await rejection(proc.result);
  proc.stdin!.write(Buffer.alloc(1024 * 1024));
  proc.stdin!.end();
  await new Promise((r) => setTimeout(r, 100));
});

test("runMediaSync returns stderr on success (where volumedetect writes)", () => {
  const r = runMediaSync(NODE, fake("both", "o", "max_volume: -3.2 dB"));
  assert.equal(r.code, 0);
  assert.equal(r.stdout.toString(), "o");
  assert.equal(r.stderr, "max_volume: -3.2 dB");
});

test("runMediaSync throws MediaRunError on exit, timeout and a missing binary", () => {
  assert.throws(
    () => runMediaSync(NODE, fake("stderr", "Conversion failed!", "1")),
    (e: unknown) => e instanceof MediaRunError && e.reason === "exit" && /Conversion failed!/.test(e.message),
  );
  assert.throws(
    () => runMediaSync(NODE, fake("sleep", "60000"), { timeoutMs: 300 }),
    (e: unknown) => e instanceof MediaRunError && e.reason === "timeout",
  );
  assert.throws(
    () => runMediaSync(path.join(tempDir(), "nope.exe"), []),
    (e: unknown) => e instanceof MediaRunError && e.reason === "spawn",
  );
  const r = runMediaSync(NODE, fake("stderr", "x", "4"), { check: false });
  assert.equal(r.code, 4);
});

test("summarizeFfmpegError picks the line that explains the failure", () => {
  assert.equal(
    summarizeFfmpegError("ffmpeg version 7\n  built with gcc\n[mp3 @ 0x55] Invalid data found when processing input\nsize=0kB\n"),
    "Invalid data found when processing input",
  );
  assert.equal(summarizeFfmpegError("a\nb\nlast line\n"), "last line");
  assert.equal(summarizeFfmpegError("ERROR: [youtube] abc: Video unavailable\n"), "ERROR: [youtube] abc: Video unavailable");
  assert.equal(summarizeFfmpegError(""), "");
  assert.ok(summarizeFfmpegError("x".repeat(1000)).length <= 300);
});

test("getFfmpegVersion is null for a missing binary", async () => {
  assert.equal(await getFfmpegVersion(path.join(tempDir(), "missing.exe")), null);
});

test("the process has exited (file unlocked) by the time an abort rejects", async () => {
  const dir = tempDir();
  const ac = new AbortController();
  const p = runMedia(NODE, fake("sleep", "60000"), { signal: ac.signal, cwd: dir });
  setTimeout(() => ac.abort(), 200);
  await rejection(p);
  fs.rmSync(dir, { recursive: true, force: true });
  assert.equal(fs.existsSync(dir), false);
});
