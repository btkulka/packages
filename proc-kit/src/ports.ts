// Who is listening on a TCP port, whether anything answers there, and freeing it.
//
// Windows uses `netstat -ano` (about 50 ms; Get-NetTCPConnection costs a
// PowerShell start, 1.5 s). Not `netstat -p tcp`: that lists IPv4 only, so it
// misses a Vite that binds just [::1]. POSIX uses `lsof`.

import { createConnection } from "node:net";
import { isWindows, run, runSync, system32 } from "./system.js";
import { killTree } from "./kill.js";
import { waitFor } from "./wait.js";

const netstatArgs = ["-ano"];
const lsofArgs = (port: number) => ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"];

/**
 * PIDs listening on `port` in `netstat -ano` output, IPv4 and IPv6 alike.
 * Matches the local port exactly (5173 never matches 51730 or 15173). A row
 * counts as listening when its state says LISTENING, or, so a localized Windows
 * still works, when its foreign address is the 0.0.0.0:0 / [::]:0 wildcard.
 */
export function parseNetstat(output: string, port: number): number[] {
  const pids = new Set<number>();
  for (const line of String(output).split(/\r?\n/)) {
    const cols = line.trim().split(/\s+/);
    if (cols.length !== 5 || cols[0].toUpperCase() !== "TCP") continue;
    const [, local, foreign, state, pidText] = cols;
    const m = /:(\d+)$/.exec(local);
    if (!m || Number(m[1]) !== port) continue;
    const listening = state.toUpperCase() === "LISTENING" || /^(0\.0\.0\.0|\[::\]|\*):0$/.test(foreign);
    if (!listening) continue;
    const pid = Number(pidText);
    if (Number.isInteger(pid) && pid > 0) pids.add(pid);
  }
  return [...pids].sort((a, b) => a - b);
}

/** PIDs in `lsof -t` output (one per line). */
export function parseLsof(output: string): number[] {
  const pids = new Set<number>();
  for (const tok of String(output).split(/\s+/)) {
    const pid = Number(tok);
    if (tok && Number.isInteger(pid) && pid > 0) pids.add(pid);
  }
  return [...pids].sort((a, b) => a - b);
}

/**
 * PIDs listening on TCP `port` on any address, IPv4 or IPv6. Empty when nothing
 * listens or the lookup tool is missing (no `lsof`). Never throws. Includes this
 * process if it's the listener. On Windows a port served by http.sys shows pid 4
 * (System).
 */
export async function pidsOnPort(port: number): Promise<number[]> {
  if (isWindows()) {
    const r = await run(system32("netstat.exe"), netstatArgs);
    return parseNetstat(r.stdout, port);
  }
  // lsof exits 1 when nothing matches, with empty output.
  const r = await run("lsof", lsofArgs(port));
  return parseLsof(r.stdout);
}

/** Synchronous `pidsOnPort`, for scripts and exit paths. Never throws. */
export function pidsOnPortSync(port: number): number[] {
  if (isWindows()) return parseNetstat(runSync(system32("netstat.exe"), netstatArgs).stdout, port);
  return parseLsof(runSync("lsof", lsofArgs(port)).stdout);
}

export interface ProbePortOptions {
  /**
   * Host(s) to connect to. Default both loopbacks, ["127.0.0.1", "::1"], tried
   * in parallel: Vite binds only ::1, most servers only 127.0.0.1, and checking
   * one family reports the other's server as down.
   */
  host?: string | string[];
  /** Connect timeout. Default 1000. */
  timeoutMs?: number;
}

/** True when a TCP connection to `port` succeeds on any of the hosts. Never throws. */
export async function probePort(port: number, opts: ProbePortOptions = {}): Promise<boolean> {
  const hosts = opts.host === undefined ? ["127.0.0.1", "::1"] : Array.isArray(opts.host) ? opts.host : [opts.host];
  const timeoutMs = Math.max(1, opts.timeoutMs ?? 1000);
  const results = await Promise.all(hosts.map((host) => connectOnce(port, host, timeoutMs)));
  return results.some(Boolean);
}

function connectOnce(port: number, host: string, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection({ port, host });
    let settled = false;
    const done = (ok: boolean) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeoutMs, () => done(false));
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
  });
}

export interface WaitForPortOptions {
  /** As in `probePort`. Default both loopbacks. */
  host?: string | string[];
  /** Give up after this long. Default 30 000. */
  timeoutMs?: number;
  /** Connect timeout per attempt. Default 1000. */
  connectTimeoutMs?: number;
  /** Pause between attempts. Default 250. */
  intervalMs?: number;
  signal?: AbortSignal;
}

/** Poll until something accepts connections on `port` (true) or the timeout passes (false). */
export function waitForPort(port: number, opts: WaitForPortOptions = {}): Promise<boolean> {
  const probe: ProbePortOptions = { host: opts.host, timeoutMs: opts.connectTimeoutMs };
  return waitFor(() => probePort(port, probe), { timeoutMs: opts.timeoutMs, intervalMs: opts.intervalMs, signal: opts.signal });
}

export interface WaitForPortFreeOptions {
  /** Give up after this long. Default 5000. */
  timeoutMs?: number;
  /** Pause between checks. Default 250. */
  intervalMs?: number;
  signal?: AbortSignal;
}

/**
 * Poll until nothing listens on `port` (true) or the timeout passes (false).
 * A killed listener takes a moment to release its port, a CUDA process (ComfyUI,
 * koboldcpp) longer still. "Free" means no LISTENING socket, from `pidsOnPort`.
 */
export function waitForPortFree(port: number, opts: WaitForPortFreeOptions = {}): Promise<boolean> {
  return waitFor(async () => (await pidsOnPort(port)).length === 0, {
    timeoutMs: opts.timeoutMs ?? 5000,
    intervalMs: opts.intervalMs,
    signal: opts.signal,
  });
}

export interface FreePortOptions {
  /** PIDs never to kill. This process is always spared. */
  exclude?: number[];
  /** Ask the listeners to exit first and wait this long before forcing (see `killTree`). Default 0. */
  graceMs?: number;
  /** How long to wait for the port to be released after the kills. Default 5000. */
  timeoutMs?: number;
}

export interface FreePortResult {
  /** Listeners whose trees were killed. */
  killed: number[];
  /** Listeners not killed: excluded, this process, System (pid 4), already gone, or not ours to kill. */
  skipped: number[];
  /** Nothing listens on the port any more. */
  free: boolean;
}

/**
 * Kill every process tree listening on `port`, then wait for the port to be
 * released. Probe first if a healthy listener should be kept (attach to it
 * instead): this kills whatever is there.
 */
export async function freePort(port: number, opts: FreePortOptions = {}): Promise<FreePortResult> {
  const spare = new Set([process.pid, ...(opts.exclude ?? [])]);
  const killed: number[] = [];
  const skipped: number[] = [];
  const pids = await pidsOnPort(port);
  if (pids.length === 0) return { killed, skipped, free: true };
  let spared = false;
  for (const pid of pids) {
    if (spare.has(pid) || pid <= 4) {
      skipped.push(pid);
      spared = true;
      continue;
    }
    if (await killTree(pid, { graceMs: opts.graceMs })) killed.push(pid);
    else skipped.push(pid); // already gone (killed with an earlier tree), or not ours to kill
  }
  // A listener we were told to spare keeps the port: no point waiting for it.
  if (spared) return { killed, skipped, free: false };
  const free = await waitForPortFree(port, { timeoutMs: opts.timeoutMs ?? 5000 });
  return { killed, skipped, free };
}
