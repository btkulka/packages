// yt-dlp: download with progress and a trustworthy final path, JSON metadata,
// version and staleness, and error classification.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { MediaRunError, runMedia, spawnMedia } from "./run.js";

export interface YtDlpProgress {
  percent: number;
  downloadedBytes: number;
  totalBytes: number;
}

const UNIT: Record<string, number> = {
  B: 1,
  KIB: 1024,
  MIB: 1024 ** 2,
  GIB: 1024 ** 3,
  TIB: 1024 ** 4,
  KB: 1000,
  MB: 1000 ** 2,
  GB: 1000 ** 3,
  TB: 1000 ** 4,
};

/**
 * Pure: read one `[download]  42.0% of ~ 12.34MiB at ...` line. The total is
 * often prefixed `~` (an estimate for a stream nobody published a size for). A
 * line that isn't progress gives null, never a zeroed reading that would snap a
 * progress bar back to the start.
 */
export function parseYtDlpProgress(line: string): YtDlpProgress | null {
  const m = /\[download\]\s+([\d.]+)%\s+of\s+~?\s*([\d.]+)\s*(B|KiB|MiB|GiB|TiB|KB|MB|GB|TB)\b/i.exec(line ?? "");
  if (!m) return null;
  const percent = Number(m[1]);
  const size = Number(m[2]);
  const unit = UNIT[m[3].toUpperCase()];
  if (!Number.isFinite(percent) || !Number.isFinite(size) || unit === undefined) return null;
  const totalBytes = Math.round(size * unit);
  return { percent, downloadedBytes: Math.round((percent / 100) * totalBytes), totalBytes };
}

export type YtDlpErrorKind = "extractor" | "unavailable" | "network" | "auth" | "disk" | "unknown";

/**
 * Pure: what kind of failure stderr describes. Extractor breaks are fixed by
 * updating yt-dlp; an unavailable video never will be, so retrying it is wasted.
 */
export function classifyYtDlpError(stderr: string): YtDlpErrorKind {
  const s = String(stderr ?? "").toLowerCase();
  if (/unable to extract|signature extraction|nsig extraction|failed to extract|unsupported url|no video formats/.test(s)) {
    return "extractor";
  }
  if (/video unavailable|private video|has been removed|deleted|members-only|404|not found|geo|blocked in your country/.test(s)) {
    return "unavailable";
  }
  if (/login|sign in|age.?restricted|cookies|authentication|premium/.test(s)) return "auth";
  if (/no space left|enospc|disk full/.test(s)) return "disk";
  if (/http error 5\d\d|timed out|timeout|connection reset|temporary failure|network|econn/.test(s)) return "network";
  return "unknown";
}

/** Pure: the release date in what `--version` prints (`2026.08.18` or nightly `2026.08.18.122307`). */
export function parseYtDlpVersion(stdout: string): Date | null {
  const m = /(\d{4})\.(\d{2})\.(\d{2})/.exec(String(stdout ?? "").trim());
  if (!m) return null;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return Number.isNaN(d.getTime()) ? null : d;
}

export type YtDlpStaleness = "fresh" | "aging" | "stale" | "unknown";

/** Pure: under 30 days fresh, under 90 aging, else stale. Extractors break constantly. */
export function ytDlpStaleness(ageDays: number | null): YtDlpStaleness {
  if (ageDays === null || ageDays === undefined || !Number.isFinite(ageDays)) return "unknown";
  if (ageDays < 30) return "fresh";
  if (ageDays < 90) return "aging";
  return "stale";
}

export interface YtDlpVersionInfo {
  /** What `--version` printed, trimmed, or null when it couldn't run. */
  version: string | null;
  releasedAt: Date | null;
  ageDays: number | null;
  staleness: YtDlpStaleness;
}

/** Run `--version` and judge its age. Never throws. */
export async function getYtDlpVersion(
  ytDlpPath: string,
  opts: { timeoutMs?: number; now?: number } = {},
): Promise<YtDlpVersionInfo> {
  let stdout = "";
  try {
    stdout = (await runMedia(ytDlpPath, ["--version"], { timeoutMs: opts.timeoutMs ?? 5000 })).stdout.toString("utf8");
  } catch {
    stdout = "";
  }
  const releasedAt = parseYtDlpVersion(stdout);
  const ageDays = releasedAt ? Math.floor(((opts.now ?? Date.now()) - releasedAt.getTime()) / 86_400_000) : null;
  return { version: stdout.trim() || null, releasedAt, ageDays, staleness: ytDlpStaleness(ageDays) };
}

/** Pure: every line of `text` that parses as a JSON object; other lines are skipped. */
export function parseJsonLines<T = Record<string, unknown>>(text: string): T[] {
  const items: T[] = [];
  for (const line of String(text ?? "").split(/\r?\n/)) {
    const t = line.trim();
    if (!t.startsWith("{")) continue;
    try {
      items.push(JSON.parse(t) as T);
    } catch {
      /* a truncated or interleaved line */
    }
  }
  return items;
}

const DUMP_FLAGS = new Set(["-j", "--dump-json", "-J", "--dump-single-json"]);

