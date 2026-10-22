# @btkulka/media-kit

Find and run **ffmpeg**, **ffprobe** and **yt-dlp**. Seven of Ben's apps each had their own way of locating these binaries, spawning them, reading progress and parsing their reports. This package is that code in one place.

What it covers:

- **Resolution:** an env override, then the app's bundled binary, then PATH, then known install dirs, with an optional preference for a GPU-capable ffmpeg. Results are cached.
- **Running:** one spawn wrapper with progress, abort, timeout and tree-kill, plus a sync twin for scripts.
- **ffprobe JSON**, audio conversion, loudness and peak measurement, and hardware-encoder detection.
- **yt-dlp:** downloads with a trustworthy final path, JSON metadata, version and staleness, and error classification.

No runtime dependencies. Dual build: ESM and CommonJS. Node >= 20. Windows first, POSIX kept.

**It never imports `ffmpeg-static`, `ffprobe-static` or `electron`.** The app passes the bundled path in, because a linked package resolves its imports from `D:\source\packages\node_modules`, not from the app:

```ts
const ffmpeg = resolveFfmpeg({ bundled: require('ffmpeg-static') });
```

```json
"dependencies": { "@btkulka/media-kit": "file:../packages/media-kit" }
```

From `nhi/*`, use `file:../../packages/media-kit`.

## API

### Finding binaries

```ts
resolveFfmpeg(opts?: FfmpegResolveOptions): string | null
resolveFfprobe(opts?: FfprobeResolveOptions): string | null
resolveYtDlp(opts?: ResolveOptions): string | null
ffprobePathFromFfmpeg(ffmpegPath: string): string   // same dir, "ffmpeg" -> "ffprobe" in the name
clearMediaCache(): void                             // forget cached paths and hardware probes

interface ResolveOptions {
  envVar?: string | null;   // default FFMPEG_PATH / FFPROBE_PATH / YT_DLP_PATH; null = no override
  bundled?: string | null | (string | null | undefined)[];  // the app's own binary or binaries
  extraDirs?: string[];     // searched after PATH, before the known install dirs
}
interface FfmpegResolveOptions extends ResolveOptions { preferGpu?: boolean }
interface FfprobeResolveOptions extends ResolveOptions { ffmpegPath?: string | null }
```

Each resolver returns an absolute path, or `null` when the binary isn't found. It never returns a bare `"ffmpeg"`. Lookups run in this order:

1. **Env override.** It is authoritative: when the variable is set but points nowhere, the result is `null`, not some other binary. The value can be:
   - a file path (quotes are stripped);
   - a directory, meaning the tool inside it;
   - a command name, looked up on PATH.
2. **`bundled`**, in list order. Missing and `null` entries are skipped. A path inside `app.asar` is read from `app.asar.unpacked`. For ffprobe, the sibling of `opts.ffmpegPath` is tried next.
3. **PATH.** Scanned in-process with PATHEXT, so a `.exe` wins over a `.cmd` shim. No `where` or `which` is spawned.
4. **`extraDirs`.**
5. **Known install dirs.** These matter because a GUI app keeps the PATH it started with, and a macOS app launched from Finder has no Homebrew on its PATH.
   - Windows, for ffmpeg and ffprobe:
     - `%LOCALAPPDATA%\Microsoft\WinGet\Links`
     - `WinGet\Packages\*ffmpeg*\<build>\bin` (Gyan, BtbN, yt-dlp.FFmpeg)
     - `%ProgramFiles%\ffmpeg*\bin`
     - `C:\ffmpeg\bin`
     - `%ProgramData%\chocolatey\bin`
     - `%USERPROFILE%\scoop\shims`
   - Windows, for yt-dlp: WinGet Links, `WinGet\Packages\yt-dlp.yt-dlp*`, chocolatey and scoop.
   - macOS: `/opt/homebrew/bin` and `/usr/local/bin`.
   - Linux: `/usr/local/bin`, `/usr/bin` and `/snap/bin`.

**`preferGpu: true`** (ffmpeg only) is clipdrift's rule: prefer a system ffmpeg with NVENC, CUDA, QSV or AMF over the software-only ffmpeg-static.

- The system binary (the first hit on PATH, then extraDirs, then known dirs) is tried before `bundled`.
- The first candidate whose `-encoders`/`-decoders` output lists a hardware codec wins.
- If none does, the system binary wins.
- It costs one sync probe per candidate, cached per path.

**Caching.** A found path is cached, keyed by the options and the env var's value, and re-checked on disk at each call. A miss isn't cached, so a binary installed while the app runs is found on the next call.

```ts
import { resolveFfmpeg, resolveFfprobe, resolveYtDlp } from '@btkulka/media-kit';

const ffmpeg = resolveFfmpeg({ bundled: require('ffmpeg-static'), preferGpu: true });
if (!ffmpeg) throw new Error('ffmpeg not found: install it (winget install Gyan.FFmpeg) or set FFMPEG_PATH');
const ffprobe = resolveFfprobe({ ffmpegPath: ffmpeg });
const ytdlp = resolveYtDlp({ bundled: [path.join('D:', 'tools', 'ytdlp', 'yt-dlp.exe')] });
```

### Running

