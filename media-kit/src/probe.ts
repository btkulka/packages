// ffprobe JSON: duration, streams, and the video facts apps read from it.

import { runMedia } from "./run.js";
import { parseFfmpegTime } from "./time.js";

export interface ProbeStream {
  index: number;
  codec_type?: "video" | "audio" | "subtitle" | "data" | "attachment" | string;
  codec_name?: string;
  width?: number;
  height?: number;
  avg_frame_rate?: string;
  r_frame_rate?: string;
  duration?: string;
  sample_rate?: string;
  channels?: number;
  bits_per_raw_sample?: string;
  disposition?: Record<string, number>;
  tags?: Record<string, string>;
  [key: string]: unknown;
}

export interface ProbeFormat {
  filename?: string;
  format_name?: string;
  duration?: string;
  size?: string;
  bit_rate?: string;
  tags?: Record<string, string>;
  [key: string]: unknown;
}

export interface ProbeResult {
  format: ProbeFormat;
  streams: ProbeStream[];
}

/** ffprobe arguments for the whole picture of a file as JSON. */
export function probeArgs(file: string): string[] {
  return ["-v", "error", "-print_format", "json", "-show_format", "-show_streams", file];
}

/** Parse ffprobe's JSON. Throws on output that isn't JSON. */
export function parseProbeOutput(stdout: string | Buffer): ProbeResult {
  const data = JSON.parse(stdout.toString()) as Partial<ProbeResult>;
  return {
    format: data.format ?? {},
    streams: Array.isArray(data.streams) ? data.streams : [],
  };
}

/**
 * Probe a file. Default timeout 30s. Rejects with MediaRunError when ffprobe
 * fails (unreadable or missing file) and with a SyntaxError on garbage output.
 */
export async function probeMedia(
  ffprobePath: string,
  file: string,
  opts: { timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<ProbeResult> {
  const { stdout } = await runMedia(ffprobePath, probeArgs(file), {
    timeoutMs: opts.timeoutMs ?? 30_000,
    signal: opts.signal,
  });
  return parseProbeOutput(stdout);
}

function seconds(value: unknown): number | null {
  if (value === undefined || value === null || value === "N/A") return null;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

/**
 * Duration in seconds: the container's, else the longest stream's, else a
 * Matroska `DURATION` tag (mkv/webm streams often carry only that). Null when
 * nothing says.
 */
export function mediaDuration(probe: ProbeResult): number | null {
  const fromFormat = seconds(probe.format?.duration);
  if (fromFormat !== null) return fromFormat;
  let best: number | null = null;
  for (const s of probe.streams ?? []) {
    let d = seconds(s.duration);
    if (d === null) {
      const tag = s.tags?.DURATION ?? s.tags?.duration;
      const t = tag ? parseFfmpegTime(tag) : null;
      d = t !== null && t >= 0 ? t : null;
    }
    if (d !== null && (best === null || d > best)) best = d;
  }
  return best;
}

/**
 * Parse an ffprobe rate like "60/1" or "30000/1001", rounded to 3 decimals.
 * Null for anything malformed, non-positive or at least 240 (junk ffprobe output).
 */
export function parseFrameRate(value: unknown): number | null {
  if (typeof value !== "string" || !value.includes("/")) return null;
  const [num, den] = value.split("/").map(Number);
  if (!den || den <= 0) return null;
  const fps = num / den;
  if (!(fps > 0) || fps >= 240) return null;
  return Math.round(fps * 1000) / 1000;
}

/**
 * avg_frame_rate first (r_frame_rate can report double the real rate for VFR or
 * interlaced video), r_frame_rate as the fallback.
 */
export function pickFrameRate(avg: unknown, r: unknown): number | null {
  return parseFrameRate(avg) ?? parseFrameRate(r);
}

export interface VideoInfo {
  durationMs: number | null;
  width: number | null;
  height: number | null;
  fps: number | null;
}

/**
 * The first real video stream's size and rate, plus the file's duration.
 * Cover art (an attached picture in an mp3 or m4a) is not a video stream and is
 * skipped. All null fields when there is no video.
 */
export function videoInfo(probe: ProbeResult): VideoInfo {
  const stream = (probe.streams ?? []).find((s) => s.codec_type === "video" && s.disposition?.attached_pic !== 1);
  const duration = mediaDuration(probe);
  return {
    durationMs: duration === null ? null : Math.floor(duration * 1000),
    width: typeof stream?.width === "number" ? stream.width : null,
    height: typeof stream?.height === "number" ? stream.height : null,
    fps: stream ? pickFrameRate(stream.avg_frame_rate, stream.r_frame_rate) : null,
  };
}
