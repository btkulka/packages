// Running ffmpeg, ffprobe and yt-dlp: one spawn wrapper with progress, abort,
// timeout and an error that carries the stderr, plus a sync twin for scripts.

import path from "node:path";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import type { Writable } from "node:stream";
import { killTree } from "@btkulka/proc-kit";
import { parseFfmpegDuration, parseFfmpegTime } from "./time.js";

export type MediaRunFailure = "spawn" | "exit" | "timeout" | "aborted" | "maxBuffer" | "output";

/** Thrown (or rejected) when a media binary fails. `stderr` is the captured tail. */
export class MediaRunError extends Error {
  readonly bin: string;
  readonly args: readonly string[];
  /** Exit code, or null when the process was killed or never started. */
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stderr: string;
  /** Why it failed: couldn't start, non-zero exit, timed out, aborted, stdout over maxBuffer, or unusable output. */
  readonly reason: MediaRunFailure;

  constructor(
    message: string,
    init: {
      bin: string;
      args: readonly string[];
      code?: number | null;
      signal?: NodeJS.Signals | null;
      stderr?: string;
      reason: MediaRunFailure;
      cause?: unknown;
    },
  ) {
    super(message, init.cause !== undefined ? { cause: init.cause } : undefined);
    this.name = "MediaRunError";
    this.bin = init.bin;
    this.args = init.args;
    this.code = init.code ?? null;
    this.signal = init.signal ?? null;
    this.stderr = init.stderr ?? "";
    this.reason = init.reason;
  }
}

/**
 * The most informative line of ffmpeg (or yt-dlp) stderr, so a UI can show
 * something better than "exited with code 1": the last line that reads as an
 * error, else the last line, with the `[aiff @ 0x...]` prefix stripped.
 */
export function summarizeFfmpegError(stderr: string): string {
  const lines = String(stderr ?? "")
    .split(/\r\n|\r|\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  const signal = lines.filter(
    (l) =>
      /^\[[^\]]+\]\s+(error|could not|invalid|unsupported|unknown or unsupported)/i.test(l) ||
      /^(error|invalid data|no such file|permission denied|unable|failed|unsupported|conversion failed)/i.test(l),
  );
  const picked = signal.pop() ?? lines.pop() ?? "";
  return picked.replace(/^\[[^\]]+\]\s*/, "").slice(0, 300);
}

/** Progress of an ffmpeg run. */
export interface FfmpegProgress {
  /** Output time processed so far, in seconds. */
  timeSec: number;
  /** Total duration in seconds, when known (passed in, or read from the banner). */
  durationSec: number | null;
  /** 0-99 while running and 100 once it exits cleanly; null while the duration is unknown. */
  percent: number | null;
}

export interface RunOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  /** Kill the process after this long. Default: no timeout. */
  timeoutMs?: number;
  /** Abort kills the process; the run rejects with reason "aborted". */
  signal?: AbortSignal;
  /** Signal for abort and timeout on POSIX. Default SIGTERM (yt-dlp removes its .part files on it); SIGKILL follows after 5s. Windows always force-kills the tree. */
  killSignal?: NodeJS.Signals;
  /** Default "ignore". "pipe" exposes `MediaProcess.stdin` (raw frames into ffmpeg). */
  stdin?: "ignore" | "pipe" | "inherit";
  /** Default "pipe": collected into `RunResult.stdout`. */
  stdout?: "pipe" | "ignore" | "inherit";
  /** Default "pipe": collected (tail) into `RunResult.stderr` and parsed for progress. */
  stderr?: "pipe" | "ignore" | "inherit";
  /** Most stdout bytes to collect before the process is killed. Default 64 MiB. */
  maxBuffer?: number;
  /** Reject on a non-zero exit. Default true. With false, inspect `RunResult.code`. */
  check?: boolean;
  /** Each complete line of output. stdout is only split into lines when this is set. */
  onLine?: (line: string, stream: "stdout" | "stderr") => void;
  /** ffmpeg progress, from stderr `time=` and from `-progress pipe:1` key=value output on stdout. */
  onProgress?: (p: FfmpegProgress) => void;
  /** Total duration for `percent`. Default: the first `Duration:` ffmpeg prints. */
  durationSec?: number;
}

export interface RunResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: Buffer;
  stderr: string;
}

