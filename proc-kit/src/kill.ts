// Killing a process and everything it started.
//
// Windows: `taskkill /PID <pid> /T /F`. /T walks the tree by parent pid, which is
// the only thing that reaches the real server behind a `shell: true` cmd.exe, an
// npm.cmd shim or a `node --watch` runner; child.kill() would stop the wrapper and
// orphan the rest, still holding its port. /F because console programs refuse a
// polite taskkill ("can only be terminated forcefully").
//
// POSIX: signal the process group (-pid), which exists when the process was
// spawned with `detached: true`; otherwise the single pid.

import { spawnSync } from "node:child_process";
import { isWindows, run, system32 } from "./system.js";
import { sleep } from "./wait.js";

/**
 * True while `pid` is running. `process.kill(pid, 0)` works on Windows too
 * (OpenProcess + exit-code check); EPERM means it exists but belongs to someone
 * else, so it counts as alive.
 */
export function isAlive(pid: number): boolean {
  if (!validPid(pid)) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

export interface KillTreeOptions {
  /**
   * Ask nicely first and wait up to this long before forcing. Windows: a plain
   * `taskkill /T` (closes GUI windows, so Electron quits cleanly; console
   * programs can't be asked, so for them this only delays the /F), then `/F`.
   * POSIX: SIGTERM, then SIGKILL. Default 0: force at once.
   */
  graceMs?: number;
}

/**
 * Kill `pid` and its descendants. Resolves true when it killed the process,
 * false when it was already gone, the pid is invalid, or it couldn't be killed
 * (another user's process). Never throws.
 *
 * Kill the tree while its root is alive: on Windows, children whose parent has
 * already exited are no longer linked to it, so /T can't find them. Use
 * `freePort` (by port) or `listProcesses` for those.
 */
export async function killTree(pid: number, opts: KillTreeOptions = {}): Promise<boolean> {
  if (!validPid(pid)) return false;
  const graceMs = Math.max(0, opts.graceMs ?? 0);
  if (isWindows()) {
    // taskkill's exit code can't tell "no such process" from "refused" (both can
    // be 128 with /T), so ask the OS first.
    if (!isAlive(pid)) return false;
    const taskkill = system32("taskkill.exe");
    if (graceMs > 0) {
      // Without /F, taskkill closes GUI windows (Electron quits cleanly); console
      // programs refuse it, and simply get forced once the grace period is up.
      await run(taskkill, ["/PID", String(pid), "/T"], 15_000);
      if (await waitGone(pid, graceMs)) return true;
    }
    const forced = await run(taskkill, ["/PID", String(pid), "/T", "/F"], 15_000);
    // Not ok: part of the tree refused (another user's process) or it exited meanwhile.
    return forced.ok || !isAlive(pid);
  }
  if (graceMs > 0) {
    if (!signalTree(pid, "SIGTERM")) return false;
    if (await waitGone(pid, graceMs)) return true;
    signalTree(pid, "SIGKILL");
    return true;
  }
  return signalTree(pid, "SIGKILL");
}

/**
 * Synchronous, immediate force-kill of `pid` and its descendants, for exit
 * handlers (`process.on("exit")`) where nothing async runs. Same return as
 * `killTree`.
 */
export function killTreeSync(pid: number): boolean {
  if (!validPid(pid)) return false;
  if (isWindows()) {
    const r = spawnSync(system32("taskkill.exe"), ["/PID", String(pid), "/T", "/F"], {
      stdio: "ignore",
      windowsHide: true,
      timeout: 15_000,
    });
    return r.status === 0;
  }
  return signalTree(pid, "SIGKILL");
}

/** POSIX: signal the group, falling back to the pid. True when something was signalled. */
function signalTree(pid: number, signal: NodeJS.Signals): boolean {
  // pid 1 would make -pid = -1: every process we may signal. Never.
  if (pid > 1) {
    try {
      process.kill(-pid, signal);
      return true;
    } catch {
      /* not a group leader (spawned without detached), or gone: try the pid */
    }
  }
  try {
    process.kill(pid, signal);
    return true;
  } catch {
    return false;
  }
}

async function waitGone(pid: number, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (!isAlive(pid)) return true;
    await sleep(Math.min(100, Math.max(1, deadline - Date.now())));
  }
  return !isAlive(pid);
}

const validPid = (pid: number): boolean => Number.isInteger(pid) && pid > 0;
