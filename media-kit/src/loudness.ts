// Measuring level: EBU R128 loudness (loudnorm) and sample peak (volumedetect).
//
// Both filters print their report to STDERR of a `-f null` run that exits 0, so
// anything that only returns stdout on success (execFileSync) silently reads
// nothing. The runners here always read stderr.

import { runMedia } from "./run.js";

export interface LoudnormReport {
  /** Integrated loudness, LUFS. Always finite: silent audio throws instead. */
  inputI: number;
  /** True peak, dBTP. */
  inputTp: number | null;
  /** Loudness range, LU. */
  inputLra: number | null;
  inputThresh: number | null;
  targetOffset: number | null;
}

/** Arguments for a loudnorm analysis pass. `maxDurationSec` analyses only the start (`-t`). */
export function loudnormArgs(input: string, opts: { maxDurationSec?: number } = {}): string[] {
  const args = ["-hide_banner", "-nostats", "-i", input];
  if (opts.maxDurationSec && opts.maxDurationSec > 0) args.push("-t", String(opts.maxDurationSec));
  args.push("-vn", "-af", "loudnorm=print_format=json", "-f", "null", "-");
  return args;
}

function num(v: unknown): number | null {
  const n = typeof v === "number" ? v : parseFloat(String(v));
  return Number.isFinite(n) ? n : null;
}

/**
 * Pull the loudnorm JSON block out of stderr, where it sits among ordinary log
 * lines. Throws when there is no report, and when the integrated loudness is
 * `-inf` (silent or corrupt audio): stored as a number it would poison every
 * comparison downstream.
 */
export function parseLoudnorm(stderr: string): LoudnormReport {
  const m = /\{[^{}]*"input_i"\s*:\s*"[^"]*"[^{}]*\}/s.exec(stderr ?? "");
  if (!m) throw new Error("Could not parse loudnorm output from FFmpeg");
  const data = JSON.parse(m[0]) as Record<string, unknown>;
  const inputI = num(data.input_i);
  if (inputI === null) throw new Error("Invalid loudness measurement (possibly silent or corrupt audio)");
  return {
    inputI,
    inputTp: num(data.input_tp),
    inputLra: num(data.input_lra),
    inputThresh: num(data.input_thresh),
    targetOffset: num(data.target_offset),
  };
}

/** Measure integrated loudness. Default timeout 120s. */
export async function measureLoudness(
  ffmpegPath: string,
  input: string,
  opts: { maxDurationSec?: number; timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<LoudnormReport> {
  const { stderr } = await runMedia(ffmpegPath, loudnormArgs(input, opts), {
    timeoutMs: opts.timeoutMs ?? 120_000,
    signal: opts.signal,
    stdout: "ignore",
  });
  return parseLoudnorm(stderr);
}

export interface VolumeReport {
  /** mean_volume, dB. Null when absent or -inf (silence). */
  meanDb: number | null;
  /** max_volume (sample peak), dB. Null when absent or -inf. */
  maxDb: number | null;
}

/** Arguments for a volumedetect pass. */
export function volumedetectArgs(input: string): string[] {
  return ["-hide_banner", "-nostats", "-i", input, "-vn", "-af", "volumedetect", "-f", "null", "-"];
}

/** Read volumedetect's `mean_volume:` and `max_volume:` lines. Never throws. */
export function parseVolumedetect(stderr: string): VolumeReport {
  const read = (key: string): number | null => {
    const m = new RegExp(`${key}:\\s*(-?[\\d.]+) dB`).exec(stderr ?? "");
    return m ? num(m[1]) : null;
  };
  return { meanDb: read("mean_volume"), maxDb: read("max_volume") };
}

/** Measure mean and peak volume. Default timeout 120s. */
export async function measureVolume(
  ffmpegPath: string,
  input: string,
  opts: { timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<VolumeReport> {
  const { stderr } = await runMedia(ffmpegPath, volumedetectArgs(input), {
    timeoutMs: opts.timeoutMs ?? 120_000,
    signal: opts.signal,
    stdout: "ignore",
  });
  return parseVolumedetect(stderr);
}

