// Starting other programs: detached with a log file, as a wrapper that hands
// over its exit code, and opening a URL in the default browser.

import { spawn as nodeSpawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { closeSync, mkdirSync, openSync } from "node:fs";
import { dirname } from "node:path";

export interface SpawnDetachedOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  /**
   * Append the child's stdout and stderr to this file (its folder is created).
   * Without it, output is discarded. The file is opened before the spawn and
   * closed in this process right after, so nothing here holds it.
   */
  log?: string;
  /** "a" (default) appends to `log`; "w" starts it empty. */
  logMode?: "a" | "w";
  /** Run through the shell: needed on Windows for .cmd / .bat files and command strings. */
  shell?: boolean;
  /**
   * Default true: no console window flashes up for a console program. Pass
   * false for GUI apps (Electron, a browser, explorer.exe), whose first window
   * it would hide.
   */
  windowsHide?: boolean;
  /**
   * Called when the program can't be started (ENOENT…), which Node reports
   * asynchronously. A listener is always attached, so a failed start never
   * crashes this process with an unhandled 'error'.
   */
  onError?: (err: Error) => void;
  /** Stands in for child_process.spawn (tests). */
  spawn?: typeof nodeSpawn;
}

/**
 * Start a program that outlives this process: detached, unref'd, stdin
 * ignored, output to `log` or nowhere. Returns the ChildProcess; its `pid` is
 * undefined when the start failed. Listen for 'exit' on it if you care while
 * you're still running. Throws only for a bad call (the log can't be opened,
 * or spawn rejects its arguments, e.g. a .cmd without `shell`).
 */
export function spawnDetached(command: string, args: string[] = [], opts: SpawnDetachedOptions = {}): ChildProcess {
  let fd: number | undefined;
  if (opts.log) {
    mkdirSync(dirname(opts.log), { recursive: true });
    fd = openSync(opts.log, opts.logMode ?? "a");
  }
  const options: SpawnOptions = {
    cwd: opts.cwd,
    env: opts.env,
    shell: opts.shell,
    detached: true,
    stdio: fd === undefined ? "ignore" : ["ignore", fd, fd],
    windowsHide: opts.windowsHide ?? true,
  };
  let child: ChildProcess;
  try {
    child = (opts.spawn ?? nodeSpawn)(command, args, options);
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
  child.on("error", (err) => opts.onError?.(err));
  child.unref();
  return child;
}

export interface RunAndExitOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  shell?: boolean;
}

/**
 * Be a thin wrapper around another program: run it with this terminal
 * (inherited stdio), then exit with its exit code. For launcher scripts
 * (`node scripts/run.mjs dev` → electron-vite with a clean env).
 *
 * Ctrl+C reaches the child straight from the terminal, so this process ignores
 * SIGINT and waits for the child to finish instead of dying first. SIGTERM and
 * SIGHUP sent only to this process are passed on. A child killed by a signal
 * exits this process with 1.
 */
export function runAndExit(command: string, args: string[] = [], opts: RunAndExitOptions = {}): ChildProcess {
  const child = nodeSpawn(command, args, { cwd: opts.cwd, env: opts.env, shell: opts.shell, stdio: "inherit" });
  const ignore = () => {};
  const forward = (signal: NodeJS.Signals) => {
    if (child.exitCode === null && child.signalCode === null) {
      try {
        child.kill(signal);
      } catch {
        /* already gone */
      }
    }
  };
  process.on("SIGINT", ignore);
  process.on("SIGTERM", forward);
  process.on("SIGHUP", forward);
  child.on("exit", (code, signal) => process.exit(signal ? 1 : (code ?? 0)));
  child.on("error", (err) => {
    process.stderr.write(`Could not start ${command}: ${err.message}\n`);
    process.exit(1);
  });
  return child;
}

/** The command that opens `url` with the system's default handler, per platform. */
export function openerFor(url: string, platform: NodeJS.Platform = process.platform): [string, string[]] {
  // Windows: not `cmd /c start "" url`, which splits a URL at its first & (and
  // needs the empty title argument, or it eats the URL). rundll32 hands the URL
  // to the shell's protocol handler as one argument, no cmd parsing.
  if (platform === "win32") return ["rundll32.exe", ["url.dll,FileProtocolHandler", url]];
  if (platform === "darwin") return ["open", [url]];
  return ["xdg-open", [url]];
}

/**
 * Open `url` (or a file path) in the default browser or app. Fire and forget:
 * returns false only when the opener couldn't even be spawned; print the URL
 * too, as the fallback.
 */
export function openUrl(url: string): boolean {
  const [cmd, args] = openerFor(url);
  try {
    spawnDetached(cmd, args, { windowsHide: false });
    return true;
  } catch {
    return false;
  }
}