```ts
spawnMedia(bin, args, opts?: RunOptions): MediaProcess   // { child, stdin, result: Promise<RunResult>, kill() }
runMedia(bin, args, opts?: RunOptions): Promise<RunResult>
runMediaSync(bin, args, opts?: SyncRunOptions): RunResult
getFfmpegVersion(bin): Promise<string | null>           // first line of -version, null if it can't run
summarizeFfmpegError(stderr): string                     // the line that explains the failure

interface RunResult { code: number | null; signal: NodeJS.Signals | null; stdout: Buffer; stderr: string }
interface RunOptions {
  cwd?; env?;
  timeoutMs?: number;            // kill after this; rejects with reason "timeout"
  signal?: AbortSignal;          // abort kills; rejects with reason "aborted"
  killSignal?: NodeJS.Signals;   // POSIX, default SIGTERM, with SIGKILL 5s later
  stdin?: 'ignore' | 'pipe' | 'inherit';    // default ignore; 'pipe' exposes MediaProcess.stdin
  stdout?: 'pipe' | 'ignore' | 'inherit';   // default pipe, collected as a Buffer
  stderr?: 'pipe' | 'ignore' | 'inherit';   // default pipe, kept as text (last 1 MiB)
  maxBuffer?: number;            // stdout bytes, default 64 MiB; over it kills (reason "maxBuffer")
  check?: boolean;               // default true: a non-zero exit rejects
  onLine?: (line, stream) => void;          // each output line
  onProgress?: (p: FfmpegProgress) => void; // { timeSec, durationSec, percent }
  durationSec?: number;          // total for percent; default: the first "Duration:" in the banner
}
interface SyncRunOptions { cwd?; env?; timeoutMs?; stdio?: 'pipe' | 'inherit'; maxBuffer?; check? }
```

What the spawn wrapper does:

- **No shell and no console window** (`windowsHide`). Arguments pass through as-is, so spaces, `&` and quotes need no escaping.
- **Failures** reject with `MediaRunError`, which carries:
  - `reason`: `spawn`, `exit`, `timeout`, `aborted`, `maxBuffer` or `output`;
  - `code`, `signal` and `stderr`.
  - The message is like `ffmpeg exited with code 1: Invalid data found when processing input`.
- **Settles after exit.** The promise only settles once the process has exited, so on Windows the output file is unlocked and can be deleted.
- **Tree-kill on abort and timeout.** On Windows this uses `taskkill /T /F`, so yt-dlp's ffmpeg child dies too.
- **stdin errors are swallowed.** An EPIPE from writing after ffmpeg has died surfaces as the exit code, not a crash.
- **Progress** is read from two places:
  - stderr `time=` lines, which can be split across chunks and redrawn with `\r`;
  - `-progress pipe:1` key=value lines on stdout (`out_time_us`, `out_time_ms` (also microseconds) and `out_time`).

  It is monotonic, capped at 99 while running, and emits a final `percent: 100` on a clean exit. Without a duration, `percent` is null. With several inputs, pass `durationSec` yourself, because the banner's first `Duration:` is input 0's.
- **`runMediaSync` returns stderr even on success.** That is where volumedetect, loudnorm and the banner are printed. `execFileSync` drops it.

```ts
const proc = spawnMedia(ffmpeg, ['-y', '-i', input, '-c:v', 'libx264', '-progress', 'pipe:1', output], {
  durationSec: video.durationMs / 1000,
  onProgress: ({ percent }) => percent !== null && emit(percent),
});
active.set(id, proc);          // cancel later with proc.kill()
await proc.result;             // rejects with MediaRunError
```

### Time strings

```ts
formatFfmpegTime(seconds): string        // "HH:MM:SS.mmm" for -ss/-t/-to; 59.9996 -> "00:01:00.000", never ":60"
parseFfmpegTime(text): number | null     // "01:02:03.5", "02:03", "12.5", "-00:00:00.02"; "N/A" -> null
parseFfmpegDuration(stderr): number | null  // first "Duration:" in the banner
```

### ffprobe

```ts
probeMedia(ffprobe, file, opts?: { timeoutMs = 30000, signal }): Promise<ProbeResult>  // { format, streams }
probeArgs(file): string[]                // -v error -print_format json -show_format -show_streams
parseProbeOutput(stdout): ProbeResult    // throws SyntaxError on garbage
mediaDuration(probe): number | null      // seconds: container, else longest stream, else mkv DURATION tag
videoInfo(probe): { durationMs, width, height, fps }  // first real video stream; cover art skipped
parseFrameRate(value): number | null     // "30000/1001" -> 29.97; junk, <=0 or >=240 -> null
pickFrameRate(avg, r): number | null     // avg_frame_rate first (r_frame_rate doubles on VFR/interlaced)
```

Sync callers can compose these: `mediaDuration(parseProbeOutput(runMediaSync(ffprobe, probeArgs(f)).stdout))`.

### Audio conversion

```ts
convertAudio(ffmpeg, input, output, opts?: AudioConvertOptions & { timeoutMs, signal, onProgress, durationSec }): Promise<void>
audioConvertArgs(input, output, opts?: AudioConvertOptions): string[]
pcmCodec('wav' | 'aiff', bitDepth = 16): string   // pcm_s24le / pcm_s24be ...

interface AudioConvertOptions {
  format?: 'mp3' | 'wav' | 'aiff';   // default from the extension; giving it also sets -f (for pipe:1 or temp names)
  bitrateKbps?: number;              // mp3 CBR, default 192
  vbrQuality?: number;               // mp3 -q:a instead
  bitDepth?: 16 | 24 | 32;           // wav/aiff, default 16
  sampleRate?: number; channels?: number;
  filters?: string | string[];       // -af, joined with commas
  metadata?: Record<string, string | number | null | undefined>;  // aiff tags written as ID3v2.3
  dropVideo?: boolean;               // -vn, default true (drops cover art)
  quiet?: boolean;                   // -hide_banner -loglevel error
  extraArgs?: string[];              // just before the output
}
```