/**
 * Run yt-dlp for JSON metadata (`--dump-json` is added unless a dump flag is
 * already there) and return one object per line. A non-zero exit still returns
 * whatever printed (`--ignore-errors` searches); it rejects only when nothing
 * did, with the stderr on the MediaRunError for classifyYtDlpError.
 */
export async function ytDlpJson<T = Record<string, unknown>>(
  ytDlpPath: string,
  args: readonly string[],
  opts: { timeoutMs?: number; signal?: AbortSignal; maxBuffer?: number; cwd?: string } = {},
): Promise<T[]> {
  const argv = args.some((a) => DUMP_FLAGS.has(a)) ? [...args] : [...args, "--dump-json"];
  const r = await runMedia(ytDlpPath, argv, {
    timeoutMs: opts.timeoutMs,
    signal: opts.signal,
    maxBuffer: opts.maxBuffer ?? 64 * 1024 * 1024,
    cwd: opts.cwd,
    check: false,
  });
  const items = parseJsonLines<T>(r.stdout.toString("utf8"));
  if (items.length === 0 && r.code !== 0) {
    const last = r.stderr.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).pop() ?? "";
    throw new MediaRunError(`yt-dlp exited with code ${r.code}${last ? `: ${last.slice(0, 300)}` : ""}`, {
      bin: ytDlpPath,
      args: argv,
      code: r.code,
      signal: r.signal,
      stderr: r.stderr,
      reason: "exit",
    });
  }
  return items;
}

export interface YtDlpDownloadOptions {
  url: string;
  /** Output template (`-o`), e.g. `path.join(dir, `${base}.%(ext)s`)`; yt-dlp picks the extension. */
  output: string;
  /** Format selector (`-f`). */
  format?: string;
  /** More arguments, e.g. `['-x', '--audio-format', 'mp3']` or `['--merge-output-format', 'mp4']`. */
  args?: readonly string[];
  /** ffmpeg for merging and post-processing (`--ffmpeg-location`), e.g. the app's resolveFfmpeg() result. */
  ffmpegPath?: string | null;
  /** Add `--ignore-config` so a user's yt-dlp config can't change the result. Default true. */
  ignoreConfig?: boolean;
  signal?: AbortSignal;
  timeoutMs?: number;
  onProgress?: (p: YtDlpProgress) => void;
  /** Every output line, for logs. */
  onLine?: (line: string, stream: "stdout" | "stderr") => void;
  cwd?: string;
}

/** Arguments for ytDlpDownload; the final path is printed to `pathFile`. */
export function ytDlpDownloadArgs(opts: YtDlpDownloadOptions, pathFile: string): string[] {
  const args: string[] = [];
  if (opts.ignoreConfig !== false) args.push("--ignore-config");
  args.push("--no-playlist", "--newline", "--progress", "--no-colors");
  if (opts.format) args.push("-f", opts.format);
  if (opts.ffmpegPath) args.push("--ffmpeg-location", opts.ffmpegPath);
  args.push(...(opts.args ?? []));
  args.push("-o", opts.output, "--print-to-file", "after_move:filepath", pathFile, opts.url);
  return args;
}

/** The last path yt-dlp printed to `pathFile`, if that file exists on disk; else null. */
export function readPrintedPath(pathFile: string): string | null {
  let text = "";
  try {
    text = fs.readFileSync(pathFile, "utf8");
  } catch {
    return null;
  }
  const last = text
    .replace(/^﻿/, "")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .pop();
  return last && fs.existsSync(last) ? last : null;
}

/**
 * Download one URL and return the finished file's path.
 *
 * The path comes back through `--print-to-file after_move:filepath`, not by
 * guessing at the template: yt-dlp picks the extension after choosing a format
 * and may merge into another container, so a guessed name is wrong exactly when
 * the download worked. Exit 0 with no file on disk rejects (reason "output").
 * Abort and timeout kill yt-dlp and the ffmpeg it may be running.
 */
export async function ytDlpDownload(ytDlpPath: string, opts: YtDlpDownloadOptions): Promise<string> {
  const pathFile = path.join(
    os.tmpdir(),
    `media-kit-ytdlp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.txt`,
  );
  const args = ytDlpDownloadArgs(opts, pathFile);
  try {
    await spawnMedia(ytDlpPath, args, {
      signal: opts.signal,
      timeoutMs: opts.timeoutMs,
      cwd: opts.cwd,
      onLine: (line, stream) => {
        // Progress lands on stdout or stderr depending on how yt-dlp was built.
        const p = parseYtDlpProgress(line);
        if (p) opts.onProgress?.(p);
        opts.onLine?.(line, stream);
      },
    }).result;
    const finalPath = readPrintedPath(pathFile);
    if (!finalPath) {
      throw new MediaRunError("yt-dlp reported success but produced no file", {
        bin: ytDlpPath,
        args,
        code: 0,
        reason: "output",
      });
    }
    return finalPath;
  } finally {
    try {
      fs.unlinkSync(pathFile);
    } catch {
      /* never written, or already gone */
    }
  }
}
