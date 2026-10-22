// Audio conversion: one argument builder for the mp3 / wav / aiff encodes every
// app does, and a runner for it.

import path from "node:path";
import { runMedia, type FfmpegProgress } from "./run.js";

export type AudioFormat = "mp3" | "wav" | "aiff";

export interface AudioConvertOptions {
  /** Output format. Default: from the output's extension (.mp3, .wav, .aif/.aiff). */
  format?: AudioFormat;
  /** mp3 constant bitrate in kbps (`-b:a 192k`). Default 192 unless vbrQuality is set. */
  bitrateKbps?: number;
  /** mp3 VBR quality (`-q:a`), 0 best to 9 smallest. Takes the place of bitrateKbps. */
  vbrQuality?: number;
  /** PCM bit depth for wav/aiff. Default 16. */
  bitDepth?: 16 | 24 | 32;
  /** `-ar`, e.g. 44100. Default: the source's. */
  sampleRate?: number;
  /** `-ac`, e.g. 1 for mono. Default: the source's. */
  channels?: number;
  /** Audio filters (`-af`); a list is joined with commas. */
  filters?: string | readonly string[];
  /** `-metadata key=value` tags. undefined and null values are skipped. For aiff, tags are written as ID3v2.3. */
  metadata?: Record<string, string | number | null | undefined>;
  /** Drop video streams, including embedded cover art (`-vn`). Default true. */
  dropVideo?: boolean;
  /** `-hide_banner -loglevel error`. Default false (progress needs the stats lines). */
  quiet?: boolean;
  /** Extra arguments placed just before the output path. */
  extraArgs?: readonly string[];
}

/**
 * The PCM codec for a depth. WAV is little-endian and AIFF big-endian, so a
 * WAV-to-AIFF rewrite with `-c:a copy` leaves byte-swapped static: always
 * re-encode to the container's own endianness.
 */
export function pcmCodec(format: "wav" | "aiff", bitDepth: 16 | 24 | 32 = 16): string {
  const bits = bitDepth >= 32 ? 32 : bitDepth >= 24 ? 24 : 16;
  return `pcm_s${bits}${format === "aiff" ? "be" : "le"}`;
}

function formatFromPath(output: string): AudioFormat {
  const ext = path.extname(output).toLowerCase();
  if (ext === ".mp3") return "mp3";
  if (ext === ".wav") return "wav";
  if (ext === ".aif" || ext === ".aiff" || ext === ".aifc") return "aiff";
  throw new Error(`Can't tell the audio format from "${ext || output}"; pass opts.format`);
}

/** Arguments to convert `input` to `output` (always overwrites). */
export function audioConvertArgs(input: string, output: string, opts: AudioConvertOptions = {}): string[] {
  const format = opts.format ?? formatFromPath(output);
  const args: string[] = [];
  if (opts.quiet) args.push("-hide_banner", "-loglevel", "error");
  args.push("-y", "-i", input);
  if (opts.dropVideo !== false) args.push("-vn");
  const filters = typeof opts.filters === "string" ? opts.filters : (opts.filters ?? []).join(",");
  if (filters) args.push("-af", filters);

  if (format === "mp3") {
    args.push("-codec:a", "libmp3lame");
    if (opts.vbrQuality !== undefined) args.push("-q:a", String(opts.vbrQuality));
    else args.push("-b:a", `${opts.bitrateKbps ?? 192}k`);
  } else {
    args.push("-codec:a", pcmCodec(format, opts.bitDepth ?? 16));
  }
  if (opts.sampleRate) args.push("-ar", String(opts.sampleRate));
  if (opts.channels) args.push("-ac", String(opts.channels));

  const tags = Object.entries(opts.metadata ?? {}).filter(([, v]) => v !== undefined && v !== null);
  for (const [k, v] of tags) args.push("-metadata", `${k}=${v}`);
  if (format === "aiff" && tags.length > 0) {
    // AIFF carries tags in an ID3 chunk; v2.3 reads more reliably than ffmpeg's default v2.4.
    args.push("-write_id3v2", "1", "-id3v2_version", "3");
  }
  if (opts.format) args.push("-f", format);
  args.push(...(opts.extraArgs ?? []), output);
  return args;
}

/** Convert an audio file. Rejects with MediaRunError (its `stderr` has ffmpeg's full complaint). */
export async function convertAudio(
  ffmpegPath: string,
  input: string,
  output: string,
  opts: AudioConvertOptions & {
    timeoutMs?: number;
    signal?: AbortSignal;
    onProgress?: (p: FfmpegProgress) => void;
    durationSec?: number;
  } = {},
): Promise<void> {
  await runMedia(ffmpegPath, audioConvertArgs(input, output, opts), {
    timeoutMs: opts.timeoutMs,
    signal: opts.signal,
    onProgress: opts.onProgress,
    durationSec: opts.durationSec,
    stdout: "ignore",
  });
}
