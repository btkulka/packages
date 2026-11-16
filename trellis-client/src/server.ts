// The dedicated 3D ComfyUI as a server: started guarded for a small machine (one at a time across every process,
// a free-memory floor, half the cores, low priority, VRAM kept back for the desktop), found again later by its PID
// file, stopped by killing its tree.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { isAlive, killTree, probeHttp, readPidFile, removePidFile, spawnDetached, waitForHttp, writePidFile } from "@btkulka/proc-kit";

export interface TrellisEnv {
  /** The dedicated ComfyUI checkout (ComfyUI 0.45+ with TRELLIS.2 built in), with its own venv. */
  comfyDir: string;
  /** Where it serves (default http://127.0.0.1:8190). */
  url?: string;
  /** Its Python (default `<comfyDir>/venv/Scripts/python.exe`, or `venv/bin/python`). */
  python?: string;
  /** Another ComfyUI's models folder to share (concept checkpoints), written into extra_model_paths.yaml. */
  sharedModelsDir?: string;
  /** Where the lock and PID files live (default the OS temp dir). */
  runDir?: string;
}

export interface ResolvedEnv {
  comfyDir: string;
  url: string;
  host: string;
  port: number;
  python: string;
  sharedModelsDir?: string;
  runDir: string;
}

export type TrellisErrorCode =
  | "no-comfy"
  | "no-venv"
  | "main-comfy-up"
  | "locked"
  | "low-memory"
  | "not-up"
  | "no-template"
  | "no-trellis-nodes"
  | "no-checkpoint"
  | "bad-prompt"
  | "failed"
  | "no-output"
  | "bad-glb";

export class TrellisError extends Error {
  code: TrellisErrorCode;
  constructor(code: TrellisErrorCode, message: string) {
    super(message);
    this.name = "TrellisError";
    this.code = code;
  }
}

export function resolveEnv(env: TrellisEnv): ResolvedEnv {
  const url = (env.url ?? "http://127.0.0.1:8190").replace(/\/+$/, "");
  const u = new URL(url);
  const python = env.python ?? path.join(env.comfyDir, "venv", process.platform === "win32" ? "Scripts/python.exe" : "bin/python");
  return {
    comfyDir: env.comfyDir,
    url,
    host: u.hostname,
    port: Number(u.port || 80),
    python,
    sharedModelsDir: env.sharedModelsDir,
    runDir: env.runDir ?? os.tmpdir(),
  };
}

/** Threads a heavy job may use: half the logical cores, at least two. */
export const threadBudget = (): number => Math.max(2, Math.floor(os.cpus().length / 2));

export async function isUp(env: TrellisEnv, timeoutMs = 1500): Promise<boolean> {
  return probeHttp(`${resolveEnv(env).url}/system_stats`, { timeoutMs });
}

export interface ServeOptions {
  /** Refuse to start under this much free RAM in GB (default 6; the int8 model and its VAEs live in RAM between steps). */
  refuseGB?: number;
  /** Warn under this much (default 8). */
  warnGB?: number;
  /** Start even under the floor. */
  force?: boolean;
  /** Another ComfyUI that must not be running at the same time (default http://127.0.0.1:8188): two on one card crawl. */
  mainUrl?: string | null;
  /** Threads for the server (default half the cores). */
  threads?: number;
  /** VRAM to keep back for the desktop, GB (default 1). */
  reserveVramGB?: number;
  /** ComfyUI's --lowvram (default true: an 8 GB card). */
  lowVram?: boolean;
  /** More ComfyUI arguments. */
  extraArgs?: string[];
  /** A log file for the server's output (default `<comfyDir>/trellis-server.log`). */
  log?: string;
  /** How long to wait for it to answer (default 120 s). */
  startTimeoutMs?: number;
  onLog?: (line: string) => void;
}

export interface ServeHandle {
  pid: number;
  url: string;
  /** Already running before this call (nothing was started). */
  reused: boolean;
  /** Kill the server and release the lock. */
  stop: () => Promise<boolean>;
}

const GB = 1024 ** 3;
const lockFile = (r: ResolvedEnv) => path.join(r.runDir, `trellis-${r.port}.lock`);
const pidFile = (r: ResolvedEnv) => path.join(r.runDir, `trellis-${r.port}.pid`);

/** The PID of a server started here and still alive, else null. */
export function serverPid(env: TrellisEnv): number | null {
  const r = resolveEnv(env);
  const data = readPidFile(pidFile(r));
  const pid = data?.pid ?? null;
  if (pid && isAlive(pid)) return pid;
  if (pid) removePidFile(pidFile(r));
  return null;
}

function takeLock(r: ResolvedEnv): void {
  const file = lockFile(r);
  try {
    const held = JSON.parse(fs.readFileSync(file, "utf8")) as { pid: number; at: string; what?: string };
    if (held.pid !== process.pid && isAlive(held.pid)) {
      throw new TrellisError("locked", `Another TRELLIS server is being started or run by pid ${held.pid} (since ${held.at}); heavy jobs run one at a time.`);
    }
  } catch (err) {
    if (err instanceof TrellisError) throw err;
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ pid: process.pid, at: new Date().toISOString(), what: "trellis serve" }));
}

function releaseLock(r: ResolvedEnv): void {
  const file = lockFile(r);
  try {
    if ((JSON.parse(fs.readFileSync(file, "utf8")) as { pid: number }).pid === process.pid) fs.unlinkSync(file);
  } catch {
    // Already gone.
  }
}