export interface MediaProcess {
  child: ChildProcess;
  /** The child's stdin when `stdin: "pipe"`; write errors (EPIPE when ffmpeg dies) are swallowed and surface as the exit code. */
  stdin: Writable | null;
  /** Settles once the process has exited, so the output file is no longer locked. */
  result: Promise<RunResult>;
  /** Kill the process tree. The result rejects with reason "aborted". */
  kill(): void;
}

const STDERR_KEEP = 1024 * 1024;
const DEFAULT_MAX_BUFFER = 64 * 1024 * 1024;
const KILL_GRACE_MS = 5000;

function toolName(bin: string): string {
  return path.basename(bin).replace(/\.exe$/i, "") || bin;
}

/** Splits a byte stream into lines on \n, \r\n or a bare \r (ffmpeg redraws its stats line with \r). */
class LineSplitter {
  private rest = "";
  constructor(private readonly onLine: (line: string) => void) {}
  push(text: string): void {
    const parts = (this.rest + text).split(/\r\n|\r|\n/);
    this.rest = parts.pop() ?? "";
    for (const p of parts) this.onLine(p);
  }
  flush(): void {
    if (this.rest) this.onLine(this.rest);
    this.rest = "";
  }
}

/** Turns ffmpeg output lines into monotonic progress events. */
class ProgressTracker {
  private durationSec: number | null;
  private lastTime = -1;
  private lastPercent = -1;
  private banner = "";

  constructor(
    private readonly emit: (p: FfmpegProgress) => void,
    durationSec: number | undefined,
  ) {
    this.durationSec = durationSec && durationSec > 0 ? durationSec : null;
  }

  stderrLine(line: string): void {
    if (this.durationSec === null && this.banner.length < 64 * 1024) {
      this.banner += line + "\n";
      const d = parseFfmpegDuration(line);
      if (d && d > 0) this.durationSec = d;
    }
    const m = /time=\s*(-?[\d:.]+)/.exec(line);
    if (m) this.time(parseFfmpegTime(m[1]));
  }

  /** `-progress pipe:1` lines. out_time_ms is microseconds too (an old ffmpeg naming bug). */
  progressLine(line: string): void {
    const m = /^(out_time_us|out_time_ms|out_time)=(.+)$/.exec(line.trim());
    if (!m) return;
    if (m[1] === "out_time") this.time(parseFfmpegTime(m[2]));
    else {
      const us = Number(m[2]);
      this.time(Number.isFinite(us) ? us / 1e6 : null);
    }
  }

  private time(t: number | null): void {
    if (t === null || !Number.isFinite(t) || t < 0 || t <= this.lastTime) return;
    this.lastTime = t;
    const percent = this.durationSec ? Math.min(99, Math.max(0, Math.round((t / this.durationSec) * 100))) : null;
    if (percent !== null) {
      if (percent <= this.lastPercent) return;
      this.lastPercent = percent;
    }
    this.emit({ timeSec: t, durationSec: this.durationSec, percent });
  }

  done(): void {
    const t = this.durationSec ?? Math.max(0, this.lastTime);
    this.emit({ timeSec: t, durationSec: this.durationSec, percent: 100 });
  }
}

function hasProgressPipe(args: readonly string[]): boolean {
  for (let i = 0; i < args.length - 1; i++) {
    if (args[i] === "-progress" && /^(pipe:1|-)$/.test(args[i + 1])) return true;
  }
  return false;
}

/**
 * Start ffmpeg, ffprobe or yt-dlp without a shell (arguments pass through as-is,
 * so paths with spaces, `&` or quotes need no escaping) and with no console window.
 */
