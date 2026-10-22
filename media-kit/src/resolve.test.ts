import { afterEach, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { exeName, tempDir, touchExe } from "./_fakes.test.js";
import { findExecutable } from "@btkulka/proc-kit";
import {
  clearMediaCache,
  ffprobePathFromFfmpeg,
  knownInstallDirs,
  pickGpuCandidate,
  resolveFfmpeg,
  resolveFfprobe,
  resolveYtDlp,
} from "./resolve.js";

const win = process.platform === "win32";
const ENV_KEYS = [
  "PATH",
  "Path",
  "PATHEXT",
  "LOCALAPPDATA",
  "ProgramFiles",
  "ProgramFiles(x86)",
  "ProgramData",
  "USERPROFILE",
  "SystemDrive",
  "FFMPEG_PATH",
  "FFPROBE_PATH",
  "YT_DLP_PATH",
  "FFMPEG",
];
let saved: Record<string, string | undefined> = {};
let root = "";

/** A sandbox: PATH and every known-dir root point into a temp dir, overrides unset. */
beforeEach(() => {
  saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  root = tempDir("media-kit-resolve-");
  for (const k of ENV_KEYS) delete process.env[k];
  process.env.PATH = path.join(root, "empty-path-dir");
  if (win) {
    process.env.PATHEXT = ".COM;.EXE;.BAT;.CMD";
    process.env.LOCALAPPDATA = path.join(root, "LocalAppData");
    process.env.ProgramFiles = path.join(root, "ProgramFiles");
    process.env.ProgramData = path.join(root, "ProgramData");
    process.env.USERPROFILE = path.join(root, "User");
    process.env.SystemDrive = path.join(root, "SysDrive");
  }
  clearMediaCache();
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  clearMediaCache();
  fs.rmSync(root, { recursive: true, force: true });
});

const at = (...parts: string[]) => path.join(root, ...parts);

test("findExecutable: PATH in order, then extraDirs; quoted PATH entries work", () => {
  const a = at("a");
  const b = at("b");
  touchExe(path.join(b, exeName("ffmpeg")));
  touchExe(path.join(at("extra"), exeName("ffmpeg")));
  process.env.PATH = [a, `"${b}"`].join(path.delimiter);
  assert.equal(findExecutable("ffmpeg"), path.join(b, exeName("ffmpeg")));
  process.env.PATH = a;
  assert.equal(findExecutable("ffmpeg", { extraDirs: [at("extra")] }), path.join(at("extra"), exeName("ffmpeg")));
  assert.equal(findExecutable("ffmpeg"), null);
});

test("findExecutable: a name with a directory part is checked as given", () => {
  const exe = touchExe(at("x", exeName("ffmpeg")));
  assert.equal(findExecutable(exe), exe);
  assert.equal(findExecutable(at("x", "nope")), null);
  if (win) assert.equal(findExecutable(at("x", "ffmpeg")), at("x", "ffmpeg.exe"));
});

test("findExecutable (Windows): PATHEXT order picks the .exe over a .cmd shim", { skip: !win }, () => {
  touchExe(at("shims", "ffmpeg.cmd"));
  touchExe(at("shims", "ffmpeg.exe"));
  process.env.PATH = at("shims");
  assert.equal(findExecutable("ffmpeg")?.toLowerCase(), at("shims", "ffmpeg.exe").toLowerCase());
  assert.equal(findExecutable("ffmpeg.exe")?.toLowerCase(), at("shims", "ffmpeg.exe").toLowerCase());
});

test("findExecutable ignores directories named like the tool", () => {
  fs.mkdirSync(at("d", exeName("ffmpeg")), { recursive: true });
  process.env.PATH = at("d");
  assert.equal(findExecutable("ffmpeg"), null);
});

test("order: env override, then bundled, then PATH, then extraDirs, then known dirs", () => {
  const onPath = touchExe(at("path", exeName("ffmpeg")));
  const bundled = touchExe(at("node_modules", "ffmpeg-static", exeName("ffmpeg")));
  const extra = touchExe(at("extra", exeName("ffmpeg")));
  const override = touchExe(at("override", exeName("ffmpeg")));
  process.env.PATH = at("path");

  process.env.FFMPEG_PATH = override;
  assert.equal(resolveFfmpeg({ bundled, extraDirs: [at("extra")] }), override);
  delete process.env.FFMPEG_PATH;
  clearMediaCache();
  assert.equal(resolveFfmpeg({ bundled, extraDirs: [at("extra")] }), bundled);
  assert.equal(resolveFfmpeg({ extraDirs: [at("extra")] }), onPath);
  process.env.PATH = at("empty");
  clearMediaCache();
  assert.equal(resolveFfmpeg({ extraDirs: [at("extra")] }), extra);
});

test("an env override that points nowhere gives null, not some other ffmpeg", () => {
  touchExe(at("path", exeName("ffmpeg")));
  process.env.PATH = at("path");
  process.env.FFMPEG = at("no-ffmpeg-here");
  assert.equal(resolveFfmpeg({ envVar: "FFMPEG" }), null);
  assert.equal(resolveFfmpeg({ envVar: null }), at("path", exeName("ffmpeg")));
});

test("env override may be a directory, a quoted path or a command name on PATH", () => {
  const exe = touchExe(at("bin", exeName("ffmpeg")));
  const renamed = touchExe(at("path", exeName("ffmpeg7")));
  process.env.PATH = at("path");
  process.env.FFMPEG_PATH = at("bin");
  assert.equal(resolveFfmpeg(), exe);
  process.env.FFMPEG_PATH = `"${exe}"`;
  assert.equal(resolveFfmpeg(), exe);
  process.env.FFMPEG_PATH = "ffmpeg7";
  assert.equal(resolveFfmpeg(), renamed);
});

test("bundled: a list is tried in order, missing and null entries skipped", () => {
  const second = touchExe(at("b2", exeName("yt-dlp")));
  assert.equal(resolveYtDlp({ bundled: [null, at("missing", exeName("yt-dlp")), undefined, second] }), second);
});

test("bundled: a path inside app.asar resolves to app.asar.unpacked", () => {
  const packed = at("resources", "app.asar", "node_modules", "ffmpeg-static", exeName("ffmpeg"));
  const unpacked = touchExe(at("resources", "app.asar.unpacked", "node_modules", "ffmpeg-static", exeName("ffmpeg")));
  assert.equal(resolveFfmpeg({ bundled: packed }), unpacked);
});

test("preferGpu: the system ffmpeg comes before the bundled one when neither is GPU-capable", () => {
  // Empty files can't run, so the probe reports software for both: system first wins,
  // which is clipdrift's old "PATH before ffmpeg-static" rule.
  const onPath = touchExe(at("path", exeName("ffmpeg")));
  const bundled = touchExe(at("bundled", exeName("ffmpeg")));
  process.env.PATH = at("path");
  assert.equal(resolveFfmpeg({ bundled, preferGpu: true }), onPath);
  assert.equal(resolveFfmpeg({ bundled }), bundled);
  process.env.PATH = at("empty");
  clearMediaCache();
  assert.equal(resolveFfmpeg({ bundled, preferGpu: true }), bundled);
});

test("pickGpuCandidate: first GPU-capable, else the first candidate", () => {
  const gpu = new Set(["bundled"]);
  assert.equal(pickGpuCandidate(["system", "bundled"], (p) => gpu.has(p)), "bundled");
  assert.equal(pickGpuCandidate(["system", "bundled"], () => true), "system");
  assert.equal(pickGpuCandidate(["system", "bundled"], () => false), "system");
  assert.equal(pickGpuCandidate([], () => true), null);
});

test("ffprobe: bundled, then the resolved ffmpeg's sibling, then PATH", () => {
  const ffmpeg = touchExe(at("ff", exeName("ffmpeg")));
  const sibling = touchExe(at("ff", exeName("ffprobe")));
  const onPath = touchExe(at("path", exeName("ffprobe")));
  const bundled = touchExe(at("ffprobe-static", exeName("ffprobe")));
  process.env.PATH = at("path");
  assert.equal(resolveFfprobe({ bundled, ffmpegPath: ffmpeg }), bundled);
  assert.equal(resolveFfprobe({ ffmpegPath: ffmpeg }), sibling);
  assert.equal(resolveFfprobe(), onPath);
  assert.equal(resolveFfprobe({ ffmpegPath: at("nowhere", exeName("ffmpeg")) }), onPath);
});

test("ffprobePathFromFfmpeg swaps the name in the same directory", () => {
  assert.equal(ffprobePathFromFfmpeg(path.join("usr", "bin", "ffmpeg")), path.join("usr", "bin", "ffprobe"));
  assert.equal(ffprobePathFromFfmpeg(path.join("C:", "x", "FFMPEG.EXE")), path.join("C:", "x", "ffprobe.EXE"));
});

test("hits are cached, re-checked on disk, and misses are not cached", () => {
  process.env.PATH = [at("p1"), at("p2")].join(path.delimiter);
  assert.equal(resolveYtDlp(), null);
  const second = touchExe(at("p2", exeName("yt-dlp")));
  assert.equal(resolveYtDlp(), second, "a binary installed after a miss is found");
  const first = touchExe(at("p1", exeName("yt-dlp")));
  assert.equal(resolveYtDlp(), second, "a hit stays cached");
  fs.rmSync(second);
  assert.equal(resolveYtDlp(), first, "a cached hit that vanished is re-resolved");
  touchExe(second);
  clearMediaCache();
  assert.equal(resolveYtDlp(), first);
});

test("the cache follows the env override's value", () => {
  const a = touchExe(at("a", exeName("ffmpeg")));
  const b = touchExe(at("b", exeName("ffmpeg")));
  process.env.FFMPEG_PATH = a;
  assert.equal(resolveFfmpeg(), a);
  process.env.FFMPEG_PATH = b;
  assert.equal(resolveFfmpeg(), b);
});

test("known Windows dirs: WinGet Links and packages, Program Files, C:\\ffmpeg, choco, scoop", { skip: !win }, () => {
  const local = process.env.LOCALAPPDATA!;
  const gyan = touchExe(path.join(local, "Microsoft", "WinGet", "Packages", "Gyan.FFmpeg_Microsoft.Winget.Source_8wekyb3d8bbwe", "ffmpeg-7.1-full_build", "bin", "ffmpeg.exe"));
  assert.equal(resolveFfmpeg(), gyan);

  const pf = touchExe(path.join(process.env.ProgramFiles!, "ffmpeg-master-latest-win64-gpl", "bin", "ffmpeg.exe"));
  clearMediaCache();
  assert.equal(resolveFfmpeg(), gyan, "WinGet packages come before Program Files");
  fs.rmSync(gyan);
  assert.equal(resolveFfmpeg(), pf);

  fs.rmSync(pf);
  const cDrive = touchExe(path.join(process.env.SystemDrive!, "ffmpeg", "bin", "ffmpeg.exe"));
  assert.equal(resolveFfmpeg(), cDrive);

  const links = touchExe(path.join(local, "Microsoft", "WinGet", "Links", "yt-dlp.exe"));
  assert.equal(resolveYtDlp(), links);
  fs.rmSync(links);
  const portable = touchExe(path.join(local, "Microsoft", "WinGet", "Packages", "yt-dlp.yt-dlp_Microsoft.Winget.Source_8wekyb3d8bbwe", "yt-dlp.exe"));
  assert.equal(resolveYtDlp(), portable);
  fs.rmSync(portable);
  const choco = touchExe(path.join(process.env.ProgramData!, "chocolatey", "bin", "yt-dlp.exe"));
  assert.equal(resolveYtDlp(), choco);
  fs.rmSync(choco);
  const scoop = touchExe(path.join(process.env.USERPROFILE!, "scoop", "shims", "yt-dlp.exe"));
  assert.equal(resolveYtDlp(), scoop);
});

test("PATH beats the known dirs", { skip: !win }, () => {
  touchExe(path.join(process.env.LOCALAPPDATA!, "Microsoft", "WinGet", "Links", "ffmpeg.exe"));
  const onPath = touchExe(at("path", "ffmpeg.exe"));
  process.env.PATH = at("path");
  assert.equal(resolveFfmpeg(), onPath);
});

test("knownInstallDirs: yt-dlp never looks in ffmpeg folders", { skip: !win }, () => {
  fs.mkdirSync(path.join(process.env.ProgramFiles!, "ffmpeg", "bin"), { recursive: true });
  const dirs = knownInstallDirs("yt-dlp");
  assert.ok(dirs.every((d) => !/ffmpeg/i.test(d)));
  assert.ok(knownInstallDirs("ffmpeg").some((d) => /ffmpeg/i.test(d)));
});

test("known POSIX dirs include Homebrew on macOS", { skip: win }, () => {
  const dirs = knownInstallDirs("ffmpeg");
  if (process.platform === "darwin") assert.ok(dirs.includes("/opt/homebrew/bin"));
  else assert.ok(dirs.includes("/usr/bin"));
});
