import { statSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { mediaDuration, probeMedia, resolveFfmpeg, resolveFfprobe, runMedia, type ProbeResult } from "@btkulka/media-kit";
import type { VideoInfo } from "./types.js";

// Videos in the library: what's in one (ffprobe: length, frame size, rate, codecs) and a frame for its
// thumbnail (ffmpeg). Both come from media-kit, which finds the binaries (FFMPEG_PATH / FFPROBE_PATH, PATH,
// WinGet and the usual install folders). Without ffprobe a video still comes in, with its facts blank and
// `error` saying why; it's read again when the file changes.

/** What ffprobe says about a video, in the library's words. */
export function videoFacts(probe: ProbeResult): VideoInfo {
  const v = probe.streams.find((s) => s.codec_type === "video" && s.disposition?.attached_pic !== 1);
  const a = probe.streams.find((s) => s.codec_type === "audio");
  const secs = mediaDuration(probe);
  const rate = (r: unknown) => {
    if (typeof r !== "string" || !r.includes("/")) return null;
    const [n, d] = r.split("/").map(Number);
    const fps = d > 0 ? n / d : 0;
    return fps > 0 && fps < 1000 ? Math.round(fps * 1000) / 1000 : null;
  };
  // A phone's portrait video is stored sideways with a rotation: its frame is what's shown, upright.
  const rot = Math.abs(Number((v?.side_data_list as { rotation?: number }[] | undefined)?.find((x) => x.rotation != null)?.rotation ?? v?.tags?.rotate ?? 0)) % 180 === 90;
  const w = typeof v?.width === "number" ? v.width : null;
  const h = typeof v?.height === "number" ? v.height : null;
  const kbps = Number(probe.format.bit_rate);
  return {
    duration: secs === null ? null : Math.round(secs * 1000) / 1000,
    width: rot ? h : w,
    height: rot ? w : h,
    fps: v ? (rate(v.avg_frame_rate) ?? rate(v.r_frame_rate)) : null,
    codec: v?.codec_name ?? null,
    audio: a?.codec_name ?? null,
    ...(Number.isFinite(kbps) && kbps > 0 ? { bitrate: Math.round(kbps / 1000) } : {}),
    container: probe.format.format_name?.split(",")[0] ?? undefined,
    ...(v ? {} : { error: "No video stream in it." }),
  };
}

let ffprobe: string | null | undefined;
let ffmpeg: string | null | undefined;
const probeBin = () => (ffprobe ??= resolveFfprobe());
const ffmpegBin = () => (ffmpeg ??= resolveFfmpeg());

/** What's in a video file. Never throws: a file ffprobe can't read (or no ffprobe) gives blank facts and why. */
export async function videoInfo(path: string): Promise<VideoInfo> {
  const blank = (error: string): VideoInfo => ({ duration: null, width: null, height: null, fps: null, codec: null, audio: null, error });
  const bin = probeBin();
  if (!bin) {
    ffprobe = undefined; // installed while the app runs: found next time
    return blank("ffprobe isn't installed (winget install Gyan.FFmpeg), so its length and size are unknown.");
  }
  try {
    return videoFacts(await probeMedia(bin, path, { timeoutMs: 20_000 }));
  } catch (e) {
    return blank(`ffprobe couldn't read it: ${(e as Error).message.split("\n")[0].slice(0, 200)}`);
  }
}

/**
 * A frame of a video as a JPEG at `out`, no bigger than `px` on its long side: from a tenth of the way in
 * (past a fade from black), at most 3 s in. False when there's no ffmpeg or it can't decode the file.
 */
export async function videoFrame(path: string, out: string, px: number, duration?: number | null): Promise<boolean> {
  const bin = ffmpegBin();
  if (!bin) {
    ffmpeg = undefined;
    return false;
  }
  await mkdir(dirname(out), { recursive: true });
  const at = duration && duration > 0 ? Math.min(3, duration / 10) : 1;
  const scale = `scale='if(gt(iw,ih),min(${px},iw),-2)':'if(gt(iw,ih),-2,min(${px},ih))'`;
  // ffmpeg seeking past the end exits fine and writes nothing: a frame is there or it isn't.
  const grab = (seek: number) =>
    runMedia(bin, ["-hide_banner", "-loglevel", "error", "-y", "-ss", seek.toFixed(3), "-i", path, "-frames:v", "1", "-vf", scale, "-q:v", "4", out], { timeoutMs: 30_000 }).then(
      () => (statSync(out, { throwIfNoEntry: false })?.size ?? 0) > 0,
      () => false,
    );
  // A clip shorter than the guess, or one that won't seek: its first frame.
  return (await grab(at)) || (at > 0 && (await grab(0)));
}
