// Finding ffmpeg, ffprobe and yt-dlp.
//
// Order: env override, then the app's bundled binary, then PATH, then extra dirs
// the app names, then known install dirs. The env override is authoritative: when
// it is set and points nowhere, the answer is null rather than some other binary.
// Hits are cached (and re-checked on disk); misses are not, so a binary installed
// while the app runs is found on the next call.

import fs from "node:fs";
import path from "node:path";
import { findExecutable } from "@btkulka/proc-kit";
import { clearHwCache, probeHwCapabilitiesSync } from "./hwaccel.js";

export type MediaTool = "ffmpeg" | "ffprobe" | "yt-dlp";

export interface ResolveOptions {
  /**
   * Environment variable that overrides everything: a path, or a command name
   * looked up on PATH. Default FFMPEG_PATH, FFPROBE_PATH or YT_DLP_PATH; null
   * turns the override off.
   */
  envVar?: string | null;
  /**
   * The app's own binary, e.g. `require('ffmpeg-static')` or
   * `require('ffprobe-static').path`, or a list checked in order. Missing entries
   * are skipped. A path inside `app.asar` is read from `app.asar.unpacked`.
   */
  bundled?: string | null | ReadonlyArray<string | null | undefined>;
  /** Directories searched after PATH and before the known install dirs. */
  extraDirs?: string[];
}

export interface FfmpegResolveOptions extends ResolveOptions {
  /**
   * Prefer an ffmpeg built with NVENC, CUDA, QSV or AMF. The system binary (PATH,
   * extra dirs, known dirs) is tried before the bundled one, and the first that
   * lists a hardware encoder or decoder wins; when neither does, the system one
   * wins. Costs one `ffmpeg -encoders`/`-decoders` probe per candidate, cached.
   */
  preferGpu?: boolean;
}

export interface FfprobeResolveOptions extends ResolveOptions {
  /** A resolved ffmpeg: its sibling ffprobe is tried after `bundled`, before PATH. */
  ffmpegPath?: string | null;
}

const DEFAULT_ENV: Record<MediaTool, string> = {
  ffmpeg: "FFMPEG_PATH",
  ffprobe: "FFPROBE_PATH",
  "yt-dlp": "YT_DLP_PATH",
};

function isFile(p: string): boolean {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

function isDir(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function subdirs(dir: string, match: RegExp): string[] {
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isDirectory() && match.test(d.name))
      .map((d) => path.join(dir, d.name))
      .sort()
      .reverse();
  } catch {
    return [];
  }
}

/**
 * Where installers put these tools, for when PATH doesn't say. Matters most for a
 * GUI app: winget and choco add to PATH at install time, but a running process
 * keeps the PATH it started with, and a macOS app launched from Finder gets a
 * minimal PATH without Homebrew.
 */
export function knownInstallDirs(tool: MediaTool): string[] {
  if (process.platform === "darwin") return ["/opt/homebrew/bin", "/usr/local/bin"];
  if (process.platform !== "win32") return ["/usr/local/bin", "/usr/bin", "/snap/bin"];

  const env = process.env;
  const dirs: string[] = [];
  const localAppData = env.LOCALAPPDATA;
  const winget = localAppData ? path.join(localAppData, "Microsoft", "WinGet") : null;
  if (winget) dirs.push(path.join(winget, "Links"));

  if (tool === "yt-dlp") {
    // winget's portable yt-dlp sits at the package root.
    if (winget) dirs.push(...subdirs(path.join(winget, "Packages"), /^yt-dlp\.yt-dlp/i));
  } else {
    // Gyan.FFmpeg, BtbN.FFmpeg and yt-dlp.FFmpeg unpack to <package>\<build>\bin.
    if (winget) {
      for (const pkg of subdirs(path.join(winget, "Packages"), /ffmpeg/i)) {
        dirs.push(path.join(pkg, "bin"));
        for (const build of subdirs(pkg, /./)) dirs.push(path.join(build, "bin"));
      }
    }
    for (const pf of [env.ProgramFiles, env["ProgramFiles(x86)"]]) {
      if (!pf) continue;
      for (const d of subdirs(pf, /^ffmpeg/i)) dirs.push(path.join(d, "bin"));
    }
    dirs.push(path.join(`${env.SystemDrive ?? "C:"}\\`, "ffmpeg", "bin"));
  }
  if (env.ProgramData) dirs.push(path.join(env.ProgramData, "chocolatey", "bin"));
  if (env.USERPROFILE) dirs.push(path.join(env.USERPROFILE, "scoop", "shims"));
  return dirs;
}

/** The ffprobe beside an ffmpeg: same directory, `ffmpeg` swapped for `ffprobe` in the name. */
export function ffprobePathFromFfmpeg(ffmpegPath: string): string {
  const dir = path.dirname(ffmpegPath);
  const name = path.basename(ffmpegPath).replace(/ffmpeg/i, "ffprobe");
  return path.join(dir, name);
}