/**
 * Start the dedicated ComfyUI, or hand back the one already answering. It refuses (a TrellisError with a code) when
 * the checkout or its venv is missing, when the main ComfyUI is up, when another start holds the lock, or when
 * free RAM is under the floor. The server is detached: it outlives the caller, and `serverPid` finds it again.
 */
export async function serve(env: TrellisEnv, opts: ServeOptions = {}): Promise<ServeHandle> {
  const r = resolveEnv(env);
  const stop = async () => {
    const pid = serverPid(env);
    const killed = pid ? await killTree(pid) : false;
    removePidFile(pidFile(r));
    return killed;
  };
  if (await isUp(env)) {
    const pid = serverPid(env) ?? 0;
    opts.onLog?.(`The 3D ComfyUI is already up at ${r.url}.`);
    return { pid, url: r.url, reused: true, stop };
  }
  if (!fs.existsSync(path.join(r.comfyDir, "main.py"))) throw new TrellisError("no-comfy", `No ComfyUI at ${r.comfyDir} (clone ComfyUI 0.45+ there).`);
  if (!fs.existsSync(r.python)) throw new TrellisError("no-venv", `No Python at ${r.python}; make the venv and install ComfyUI's requirements.`);
  const mainUrl = opts.mainUrl === undefined ? "http://127.0.0.1:8188" : opts.mainUrl;
  if (mainUrl && (await probeHttp(`${mainUrl}/system_stats`, { timeoutMs: 1500 }))) {
    throw new TrellisError("main-comfy-up", `The main ComfyUI is running at ${mainUrl}; stop it first, two on one card both crawl or run out of memory.`);
  }
  takeLock(r);
  const free = os.freemem() / GB;
  const total = os.totalmem() / GB;
  const refuseGB = opts.refuseGB ?? 6;
  if (free < refuseGB && !opts.force) {
    releaseLock(r);
    throw new TrellisError("low-memory", `Only ${free.toFixed(1)} of ${total.toFixed(0)} GB free; TRELLIS needs at least ${refuseGB} GB. Close something heavy first.`);
  }
  if (free < (opts.warnGB ?? 8)) opts.onLog?.(`Warning: ${free.toFixed(1)} GB free; TRELLIS may push the machine into swap.`);
  if (r.sharedModelsDir) {
    const { writeExtraModelPaths } = await import("./weights.js");
    const wrote = writeExtraModelPaths(r.comfyDir, r.sharedModelsDir);
    if (wrote) opts.onLog?.(`Wrote ${wrote} (shares ${r.sharedModelsDir}).`);
  }
  const threads = String(opts.threads ?? threadBudget());
  const args = ["main.py", "--listen", r.host, "--port", String(r.port), "--disable-auto-launch", "--cache-none"];
  if (opts.lowVram ?? true) args.push("--lowvram");
  args.push("--reserve-vram", String(opts.reserveVramGB ?? 1.0));
  args.push(...(opts.extraArgs ?? []));
  const log = opts.log ?? path.join(r.comfyDir, "trellis-server.log");
  const child = spawnDetached(r.python, args, {
    cwd: r.comfyDir,
    log,
    env: { ...process.env, OMP_NUM_THREADS: threads, MKL_NUM_THREADS: threads, PYTORCH_CUDA_ALLOC_CONF: "expandable_segments:True" },
    onError: (e) => opts.onLog?.(`Could not start ComfyUI: ${e.message}`),
  });
  if (!child.pid) {
    releaseLock(r);
    throw new TrellisError("not-up", `ComfyUI did not start (see ${log}).`);
  }
  try {
    os.setPriority(child.pid, os.constants.priority.PRIORITY_BELOW_NORMAL);
  } catch {
    // Not permitted; it runs at normal priority.
  }
  writePidFile(pidFile(r), { pid: child.pid, port: r.port, startedAt: new Date().toISOString() });
  opts.onLog?.(`3D ComfyUI starting at ${r.url} (pid ${child.pid}, ${threads} threads, low priority; log ${log}).`);
  const up = await waitForHttp(`${r.url}/system_stats`, { timeoutMs: opts.startTimeoutMs ?? 120_000, intervalMs: 1000 });
  releaseLock(r);
  if (!up) {
    await stop();
    throw new TrellisError("not-up", `ComfyUI did not answer at ${r.url} within ${(opts.startTimeoutMs ?? 120_000) / 1000} s (see ${log}).`);
  }
  return { pid: child.pid, url: r.url, reused: false, stop };
}

/** Stop a server started here (by its PID file). True when something was killed. */
export async function stopServer(env: TrellisEnv): Promise<boolean> {
  const r = resolveEnv(env);
  const pid = serverPid(env);
  const killed = pid ? await killTree(pid) : false;
  removePidFile(pidFile(r));
  return killed;
}

/**
 * A memory floor for a foreground run: when free RAM stays under `floorGB` for `holdS` seconds the machine is
 * thrashing, so the server is stopped rather than letting the desktop freeze. Returns a function that ends the watch.
 */
export function watchMemoryFloor(handle: ServeHandle, opts: { floorGB?: number; holdS?: number; onStop?: () => void } = {}): () => void {
  const floor = opts.floorGB ?? 0.7;
  const need = Math.max(1, Math.round((opts.holdS ?? 30) / 10));
  let lowFor = 0;
  const timer = setInterval(() => {
    lowFor = os.freemem() / GB < floor ? lowFor + 1 : 0;
    if (lowFor >= need) {
      clearInterval(timer);
      void handle.stop().then(() => opts.onStop?.());
    }
  }, 10_000);
  timer.unref();
  return () => clearInterval(timer);
}