export function spawnMedia(bin: string, args: readonly string[], opts: RunOptions = {}): MediaProcess {
  const name = toolName(bin);
  const argv = [...args];
  const fail = (message: string, reason: MediaRunFailure, extra: Partial<ConstructorParameters<typeof MediaRunError>[1]> = {}) =>
    new MediaRunError(message, { bin, args: argv, reason, ...extra });

  if (opts.signal?.aborted) {
    const err = fail(`${name} was aborted before it started`, "aborted");
    const result = Promise.reject(err);
    result.catch(() => {});
    return { child: null as unknown as ChildProcess, stdin: null, result, kill: () => {} };
  }

  let child: ChildProcess;
  try {
    child = spawn(bin, argv, {
      cwd: opts.cwd,
      env: opts.env,
      windowsHide: true,
      shell: false,
      stdio: [opts.stdin ?? "ignore", opts.stdout ?? "pipe", opts.stderr ?? "pipe"],
    });
  } catch (cause) {
    // spawn throws synchronously for some failures (bad arguments, EACCES) before
    // any 'error' listener exists.
    const err = fail(`Failed to start ${name}: ${(cause as Error)?.message ?? cause}`, "spawn", { cause });
    const result = Promise.reject(err);
    result.catch(() => {});
    return { child: null as unknown as ChildProcess, stdin: null, result, kill: () => {} };
  }

  child.stdin?.on("error", () => {
    /* EPIPE once ffmpeg has exited; the exit code tells the story */
  });

  const stdoutChunks: Buffer[] = [];
  let stdoutBytes = 0;
  let stderr = "";
  let failure: { reason: MediaRunFailure; message: string } | null = null;
  let killTimer: NodeJS.Timeout | null = null;
  let timeoutTimer: NodeJS.Timeout | null = null;

  const progress = opts.onProgress ? new ProgressTracker(opts.onProgress, opts.durationSec) : null;
  const progressOnStdout = progress !== null && hasProgressPipe(argv);

  const stderrLines = new LineSplitter((line) => {
    progress?.stderrLine(line);
    opts.onLine?.(line, "stderr");
  });
  const stdoutLines =
    opts.onLine || progressOnStdout
      ? new LineSplitter((line) => {
          if (progressOnStdout) progress?.progressLine(line);
          opts.onLine?.(line, "stdout");
        })
      : null;

  let exited = false;
  child.on("exit", () => {
    exited = true;
  });

  // On Windows child.kill() only stops the direct child, so yt-dlp aborted mid-merge
  // would leave its ffmpeg running and holding the output file: take the whole tree.
  const stopTree = (proc: ChildProcess, signal: NodeJS.Signals) => {
    if (process.platform === "win32" && proc.pid) {
      void killTree(proc.pid).then((ok) => {
        if (!ok) try { proc.kill(signal); } catch { /* gone */ }
      });
      return;
    }
    try { proc.kill(signal); } catch { /* gone */ }
  };

  const stopWith = (reason: MediaRunFailure, message: string) => {
    // Once the process is gone its pid may be reused; never kill after exit.
    if (failure || exited) return;
    failure = { reason, message };
    stopTree(child, opts.killSignal ?? "SIGTERM");
    killTimer = setTimeout(() => {
      try { child.kill("SIGKILL"); } catch { /* gone */ }
    }, KILL_GRACE_MS);
    killTimer.unref?.();
  };

  const maxBuffer = opts.maxBuffer ?? DEFAULT_MAX_BUFFER;
  child.stdout?.on("data", (chunk: Buffer) => {
    stdoutBytes += chunk.length;
    if (stdoutBytes > maxBuffer) {
      stopWith("maxBuffer", `${name} wrote more than ${maxBuffer} bytes to stdout`);
      return;
    }
    stdoutChunks.push(chunk);
    stdoutLines?.push(chunk.toString("utf8"));
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    const text = chunk.toString("utf8");
    stderr += text;
    if (stderr.length > STDERR_KEEP) stderr = stderr.slice(-STDERR_KEEP);
    stderrLines.push(text);
  });

  const onAbort = () => stopWith("aborted", `${name} was aborted`);
  opts.signal?.addEventListener("abort", onAbort, { once: true });
  if (opts.timeoutMs && opts.timeoutMs > 0) {
    timeoutTimer = setTimeout(() => stopWith("timeout", `${name} timed out after ${opts.timeoutMs}ms`), opts.timeoutMs);
  }

  const result = new Promise<RunResult>((resolve, reject) => {
    let settled = false;
    const cleanup = () => {
      opts.signal?.removeEventListener("abort", onAbort);
      if (timeoutTimer) clearTimeout(timeoutTimer);
      if (killTimer) clearTimeout(killTimer);
    };

    child.on("error", (cause) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(fail(`Failed to start ${name}: ${cause.message}`, "spawn", { cause, stderr }));
    });

    child.on("close", (code, signal) => {
      if (settled) return;
      settled = true;
      cleanup();
      stderrLines.flush();
      stdoutLines?.flush();
      const out: RunResult = { code, signal, stdout: Buffer.concat(stdoutChunks), stderr };
      if (failure) {
        reject(fail(failure.message, failure.reason, { code, signal, stderr }));
        return;
      }
      if (code === 0) {
        progress?.done();
        resolve(out);
        return;
      }
      if (opts.check === false) {
        resolve(out);
        return;
      }
      const summary = summarizeFfmpegError(stderr);
      const what = code !== null ? `exited with code ${code}` : `was killed by ${signal ?? "a signal"}`;
      reject(fail(`${name} ${what}${summary ? `: ${summary}` : ""}`, "exit", { code, signal, stderr }));
    });
  });
  result.catch(() => {});

  return {
    child,
    stdin: child.stdin ?? null,
    result,
    kill: () => stopWith("aborted", `${name} was aborted`),
  };
}