function asList(bundled: ResolveOptions["bundled"]): string[] {
  if (!bundled) return [];
  const list = typeof bundled === "string" ? [bundled] : bundled;
  return list.filter((p): p is string => typeof p === "string" && p.length > 0);
}

/** A bundled path that exists, preferring its app.asar.unpacked twin (asar contents can't be executed). */
function existingBundled(p: string): string | null {
  const unpacked = p.replace(/app\.asar([\\/])/, "app.asar.unpacked$1");
  if (unpacked !== p && isFile(unpacked)) return unpacked;
  return isFile(p) ? p : null;
}

/** undefined: no override set. null: set but not found. string: the override. */
function fromEnv(tool: MediaTool, envVar: string | null | undefined): string | null | undefined {
  const name = envVar === undefined ? DEFAULT_ENV[tool] : envVar;
  if (!name) return undefined;
  const raw = process.env[name]?.trim().replace(/^"(.*)"$/, "$1");
  if (!raw) return undefined;
  if (path.isAbsolute(raw) || /[\\/]/.test(raw)) {
    if (isFile(raw)) return path.resolve(raw);
    // A directory (`C:\ffmpeg\bin`) means the tool inside it; a path without
    // `.exe` still finds the .exe on Windows.
    if (isDir(raw)) return findExecutable(path.join(raw, tool));
    return findExecutable(raw);
  }
  return findExecutable(raw);
}

/** First hit on PATH, then extraDirs, then known install dirs. */
function fromSystem(tool: MediaTool, opts: ResolveOptions): string | null {
  return findExecutable(tool, { extraDirs: [...(opts.extraDirs ?? []), ...knownInstallDirs(tool)] });
}

/**
 * Pure ordering rule for `preferGpu`: the first GPU-capable candidate, else the
 * first candidate. Candidates come system first, bundled last.
 */
export function pickGpuCandidate(candidates: readonly string[], isGpuCapable: (p: string) => boolean): string | null {
  for (const c of candidates) if (isGpuCapable(c)) return c;
  return candidates[0] ?? null;
}

const cache = new Map<string, string>();

function cached(key: string, find: () => string | null): string | null {
  const hit = cache.get(key);
  if (hit && isFile(hit)) return hit;
  cache.delete(key);
  const found = find();
  if (found) cache.set(key, found);
  return found;
}

function cacheKey(tool: MediaTool, opts: object, envVar: string | null | undefined): string {
  const name = envVar === undefined ? DEFAULT_ENV[tool] : envVar;
  return JSON.stringify([tool, opts, name ? process.env[name] ?? "" : ""]);
}

/** Absolute path to ffmpeg, or null when there is none. */
export function resolveFfmpeg(opts: FfmpegResolveOptions = {}): string | null {
  return cached(cacheKey("ffmpeg", opts, opts.envVar), () => {
    const env = fromEnv("ffmpeg", opts.envVar);
    if (env !== undefined) return env;
    const bundled = asList(opts.bundled).map(existingBundled).filter((p): p is string => p !== null);
    const system = fromSystem("ffmpeg", opts);
    if (opts.preferGpu) {
      const candidates = [...(system ? [system] : []), ...bundled];
      return pickGpuCandidate(candidates, (p) => probeHwCapabilitiesSync(p).hwaccel !== null);
    }
    return bundled[0] ?? system;
  });
}

/** Absolute path to ffprobe, or null. */
export function resolveFfprobe(opts: FfprobeResolveOptions = {}): string | null {
  return cached(cacheKey("ffprobe", opts, opts.envVar), () => {
    const env = fromEnv("ffprobe", opts.envVar);
    if (env !== undefined) return env;
    for (const p of asList(opts.bundled)) {
      const hit = existingBundled(p);
      if (hit) return hit;
    }
    if (opts.ffmpegPath) {
      const sibling = ffprobePathFromFfmpeg(opts.ffmpegPath);
      if (sibling !== opts.ffmpegPath && isFile(sibling)) return sibling;
    }
    return fromSystem("ffprobe", opts);
  });
}

/** Absolute path to yt-dlp, or null. Nothing is downloaded. */
export function resolveYtDlp(opts: ResolveOptions = {}): string | null {
  return cached(cacheKey("yt-dlp", opts, opts.envVar), () => {
    const env = fromEnv("yt-dlp", opts.envVar);
    if (env !== undefined) return env;
    for (const p of asList(opts.bundled)) {
      const hit = existingBundled(p);
      if (hit) return hit;
    }
    return fromSystem("yt-dlp", opts);
  });
}

/** Forget cached binary paths and hardware probes. */
export function clearMediaCache(): void {
  cache.clear();
  clearHwCache();
}