WAV is little-endian and AIFF big-endian, so a WAV-to-AIFF `-c:a copy` produces static. `pcmCodec` always picks the container's own endianness.

```ts
await convertAudio(ffmpeg, 'take.wav', 'take.mp3', { bitrateKbps: 96, filters: postFilter });
runMediaSync(ffmpeg, audioConvertArgs(src, out, { channels: 1, sampleRate: 24000, filters: af }));
const mp3 = (await runMedia(ffmpeg, audioConvertArgs(file, 'pipe:1', { format: 'mp3', quiet: true }), { maxBuffer: Infinity })).stdout;
```

### Loudness and peak

```ts
measureLoudness(ffmpeg, input, opts?: { maxDurationSec, timeoutMs = 120000, signal }): Promise<LoudnormReport>
measureVolume(ffmpeg, input, opts?): Promise<VolumeReport>
loudnormArgs(input, { maxDurationSec }?)   parseLoudnorm(stderr): LoudnormReport
volumedetectArgs(input)                   parseVolumedetect(stderr): VolumeReport

interface LoudnormReport { inputI: number; inputTp; inputLra; inputThresh; targetOffset }  // all number | null except inputI
interface VolumeReport { meanDb: number | null; maxDb: number | null }
```

- **`parseLoudnorm` throws** when there is no report, and when integrated loudness is `-inf` or `nan` (silent or corrupt audio).
- **`parseVolumedetect` never throws.** `-inf` and missing values become null.
- **Both pass `-vn`**, so a video's frames are not decoded just to measure its audio.

### Hardware encoders

```ts
probeHwCapabilities(ffmpeg, opts?: { timeoutMs, refresh }): Promise<HwCapabilities>  // cached per path, never throws
parseHwCapabilities(encodersOutput, decodersOutput): HwCapabilities
HW_ENCODERS  // h264_nvenc, hevc_nvenc, h264_qsv, h264_amf with label and vendor

interface HwCapabilities {
  encoder: 'h264_nvenc' | 'h264_qsv' | 'h264_amf' | null;   // NVIDIA > Intel > AMD
  decoder: 'h264_cuvid' | 'h264_qsv' | null;
  hwaccel: 'cuda' | 'qsv' | 'd3d11va' | null;
  encoders: HwEncoder[];                                     // every HW_ENCODERS entry this build lists
}
```

Listed means the ffmpeg build knows the codec, not that this machine's GPU can run it, so keep a software fallback. `{ encoder, decoder, hwaccel }` is exactly clipdrift's `GpuCapabilities`.

### yt-dlp

```ts
ytDlpDownload(ytdlp, opts: YtDlpDownloadOptions): Promise<string>   // the finished file's path
ytDlpJson<T>(ytdlp, args, opts?: { timeoutMs, signal, maxBuffer, cwd }): Promise<T[]>
getYtDlpVersion(ytdlp, opts?: { timeoutMs = 5000, now }): Promise<{ version, releasedAt, ageDays, staleness }>
parseYtDlpProgress(line): { percent, downloadedBytes, totalBytes } | null
classifyYtDlpError(stderr): 'extractor' | 'unavailable' | 'network' | 'auth' | 'disk' | 'unknown'
parseYtDlpVersion(stdout): Date | null      ytDlpStaleness(ageDays): 'fresh' | 'aging' | 'stale' | 'unknown'
parseJsonLines<T>(text): T[]

interface YtDlpDownloadOptions {
  url: string; output: string;        // -o template, e.g. path.join(dir, `${base}.%(ext)s`)
  format?: string; args?: string[];   // -f, then anything else (-x --audio-format mp3, --merge-output-format mp4)
  ffmpegPath?: string | null;         // --ffmpeg-location
  ignoreConfig?: boolean;             // --ignore-config, default true
  signal?; timeoutMs?; onProgress?; onLine?; cwd?;
}
```

`ytDlpDownload`:

- **Always adds** `--no-playlist --newline --progress --no-colors`.
- **Reads the final path from `--print-to-file after_move:filepath`.** Guessing it from the template is wrong exactly when yt-dlp picked an extension or merged into another container.
- **Rejects with reason `output`** when the run exits 0 but leaves no file.
- **Abort and timeout** kill yt-dlp and any ffmpeg it is running.

`ytDlpJson`:

- **Adds `--dump-json`** unless a dump flag is already there.
- **A non-zero exit still returns whatever JSON lines printed**, as `--ignore-errors` searches need. It rejects (a `MediaRunError` with `stderr`) only when nothing printed.

```ts
const file = await ytDlpDownload(ytdlp, {
  url, output: path.join(dir, `${base}.%(ext)s`), format: 'bv*+ba/b',
  args: ['--merge-output-format', 'mp4'], ffmpegPath: ffmpeg, signal,
  onProgress: ({ downloadedBytes, totalBytes }) => report(downloadedBytes, totalBytes),
});
const [info] = await ytDlpJson(ytdlp, ['--no-playlist', '--no-warnings', pageUrl], { timeoutMs: 45000 });
```

## Replaces

**Kind of change, in the "Replaced by" column:**

- **Delete** means the copy goes away entirely.
- **Rewrite on** means app-specific arguments or logic stay in the app, running on the package.
- **Stays** means the copy is out of scope and remains in the app.

