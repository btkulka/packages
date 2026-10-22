// Which hardware encoders and decoders an ffmpeg binary was built with.
//
// Being listed means "this ffmpeg knows the encoder", not "this machine can use
// it": NVENC needs an NVIDIA GPU and driver, QSV an Intel iGPU, AMF an AMD GPU.
// That is only proven by an encode, so callers keep a software fallback.

import { spawnSync } from "node:child_process";
import { runMedia } from "./run.js";

export type HwEncoderId = "h264_nvenc" | "hevc_nvenc" | "h264_qsv" | "h264_amf";

export interface HwEncoder {
  id: HwEncoderId;
  label: string;
  vendor: "nvidia" | "intel" | "amd";
}

/** The hardware video encoders apps know how to drive, in display order. */
export const HW_ENCODERS: readonly HwEncoder[] = [
  { id: "h264_nvenc", label: "NVIDIA NVENC (H.264)", vendor: "nvidia" },
  { id: "hevc_nvenc", label: "NVIDIA NVENC (HEVC)", vendor: "nvidia" },
  { id: "h264_qsv", label: "Intel QuickSync (H.264)", vendor: "intel" },
  { id: "h264_amf", label: "AMD AMF (H.264)", vendor: "amd" },
];

export type GpuEncoder = "h264_nvenc" | "h264_qsv" | "h264_amf" | null;
export type GpuDecoder = "h264_cuvid" | "h264_qsv" | null;
export type HwAccel = "cuda" | "qsv" | "d3d11va" | null;

export interface HwCapabilities {
  /** Preferred H.264 encoder: NVIDIA > Intel > AMD, or null for software (libx264). */
  encoder: GpuEncoder;
  /** Preferred H.264 decoder: NVIDIA CUVID > Intel QSV, or null. */
  decoder: GpuDecoder;
  /** The `-hwaccel` value matching the above, or null. */
  hwaccel: HwAccel;
  /** Every entry of HW_ENCODERS this ffmpeg lists. */
  encoders: HwEncoder[];
}

const SOFTWARE: HwCapabilities = { encoder: null, decoder: null, hwaccel: null, encoders: [] };

/** True when `-encoders`/`-decoders` output lists `id` as a codec (not merely mentions it). */
function lists(output: string, id: string): boolean {
  return new RegExp(`^\\s*[A-Z.]{6}\\s+${id}(\\s|$)`, "m").test(output);
}

/** Pure: read `ffmpeg -hide_banner -encoders` and `-decoders` output. */
export function parseHwCapabilities(encodersOutput: string, decodersOutput: string): HwCapabilities {
  const enc = encodersOutput ?? "";
  const dec = decodersOutput ?? "";
  const encoder: GpuEncoder = lists(enc, "h264_nvenc")
    ? "h264_nvenc"
    : lists(enc, "h264_qsv")
      ? "h264_qsv"
      : lists(enc, "h264_amf")
        ? "h264_amf"
        : null;
  const decoder: GpuDecoder = lists(dec, "h264_cuvid") ? "h264_cuvid" : lists(dec, "h264_qsv") ? "h264_qsv" : null;
  let hwaccel: HwAccel = null;
  if (encoder === "h264_nvenc" || decoder === "h264_cuvid") hwaccel = "cuda";
  else if (encoder === "h264_qsv" || decoder === "h264_qsv") hwaccel = "qsv";
  else if (encoder === "h264_amf") hwaccel = "d3d11va";
  return { encoder, decoder, hwaccel, encoders: HW_ENCODERS.filter((e) => lists(enc, e.id)) };
}

const cache = new Map<string, HwCapabilities>();

/**
 * Probe an ffmpeg binary's hardware support. Cached per binary path for the
 * process lifetime (pass `refresh` after a driver update). Never throws: a probe
 * that fails reports software only.
 */
export async function probeHwCapabilities(
  ffmpegPath: string,
  opts: { timeoutMs?: number; refresh?: boolean } = {},
): Promise<HwCapabilities> {
  const hit = cache.get(ffmpegPath);
  if (hit && !opts.refresh) return hit;
  const timeoutMs = opts.timeoutMs ?? 10_000;
  let caps = SOFTWARE;
  try {
    const [enc, dec] = await Promise.all([
      runMedia(ffmpegPath, ["-hide_banner", "-encoders"], { timeoutMs }),
      runMedia(ffmpegPath, ["-hide_banner", "-decoders"], { timeoutMs }),
    ]);
    caps = parseHwCapabilities(enc.stdout.toString("utf8"), dec.stdout.toString("utf8"));
  } catch {
    caps = SOFTWARE;
  }
  cache.set(ffmpegPath, caps);
  return caps;
}

/** Sync probe for binary resolution. Shares the cache with probeHwCapabilities. */
export function probeHwCapabilitiesSync(ffmpegPath: string, timeoutMs = 10_000): HwCapabilities {
  const hit = cache.get(ffmpegPath);
  if (hit) return hit;
  const read = (flag: string): string => {
    const r = spawnSync(ffmpegPath, ["-hide_banner", flag], {
      encoding: "utf8",
      windowsHide: true,
      timeout: timeoutMs,
      maxBuffer: 16 * 1024 * 1024,
    });
    return r.error || r.status !== 0 ? "" : (r.stdout ?? "");
  };
  const caps = parseHwCapabilities(read("-encoders"), read("-decoders"));
  cache.set(ffmpegPath, caps);
  return caps;
}

export function clearHwCache(): void {
  cache.clear();
}
