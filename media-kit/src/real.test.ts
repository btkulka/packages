// Against the real ffmpeg, ffprobe and yt-dlp on this machine. Skipped unless
// MEDIA_KIT_REAL=1. No network: media is generated with lavfi, and yt-dlp reads a
// local file:// URL.
//   PowerShell: $env:MEDIA_KIT_REAL = "1"; npm test

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { tempDir } from "./_fakes.test.js";
import {
  MediaRunError,
  audioConvertArgs,
  clearMediaCache,
  convertAudio,
  getFfmpegVersion,
  getYtDlpVersion,
  measureLoudness,
  measureVolume,
  mediaDuration,
  parseVolumedetect,
  probeHwCapabilities,
  probeMedia,
  resolveFfmpeg,
  resolveFfprobe,
  resolveYtDlp,
  runMedia,
  runMediaSync,
  videoInfo,
  volumedetectArgs,
  ytDlpDownload,
  ytDlpJson,
  type FfmpegProgress,
  type YtDlpProgress,
} from "./index.js";

const skip = process.env.MEDIA_KIT_REAL !== "1" ? "set MEDIA_KIT_REAL=1 to run against real binaries" : false;

function tools() {
  clearMediaCache();
  const ffmpeg = resolveFfmpeg({ preferGpu: true });
  assert.ok(ffmpeg, "no ffmpeg found");
  const ffprobe = resolveFfprobe({ ffmpegPath: ffmpeg });
  assert.ok(ffprobe, "no ffprobe found");
  return { ffmpeg, ffprobe };
}

async function tone(ffmpeg: string, dir: string, seconds = 3): Promise<string> {
  const wav = path.join(dir, "tone in a folder & name.wav");
  await runMedia(ffmpeg, ["-y", "-hide_banner", "-f", "lavfi", "-i", `sine=frequency=440:duration=${seconds}`, "-ar", "44100", wav]);
  return wav;
}

test("resolves real binaries and reads versions and hardware support", { skip }, async () => {
  const { ffmpeg, ffprobe } = tools();
  assert.match((await getFfmpegVersion(ffmpeg)) ?? "", /^ffmpeg version /);
  assert.match((await getFfmpegVersion(ffprobe)) ?? "", /^ffprobe version /);
  const caps = await probeHwCapabilities(ffmpeg);
  console.log(`ffmpeg ${ffmpeg}\nffprobe ${ffprobe}\nhw ${JSON.stringify(caps)}`);
});

test("convertAudio wav -> mp3 with progress to 100, then probe and measure it", { skip }, async () => {
  const { ffmpeg, ffprobe } = tools();
  const dir = tempDir();
  const wav = await tone(ffmpeg, dir, 3);
  const mp3 = path.join(dir, "out.mp3");
  const seen: FfmpegProgress[] = [];
  await convertAudio(ffmpeg, wav, mp3, { bitrateKbps: 128, channels: 1, metadata: { title: "Tone" }, onProgress: (p) => seen.push(p) });
  assert.ok(fs.statSync(mp3).size > 1000);
  assert.equal(seen.at(-1)?.percent, 100);

  const probe = await probeMedia(ffprobe, mp3);
  const d = mediaDuration(probe)!;
  assert.ok(Math.abs(d - 3) < 0.2, `duration ${d}`);
  assert.equal(probe.format.tags?.title, "Tone");

  const loud = await measureLoudness(ffmpeg, wav);
  assert.ok(Number.isFinite(loud.inputI));
  const vol = await measureVolume(ffmpeg, wav);
  assert.ok(vol.maxDb !== null && vol.maxDb <= 0);
  const sync = parseVolumedetect(runMediaSync(ffmpeg, volumedetectArgs(wav)).stderr);
  assert.equal(sync.maxDb, vol.maxDb);
});