| App | File | Function / lines | Replaced by |
|---|---|---|---|
| clipdrift | `src/main/services/scanner.ts` | `findInPath` (L381-399), `getFFprobePath` (L401-420), `getFFmpegPath` (L422-435) | Delete. `resolveFfmpeg({ bundled: ffmpegStatic, preferGpu: true })`, `resolveFfprobe({ ffmpegPath })` |
| clipdrift | `src/main/services/scanner.ts` | `parseFps` (L326-334), `probeVideoMetadata` body (L336-375) | Rewrite on `probeMedia` + `videoInfo` (keep the wrapper that throws when duration is missing) |
| clipdrift | `src/mcp-server/utils/paths.ts` | `findInPath`, `getFFprobePath`, `getFFmpegPath` (L14-57); the ffmpeg half of `checkBinaries` | Delete. `resolveFfmpeg`/`resolveFfprobe`; available = `!== null`. Real-ESRGAN lookup stays (its `findInPath` goes to proc-kit) |
| clipdrift | `src/mcp-server/run-upscale.ts` | `findInPath`, `getFFmpegPath`, `getFFprobePath` (L158-174); `getVideoFps` (L210-227) | Delete. `resolve*`; `videoInfo(parseProbeOutput(runMediaSync(ffprobe, probeArgs(f)).stdout)).fps ?? 30` |
| clipdrift | `src/mcp-server/run-upscale.ts` | spawn + `time=` parsing in `spawnExtractFrames` (L260-301), `spawnReencode` (L410-457) | Rewrite on `runMedia(..., { durationSec, onProgress })` (keep the 10% log throttle in the app) |
| clipdrift | `src/mcp-server/run-preview.ts` | L142-153 binary lookup, `getVideoFps` (L185-), `spawnExtractSegment`, `spawnReencode` | Same as run-upscale |
| clipdrift | `scripts/faststart-remux.mjs` | `findFfmpeg` (L47-53); `durationSeconds` (L84-94) | Delete. `resolveFfmpeg()`; `parseFfmpegDuration(runMediaSync(ffmpeg, ['-v','error','-i',f,'-f','null','-'], { check: false }).stderr)` or `mediaDuration` |
| clipdrift | `src/shared/videoProbe.ts` | `parseFrameRate`, `pickFrameRate`, `probeStreamSpecs`, `probeSourceFps`, `ffprobePathFromFfmpeg` | Delete the file. Package functions; `probeStreamSpecs` = `try { videoInfo(await probeMedia(...)) } catch { nulls }` |
| clipdrift | `src/shared/loudness.ts` | `parseLoudnormOutput` | Delete. `parseLoudnorm(stderr).inputI` |
| clipdrift | `src/shared/ffmpegTime.ts` | `formatFFmpegTime` | Delete. `formatFfmpegTime` |
| clipdrift | `src/shared/ffmpegArgs.ts` | `msToFFmpegTime` (L20-29) | `formatFfmpegTime(ms / 1000)`. The other builders stay (upscale-specific) |
| clipdrift | `src/main/worker/ffmpegGpu.ts` | `buildLoudnessArgs` (L173-184) | `loudnormArgs(input, { maxDurationSec })`. The transcode, thumbnail and clip-atom builders stay |
| clipdrift | `src/main/worker/gpuProbe.ts` | `probeGpuCapabilities`, `resetGpuCache` | Delete the file. `probeHwCapabilities(ffmpeg)`, `clearMediaCache()` or `{ refresh: true }` |
| clipdrift | `src/main/worker/tasks/loudnessTask.ts` | `measureLoudness` execFile (L57-71) | `(await measureLoudness(ffmpeg, file, { maxDurationSec: 120 })).inputI` (keep the semaphore) |
| clipdrift | `src/main/services/transcoder.ts` | spawn, progress and settle logic in `transcodeToMp4` (L107-233); `cancelTranscode` kill | `spawnMedia(ffmpeg, args, { durationSec, onProgress })`; store the `MediaProcess`; cancel = `proc.kill()` |
| clipdrift | `src/main/worker/tasks/transcodeTask.ts` | L98-202 (same pattern, plus the GPU retry) | Same; the GPU-retry stays in the app (`err.reason === 'exit'`) |
| clipdrift | `src/main/services/thumbnails.ts` | `execFileAsync` + existence checks (L82-138) | Rewrite on `runMedia(ffmpeg, args, { timeoutMs })`; `MediaRunError` has `code`, `signal`, `stderr` for the log |
| clipdrift | `src/main/worker/tasks/thumbnailTask.ts` | `execFileAsync(ffmpegPath, ...)` (L90-108) | Rewrite on `runMedia(..., { timeoutMs })` |
| clipdrift | `src/main/services/timelineFrames.ts` | `execFileAsync` with buffer (L101-105); `getFFmpegPath` (L149) | Rewrite on `(await runMedia(ffmpeg, args, { timeoutMs, maxBuffer: 10 << 20 })).stdout.toString('base64')` |
| clipdrift | `src/main/services/drift/export.ts` | `msToFFmpegTime` (L81-87), `runFFmpeg` (L89-107) | Delete both. `formatFfmpegTime`, `runMedia` |
| clipdrift | `src/main/services/clipAtoms.ts` | `runFfmpeg` (L194-204); `probeGpuCapabilities` (L264) | Delete. `runMedia`, `probeHwCapabilities` |
| clipdrift | `src/main/services/orphanCleaner.ts` | `getFFmpegPath()` for its own binary dir (L133) | The app's shared resolve call. The wmic logic stays (proc-kit territory) |
| clipdrift | `src/main/worker/workerManager.ts` (L52), `workerEntry.ts` (L127) | `getFFmpegPath`, `probeGpuCapabilities` | The app's shared resolve call; `probeHwCapabilities` |
| clipdrift | `src/main/worker/tasks/upscaleTask.ts`, `clipUpscaleTask.ts` | `probeStreamSpecs`/`probeSourceFps`/`ffprobePathFromFfmpeg` wrappers; `spawn(ffmpegPath)` progress | Package probe functions; optionally `spawnMedia` |
| clipdrift | `src/mcp-server/tools/upscale.tools.ts`, `clip-upscale.tools.ts` | imports of `getFFmpegPath`/`getFFprobePath` | `resolveFfmpeg`/`resolveFfprobe` |
| clipdrift | `src/main/services/ytdlp.ts` | `BINARY_NAME`, `getCandidatePaths`, `findOnPath`, `getYtDlpPath` (L23-90); `parseYtDlpVersion`, `stalenessFor`, the `--version` execFile (L118-169); `classifyYtDlpError` (L181-195) | `resolveYtDlp({ bundled: [...the app's ladder] })`, `getYtDlpVersion`, `ytDlpStaleness`, `classifyYtDlpError`. Keep `getYtDlpInstallDir`, the status cache and `describeYtDlpFailure` (app wording) |
| clipdrift | `src/main/services/discovery/ytdlpResolve.ts` | `probeUrl` execFile `--dump-json` (L171-206) | `ytDlpJson(bin, ['--no-playlist','--no-warnings','--ignore-config', pageUrl], { timeoutMs: PROBE_TIMEOUT_MS, maxBuffer: 32 << 20 })` |
| clipdrift | `src/main/services/acquisition/ytdlpFetch.ts` | `parseYtDlpProgress` (L58-84); `runYtDlp` (L117-202) incl. temp path file, abort, last-line | `parseYtDlpProgress`; `ytDlpDownload`. Keep `buildFormatSelector`, the alternate-URL retry and the `TransferError` mapping |
| clipdrift | tests: `tests/unit/shared/{videoProbe,loudness,ffmpegTime}.test.ts`, the parser parts of `tests/unit/main/services/{ytdlpStatus,downloadTransfer}.test.ts` | | Delete with the copies (the package has these cases). Mocks: see the clipdrift notes |
| candybar-manager | `lib/youtubeDl.mjs` | `run` (L35-57), `findOnPath` (L66-80), `resolveYtDlp` (L96-107, except the download), `resolveFfmpegDir` (L111-118) | `runMedia`; `resolveYtDlp({ extraDirs: [BIN_DIR] })` then the app's own `downloadYtDlp` when null; `resolveFfmpeg({ bundled })` |
| candybar-manager | `lib/youtubeDl.mjs` | `searchYouTube` spawn + JSON-lines parse (L131-163) | `ytDlpJson(bin, ['ytsearch' + limit + ':' + q, '--flat-playlist', '--no-warnings', '--ignore-errors'], { timeoutMs: 120000 })`; keep the item mapping |
| candybar-manager | `lib/youtubeDl.mjs` | `downloadAudioMp3` temp-dir + scan for `.mp3` (L174-205) | `ytDlpDownload(bin, { url, output: path.join(outDir, '%(title)s [%(id)s].%(ext)s'), args: ['-x','--audio-format','mp3','--audio-quality',q,'--restrict-filenames','--no-warnings'], ffmpegPath, timeoutMs: 900000, onProgress })` |
| candybar-manager | `yt-vocal-split.mjs` | (uses `lib/youtubeDl.mjs`) | No direct change. Render `onProgress` (it used to inherit yt-dlp's bar) |
| candybar-manager | `src/lib/trackConverter.ts` | `require('ffmpeg-static')`/`ffprobe-static` (L6-9), `checkFfmpegAvailable` (L28-39), `parseDuration`/`parseTime` (L41-51), `summarizeFfmpegError` (L55-64) | `resolveFfmpeg({ bundled })`; `!== null`; `onProgress`; package `summarizeFfmpegError` (in `MediaRunError.message`) |
| candybar-manager | `src/lib/trackConverter.ts` | `convertToAiff` (L71-121), `reencodeToMp3` (L123-160), `transcodeToMp3Buffer` (L207-233) | `convertAudio(ffmpeg, f, out, { format: 'aiff', bitDepth: 24, sampleRate: 44100, onProgress })`; `convertAudio(..., { bitrateKbps: 320, sampleRate: 44100, dropVideo: false })`; `runMedia(ffmpeg, audioConvertArgs(f, 'pipe:1', { format: 'mp3', bitrateKbps: 192, quiet: true }), { maxBuffer: Infinity }).stdout`. Keep the AIFC check on `err.stderr` |
| candybar-manager | `src/lib/trackScanner.ts` | `require('ffmpeg-static')` (L14); the spawn block in `updateTagsFfmpeg` (L398-416); bits-to-codec (L352-359) | Rewrite on `resolveFfmpeg({ bundled })`, `runMedia`, `pcmCodec('aiff', bits)`. The tag arguments stay |
| candybar-manager | `src/mcp-server.ts` | `require('ffmpeg-static')` + `execFileSync` (L711-731) | Rewrite on `resolveFfmpeg({ bundled })` + `runMedia` (or `runMediaSync`); the art-mapping arguments stay |
| candybar-manager | `apply-xml-matches.mjs` | `require('ffmpeg-static')` (L17), `runFfmpeg` (L27-38), `aiffPcmCodec` (L47-51) | Delete. `resolveFfmpeg({ bundled })`, `runMedia`, `pcmCodec('aiff', bits)` |
| starfall | `tools/add-music.mjs` | `hasFfmpeg` (L105-112), `encode` (L125-132) | `resolveFfmpeg()`; `runMediaSync(ffmpeg, audioConvertArgs(src, dest, { bitrateKbps: 128, filters: fadeFilters() }), { stdio: 'inherit' })` (wav: `{ bitDepth: 16 }`) |
| starfall | `tools/ambient/gen-ambient.mjs` | `hasFfmpeg` (L51), mp3 encode (L69-76) | `resolveFfmpeg()`; `runMediaSync(ffmpeg, audioConvertArgs(wav, mp3, { bitrateKbps: 112, channels: 1, quiet: true }), { check: false })` |
| starfall | `tools/cues/cuePool.mjs` | `applyVnTone` (L270-279), `peakNormalize` volumedetect (L335-348), `cropToVoice` decode + cut (L355-418) | Rewrite on `runMediaSync` with the resolved ffmpeg; `parseVolumedetect(runMediaSync(ffmpeg, volumedetectArgs(src), { check: false }).stderr).maxDb`. Filter chains stay |
| starfall | `tools/cues/gen_seed.mjs` (L64), `gen_vc.mjs` (L79-80, L181), `gen_vn.mjs` (L77, L93, L97) | `execFileSync("ffmpeg", ...)` | `runMediaSync(ffmpeg, audioConvertArgs(src, out, { filters: af, sampleRate: 24000, channels: 1 }))` |
| starfall | `tools/cues/gen_ref_eleven.mjs` | mp3-to-wav (L126), ffprobe duration (L131-133) | `runMediaSync(ffmpeg, audioConvertArgs(tmp, out, { channels: 1, sampleRate: 24000 }))`; `mediaDuration(parseProbeOutput(runMediaSync(ffprobe, probeArgs(out)).stdout))` |
| starfall | `tools/sfx/gen_eleven_sfx.mjs` | `ff` (L128), `peakOfSafe` (L138-146), `durationOf` (L149-156), encodes in `shape` (L187, L194) | `runMediaSync` with the resolved ffmpeg; `parseVolumedetect(...).maxDb`; the probe as above; `audioConvertArgs(tmp, out, { filters: 'volume=' + g + 'dB', vbrQuality: 3, quiet: true })` |
| starfall | `server/routes/cue.ts` | `execFileAsync("ffmpeg", ...)` (L135-140) | `convertAudio(ffmpeg, src, out, { filters: gen.postFilter, bitrateKbps: 96 })` |
| orson | `src/audio/stitch.ts` | `runFfmpeg` (L91-111), `checkFfmpegAvailable` (L78-89) | `runMedia(ffmpeg, args)`; `resolveFfmpeg() !== null` (keep the async signature main.ts awaits). `buildFilter` stays |
| nhi-dashboard | `src/site.js` | `ffmpeg()` (L263-267) | `resolveFfmpeg({ envVar: 'FFMPEG' })` |
| nhi-dashboard | `src/site.js` | `makePreview` encode (L299) | `runMediaSync(bin, audioConvertArgs(src, dest, { quiet: true, sampleRate: 44100, channels: 2, bitrateKbps: 192 }), { cwd })`. `makeCover`/`makeCanvas` keep their arguments (`runMediaSync` or the existing `run`) |
| nhi/lilith | `src/main/ffmpeg.js` | `detect` (L8-14), `HW_ENCODERS` + `detectEncoders` (L22-35) | `resolveFfmpeg()` + `getFfmpegVersion`; `HW_ENCODERS`, `(await probeHwCapabilities(bin)).encoders` |
| nhi/lilith | `src/main/ffmpeg.js` | `spawnEncoder` spawn (L92), `spawnWavCopy` (L98-109) | `spawnMedia(bin, args, { stdin: 'pipe', stdout: 'ignore', check: false, onLine })`; `convertAudio(bin, audio, wav, { bitDepth: 24 })`. `videoCodecArgs` stays |
| nhi/lilith | `src/main/exporter.js` | `checkFfmpeg`, `checkEncoders`, the `proc` lifecycle | Adapt to `MediaProcess`: write to `proc.stdin`, `await proc.result` (with `check: false`, read `code`/`stderr`), cancel = `proc.kill()` |
| nhi/lilith | `main.js` L264, `preload.js` L73, `src/app.js`, `src/ui/exportModal.js` | IPC and UI for the above | No change beyond awaiting async results |
| orson | `scripts/normalize-audio.sh` | two-pass loudnorm in bash | Stays (bash). `measureLoudness` covers pass one if it's ever ported |
| toejam | `tools/encode.py`, `splice.py`, `split_frag.py`, `sync_check.py`, `framecode_check.py` | Python ffmpeg code | Stays (Python) |
| starfall | `tools/analyze-track.py`, `tools/cues/gen_cue.py` | Python | Stays (Python) |

## Migration notes per app

### All apps

- **Get one path and reuse it.** Resolve once (it's cached anyway) and pass the path down. `null` means not installed; turn it into the app's own message. The package returns no fallback `"ffmpeg"` for spawn to fail on later.
- **Error messages read differently.** `MediaRunError.message` is `<tool> exited with code N: <the explanatory line>`. Code that pattern-matches stderr (candybar's AIFC check, clipdrift's `classifyYtDlpError`) must read `err.stderr`, not `err.message`. `err.stderr` keeps the last 1 MiB.
- **Abort and timeout** reject with `err.reason === 'aborted'` or `'timeout'`, only after the process has exited.
- **Mocked tests.** A vitest `vi.mock('child_process')` or `vi.mock('fs')` does not reach a linked package. Mock `@btkulka/media-kit` instead. This affects clipdrift's `scanner.test.ts`, `transcoder.test.ts` and `orphanCleaner.test.ts`.
- **Bundling.** With electron-vite, either keep `@btkulka/media-kit` out of `externalizeDepsPlugin` so it's inlined, or confirm electron-builder ships the linked folder.
- **Packaged apps and `app.asar`.** If `ffmpeg-static` sits inside `app.asar`, it must be in `asarUnpack`. The resolver then finds the `app.asar.unpacked` copy by itself.

### clipdrift (CommonJS via electron-vite; MCP server via tsx)

- **One resolve helper.** Replace the three `getFFmpegPath` copies (scanner, mcp-server/utils/paths, run-upscale/run-preview) with one app-level helper:

  ```ts
  let ffmpegStatic: string | null = null;
  try { ffmpegStatic = require('ffmpeg-static'); } catch { /* not installed */ }
  export const getFfmpeg = () => resolveFfmpeg({ bundled: ffmpegStatic, preferGpu: true });
  export const getFfprobe = () => resolveFfprobe({ ffmpegPath: getFfmpeg() });
  ```

  Pass `process.resourcesPath + '/ffmpeg/ffmpeg.exe'` in `bundled` too, for the electron-builder `extraResources` copy. The old code never looked there.
- **`preferGpu` actually probes now.** The old code assumed any PATH ffmpeg was GPU-capable. On Ben's machine the PATH ffmpeg (`C:\Program Files\ffmpeg-master-latest-win64-gpl\bin`) is picked, as before.
- **ffprobe from a different directory.** The old scanner checked PATH ffprobe first, then the ffmpeg-static sibling. `resolveFfprobe({ ffmpegPath })` tries the sibling of the ffmpeg actually in use first, so ffprobe matches ffmpeg.
- **The GPU cache is per path now.** `probeGpuCapabilities` cached one result globally; `probeHwCapabilities` caches per ffmpeg path. It also returns an extra `encoders` field. `GpuCapabilities` stays assignable.
- **Loudness passes `-vn`, `-hide_banner` and `-nostats`.** The video stream isn't decoded, which makes loudness much faster on video files. Values are unchanged.
- **Error messages change wording.** `drift/export.ts` ended its errors with the last 500 chars of stderr, and `clipAtoms` used the trimmed stderr. Both now get the summary line, with full stderr on `err.stderr`. Log `err.stderr` where the detail mattered.
- **yt-dlp lookup.** Pass the old candidate ladder as `bundled`:
  - `D:\tools\ytdlp\yt-dlp.exe`
  - `userData\ytdlp`
  - `resourcesPath\ytdlp`
  - `exeDir\ytdlp`

  Wrap the `app.getPath` calls in try/catch as before. WinGet Links is now a known dir, so drop it from the ladder; it is searched after PATH instead of before, which finds the same binary in practice. Keep `getYtDlpInstallDir` and `describeYtDlpFailure`.
- **`ytDlpFetch`.**
  - Map `MediaRunError` to `TransferError`:
    - `reason === 'aborted'` becomes `'cancelled'`;
    - `'exit'` becomes `classifyYtDlpError(err.stderr)`, with the last stderr line as the message;
    - `'output'` and anything else become `'unknown'`.
  - `parseYtDlpProgress` now also returns `percent`; pass `{ downloadedBytes, totalBytes }` on.
  - Consider passing `ffmpegPath` so `bv*+ba` merges don't depend on PATH.
  - On Windows, abort now kills yt-dlp's ffmpeg child too.
- **`ytdlpResolve.probeUrl`.** `ytDlpJson` returns items even on a non-zero exit when JSON printed. The old code treated any error as a failure. Check `items.length`. The failure kind comes from `classifyYtDlpError(err.stderr)` in the catch.
- **`formatFfmpegTime`** fixes the `00:00:60.000` rounding edge (59.9996s). Every other input formats as before.

### candybar-manager (CommonJS TS via electron-vite, plus ESM `.mjs` scripts)

- **Bundled binaries.** In TS: `resolveFfmpeg({ bundled: require('ffmpeg-static') })`. In `.mjs`: `createRequire(import.meta.url)('ffmpeg-static')`, or `(await import('ffmpeg-static')).default`. Keep `ffmpeg-static` and `ffprobe-static` as candybar dependencies.
- **`--ffmpeg-location` gets the binary path now, not its directory.** yt-dlp accepts either.
- **yt-dlp lookup.** `resolveYtDlp({ extraDirs: [BIN_DIR] })` searches PATH, then the cache dir, then the known dirs, as the old order did. Keep `downloadYtDlp` and call it when the result is null.
- **A `YT_DLP_PATH` that points nowhere now gives null** (and so triggers the download) instead of falling through to PATH.
- **`--ignore-config` is now on by default.** Ben has no yt-dlp config today. Pass `ignoreConfig: false` to keep the old behaviour exactly.
- **`downloadAudioMp3`.** The temp dir and `.mp3` scan can go, because `ytDlpDownload` returns the real path. Keep `--restrict-filenames`. yt-dlp's own progress bar is gone (it inherited stdio); `yt-vocal-split.mjs` should print `onProgress`.
- **`convertToAiff` now passes `-vn`.** The output is unchanged: checked against ffmpeg N-119929, the AIFF muxer already discarded an mp3's cover art without `-write_id3v2`.
- **`reencodeToMp3`** should pass `dropVideo: false` so the cover art survives, as before.
- **The preview buffer.** `transcodeToMp3Buffer` had no stdout limit. Pass `maxBuffer: Infinity`, because the 64 MiB default can cut off a long mix at 192k.
- **The AIFC check.** Keep `AIFC_CORRUPT_HEADER_PATTERN.test(err.stderr)` on the caught `MediaRunError`.

### starfall (ESM; tools are sync scripts)

- **Resolve once per script** with `resolveFfmpeg()` and `resolveFfprobe({ ffmpegPath })`, and replace each bare `"ffmpeg"`/`"ffprobe"` with the result. Before, only PATH was used; now WinGet and Program Files are found even when PATH is stale.
- **`hasFfmpeg` becomes `resolveFfmpeg() !== null`.** Before, it ran `ffmpeg -version`.
- **Use `runMediaSync`** where the code is sync. It returns stderr on success, which fixes the `execFileSync` volumedetect gotcha `gen_eleven_sfx.mjs` documents.
- **`audioConvertArgs` adds `-vn`.** That is harmless for wav sources. For an mp3 source with art in `add-music.mjs`, pass `dropVideo: false` if the art should be kept.
- **`server/routes/cue.ts`** can use async `convertAudio`. The `preflight` in `server/cueGenerators.ts` could become `resolveFfmpeg() !== null`.

### orson (ESM; main bundled to CJS by electron-vite)

- **`checkFfmpegAvailable()` becomes `resolveFfmpeg() !== null`.** Keep it async for `main.ts`.
- **`runFfmpeg` becomes `runMedia(ffmpeg, args)`.** The rejection message is now the summary line, not the last 10 stderr lines; the full text is in `err.stderr`.
- **Orson may now find ffmpeg where it didn't before.** It used to spawn bare `ffmpeg` from PATH, and now also searches the known dirs. The "ffmpeg not found on PATH" text is still close enough.

### nhi-dashboard (CommonJS)

- **Pass `envVar: 'FFMPEG'`** to keep its existing variable. `FFMPEG_PATH` is then not consulted.
- **`tests/site.test.js` keeps working.** It sets `FFMPEG` to a missing path, and that still yields null, because the override is authoritative.
- **No `-version` check any more.** `ffmpeg()` used to run `-version`; resolution only checks that the file exists.

### nhi/lilith (CommonJS, Electron)

- **`detect()` becomes async** (`resolveFfmpeg` + `getFfmpegVersion`). The `export:check-ffmpeg` IPC handler can return the promise.
- **`detectEncoders()`** becomes `probeHwCapabilities(bin)`. Its `.encoders` has the same ids, labels and vendors as lilith's `HW_ENCODERS`.
- **`spawnEncoder` becomes `spawnMedia(bin, args, { stdin: 'pipe', stdout: 'ignore', check: false, onLine })`.**
  - The old `onStderr` chunks become `onLine` lines.
  - `proc.stdin` swallows EPIPE.
  - `finish()` does `proc.stdin.end()` then `const { code, stderr } = await proc.result`.
  - `cancel()` does `proc.kill()`, which then rejects with reason `'aborted'`: catch it and report `cancelled`.
- **Lilith spawned bare `ffmpeg`.** Now it resolves known dirs as well.

## Not shared, and why

- **Thumbnail and frame extraction, concat demuxer and list escaping, faststart remux.** Only clipdrift does these. It has three internal thumbnail copies, which already share its `formatFFmpegTime`.
- **Hardware video-encoder argument presets.** clipdrift's `buildTranscodeArgs` and `buildClipAtomArgs` use constant quality (`-cq`, preset p4). lilith's `videoCodecArgs` uses bitrate (preset p5, `-tune hq`). Unifying them would change one app's encodes. Only the detection is shared.
- **Real-ESRGAN and RIFE lookup.** Not media binaries, and clipdrift only. Their `findInPath` copies go to proc-kit's `findExecutable`.
- **Orphan-process cleanup (wmic).** clipdrift only, and proc-kit's domain.
- **yt-dlp auto-download.** Candybar only; clipdrift deliberately refuses to install binaries. **yt-dlp format selector** (clipdrift), **YouTube search mapping** (candybar) and **`describeYtDlpFailure`** (app wording) stay in their apps.
- **Candybar's tag-writing arguments and AIFC header repair**, **orson's seamless-loop graph**, **nhi-dashboard's cover and canvas filters**, and **starfall's voice character chains** are app-specific.
- **Concurrency limits (semaphores).** These are app policy.

## Internals

- **PATH lookup and tree kill come from `@btkulka/proc-kit`** (`findExecutable`, `killTree`). An app that bundles media-kit gets proc-kit inlined with it. An app that ships `node_modules` unbundled must ship proc-kit too.
- **Tests.** `npm test` runs `node:test` against fakes: a Node script stands in for ffmpeg, and temp dirs stand in for PATH and the install dirs. Nothing real is needed.
- **Real-binary tests.** `MEDIA_KIT_REAL=1 npm test` runs them against the real ffmpeg, ffprobe and yt-dlp (PowerShell: `$env:MEDIA_KIT_REAL = "1"; npm test`). They stay offline: media comes from lavfi, and yt-dlp reads a `file://` URL.