/** Run a media binary to completion. Rejects with `MediaRunError`. */
export function runMedia(bin: string, args: readonly string[], opts: RunOptions = {}): Promise<RunResult> {
  return spawnMedia(bin, args, opts).result;
}

export interface SyncRunOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  /** Default "pipe" (captured). "inherit" shows ffmpeg's own output in the terminal. */
  stdio?: "pipe" | "inherit";
  /** Default 64 MiB, for stdout and stderr each. */
  maxBuffer?: number;
  /** Throw on a non-zero exit. Default true. */
  check?: boolean;
}

/**
 * Synchronous run for scripts that are synchronous throughout. Unlike
 * execFileSync, the result carries stderr on success too, which is where
 * volumedetect, loudnorm and the banner write their reports.
 */
export function runMediaSync(bin: string, args: readonly string[], opts: SyncRunOptions = {}): RunResult {
  const name = toolName(bin);
  const argv = [...args];
  const r = spawnSync(bin, argv, {
    cwd: opts.cwd,
    env: opts.env,
    windowsHide: true,
    shell: false,
    timeout: opts.timeoutMs && opts.timeoutMs > 0 ? opts.timeoutMs : undefined,
    maxBuffer: opts.maxBuffer ?? DEFAULT_MAX_BUFFER,
    stdio: opts.stdio === "inherit" ? "inherit" : ["ignore", "pipe", "pipe"],
  });
  const stdout = r.stdout ? Buffer.from(r.stdout) : Buffer.alloc(0);
  const stderr = r.stderr ? Buffer.from(r.stderr).toString("utf8") : "";
  const base = { bin, args: argv, code: r.status, signal: r.signal, stderr };
  if (r.error) {
    const code = (r.error as NodeJS.ErrnoException).code;
    if (code === "ETIMEDOUT") throw new MediaRunError(`${name} timed out after ${opts.timeoutMs}ms`, { ...base, reason: "timeout", cause: r.error });
    if (code === "ENOBUFS") throw new MediaRunError(`${name} wrote more than maxBuffer`, { ...base, reason: "maxBuffer", cause: r.error });
    throw new MediaRunError(`Failed to start ${name}: ${r.error.message}`, { ...base, reason: "spawn", cause: r.error });
  }
  if (r.status !== 0 && opts.check !== false) {
    const summary = summarizeFfmpegError(stderr);
    const what = r.status !== null ? `exited with code ${r.status}` : `was killed by ${r.signal ?? "a signal"}`;
    throw new MediaRunError(`${name} ${what}${summary ? `: ${summary}` : ""}`, { ...base, reason: "exit" });
  }
  return { code: r.status, signal: r.signal, stdout, stderr };
}

/**
 * The first line `-version` prints (`ffmpeg version 7.1-full_build ...`), or null
 * when the binary is missing or broken. Works for ffmpeg and ffprobe.
 */
export async function getFfmpegVersion(bin: string, opts: { timeoutMs?: number } = {}): Promise<string | null> {
  try {
    const { stdout } = await runMedia(bin, ["-version"], { timeoutMs: opts.timeoutMs ?? 10_000 });
    return stdout.toString("utf8").split(/\r?\n/).map((l) => l.trim()).find(Boolean) ?? null;
  } catch {
    return null;
  }
}
