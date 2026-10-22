// @btkulka/media-kit: find and run ffmpeg, ffprobe and yt-dlp.

export {
  resolveFfmpeg,
  resolveFfprobe,
  resolveYtDlp,
  ffprobePathFromFfmpeg,
  clearMediaCache,
  type MediaTool,
  type ResolveOptions,
  type FfmpegResolveOptions,
  type FfprobeResolveOptions,
} from "./resolve.js";

export {
  HW_ENCODERS,
  parseHwCapabilities,
  probeHwCapabilities,
  type HwEncoder,
  type HwEncoderId,
  type HwCapabilities,
  type GpuEncoder,
  type GpuDecoder,
  type HwAccel,
} from "./hwaccel.js";

export {
  spawnMedia,
  runMedia,
  runMediaSync,
  getFfmpegVersion,
  summarizeFfmpegError,
  MediaRunError,
  type MediaRunFailure,
  type MediaProcess,
  type RunOptions,
  type RunResult,
  type SyncRunOptions,
  type FfmpegProgress,
} from "./run.js";

export { formatFfmpegTime, parseFfmpegTime, parseFfmpegDuration } from "./time.js";

export {
  probeArgs,
  parseProbeOutput,
  probeMedia,
  mediaDuration,
  videoInfo,
  parseFrameRate,
  pickFrameRate,
  type ProbeResult,
  type ProbeStream,
  type ProbeFormat,
  type VideoInfo,
} from "./probe.js";

export { audioConvertArgs, convertAudio, pcmCodec, type AudioFormat, type AudioConvertOptions } from "./audio.js";

export {
  loudnormArgs,
  parseLoudnorm,
  measureLoudness,
  volumedetectArgs,
  parseVolumedetect,
  measureVolume,
  type LoudnormReport,
  type VolumeReport,
} from "./loudness.js";

export {
  ytDlpDownload,
  ytDlpJson,
  getYtDlpVersion,
  parseYtDlpProgress,
  parseYtDlpVersion,
  ytDlpStaleness,
  classifyYtDlpError,
  parseJsonLines,
  type YtDlpDownloadOptions,
  type YtDlpProgress,
  type YtDlpErrorKind,
  type YtDlpStaleness,
  type YtDlpVersionInfo,
} from "./ytdlp.js";