test("aiff at 24-bit and a wav via the sync runner", { skip }, async () => {
  const { ffmpeg, ffprobe } = tools();
  const dir = tempDir();
  const wav = await tone(ffmpeg, dir, 1);
  const aiff = path.join(dir, "out.aiff");
  await convertAudio(ffmpeg, wav, aiff, { bitDepth: 24, metadata: { artist: "Ben" } });
  const a = await probeMedia(ffprobe, aiff);
  assert.equal(a.streams[0].codec_name, "pcm_s24be");
  const mono = path.join(dir, "mono.wav");
  runMediaSync(ffmpeg, audioConvertArgs(aiff, mono, { channels: 1, sampleRate: 24000, quiet: true }));
  const m = await probeMedia(ffprobe, mono);
  assert.equal(m.streams[0].channels, 1);
  assert.equal(m.streams[0].sample_rate, "24000");
});

test("video probe: size and frame rate", { skip }, async () => {
  const { ffmpeg, ffprobe } = tools();
  const dir = tempDir();
  const mp4 = path.join(dir, "v.mp4");
  await runMedia(ffmpeg, ["-y", "-f", "lavfi", "-i", "testsrc=size=320x240:rate=30000/1001:duration=2", "-pix_fmt", "yuv420p", mp4]);
  const info = videoInfo(await probeMedia(ffprobe, mp4));
  assert.equal(info.width, 320);
  assert.equal(info.height, 240);
  assert.equal(info.fps, 29.97);
  assert.ok(info.durationMs! > 1800 && info.durationMs! < 2200);
});

test("abort a long encode: rejects aborted, and the output is deletable at once", { skip }, async () => {
  const { ffmpeg } = tools();
  const dir = tempDir();
  const out = path.join(dir, "long.mp3");
  const ac = new AbortController();
  const p = runMedia(ffmpeg, ["-y", "-f", "lavfi", "-i", "sine=duration=3600", "-codec:a", "libmp3lame", out], {
    signal: ac.signal,
    onProgress: (pr) => {
      if (pr.timeSec > 1) ac.abort();
    },
  });
  await assert.rejects(p, (e: unknown) => e instanceof MediaRunError && e.reason === "aborted");
  fs.rmSync(out, { force: true });
  assert.equal(fs.existsSync(out), false);
});

test("an unreadable input rejects with ffmpeg's reason", { skip }, async () => {
  const { ffmpeg, ffprobe } = tools();
  const dir = tempDir();
  const junk = path.join(dir, "junk.mp3");
  fs.writeFileSync(junk, "not audio at all");
  await assert.rejects(convertAudio(ffmpeg, junk, path.join(dir, "o.wav")), (e: unknown) => e instanceof MediaRunError && e.reason === "exit" && e.stderr.length > 0);
  await assert.rejects(probeMedia(ffprobe, junk), MediaRunError);
});

test("yt-dlp: version, JSON and a download from a local file:// URL", { skip }, async () => {
  clearMediaCache();
  const ytdlp = resolveYtDlp();
  assert.ok(ytdlp, "no yt-dlp found");
  const { ffmpeg } = tools();
  const v = await getYtDlpVersion(ytdlp);
  assert.ok(v.releasedAt, `version ${v.version}`);

  const dir = tempDir();
  const src = path.join(dir, "source clip.mp4");
  await runMedia(ffmpeg, ["-y", "-f", "lavfi", "-i", "testsrc=size=160x120:duration=1", "-f", "lavfi", "-i", "sine=duration=1", "-shortest", "-pix_fmt", "yuv420p", src]);
  const url = pathToFileURL(src).href;

  const [info] = await ytDlpJson(ytdlp, ["--enable-file-urls", "--no-warnings", url], { timeoutMs: 60_000 });
  assert.ok(info && typeof info === "object");

  const outDir = path.join(dir, "out");
  fs.mkdirSync(outDir);
  const progress: YtDlpProgress[] = [];
  const file = await ytDlpDownload(ytdlp, {
    url,
    output: path.join(outDir, "downloaded.%(ext)s"),
    args: ["--enable-file-urls"],
    ffmpegPath: ffmpeg,
    timeoutMs: 60_000,
    onProgress: (p) => progress.push(p),
  });
  assert.ok(fs.existsSync(file), file);
  assert.equal(path.dirname(file), outDir);

  await assert.rejects(
    ytDlpJson(ytdlp, ["--enable-file-urls", pathToFileURL(path.join(dir, "missing.mp4")).href], { timeoutMs: 60_000 }),
    (e: unknown) => e instanceof MediaRunError && e.stderr.length > 0,
  );
});
