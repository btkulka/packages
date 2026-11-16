// A guarded GPU rental. Nothing is spent until rent() is called, and rent() refuses a plan that could cost more
// than its budget. Every pod it starts carries a hard deadline: a detached watchdog process (it outlives the
// caller, a crash or a closed terminal) terminates the pod when the deadline passes, and terminate() ends it
// sooner. A pod's name starts with a prefix ("btkulka-") so sweep() can find strays.

import { killTree, spawnDetached } from "@btkulka/proc-kit";
import os from "node:os";
import path from "node:path";
import { proxyUrl, type Cloud, type CreatePodBody, type GpuType, type Pod, type RunPodClient } from "./client.js";
import { isRunPodError, RunPodError } from "./errors.js";

export const POD_PREFIX = "btkulka-";

export interface PlanOptions {
  /** GPUs with at least this much VRAM (GB). Default 24. */
  minMemoryGb?: number;
  /** Only these GPU type ids, in this order of preference (else every one that fits, cheapest first). */
  gpus?: string[];
  /** The clouds to try, in order. Default COMMUNITY then SECURE. */
  clouds?: Cloud[];
  /** The host's CUDA has to be at least this (the image's torch needs it). */
  minCudaVersion?: string;
  /** No GPU dearer than this per hour. */
  maxPricePerHour?: number;
  /** The pod is terminated at this many minutes at the latest. Default 45. */
  maxMinutes?: number;
  /** Refuse when the worst case (price x maxMinutes for the dearest candidate) is over this. Default 2. */
  budgetUsd?: number;
  /** GPUs per pod. Default 1. */
  count?: number;
}

export interface Candidate {
  gpu: string;
  name: string;
  memory: number;
  cloud: Cloud;
  pricePerHour: number;
  availability?: string;
}

export interface Plan {
  /** In the order rent() tries them: preference, else cheapest first. */
  candidates: Candidate[];
  maxMinutes: number;
  budgetUsd: number;
  /** The worst case if the dearest candidate places and runs to the deadline. */
  maxCostUsd: number;
  /** The cheapest candidate's cost over the deadline. */
  minCostUsd: number;
  /** Within budget and at least one candidate. */
  ok: boolean;
  reason?: string;
}

const priceOf = (g: GpuType, cloud: Cloud) => (cloud === "SECURE" ? g.price?.secure : g.price?.community);
const offered = (g: GpuType, cloud: Cloud) => (cloud === "SECURE" ? g.secure !== false : g.community !== false);

/** What a rental would use and cost, from the live catalog. Spends nothing. */
export async function planRental(client: RunPodClient, o: PlanOptions = {}): Promise<Plan> {
  const clouds = o.clouds ?? ["COMMUNITY", "SECURE"];
  const maxMinutes = o.maxMinutes ?? 45;
  const budgetUsd = o.budgetUsd ?? 2;
  const count = o.count ?? 1;
  const minMemory = o.minMemoryGb ?? 24;
  const candidates: Candidate[] = [];
  for (const cloud of clouds) {
    const gpus = await client.gpus({ cloud, minCudaVersion: o.minCudaVersion });
    const fit = gpus.filter((g) => {
      const p = priceOf(g, cloud);
      return offered(g, cloud) && typeof p === "number" && p > 0 && g.memory >= minMemory && g.availability !== "NONE" && (o.maxPricePerHour === undefined || p <= o.maxPricePerHour);
    });
    const ordered = o.gpus?.length
      ? (o.gpus.map((id) => fit.find((g) => g.id === id)).filter(Boolean) as GpuType[])
      : fit.sort((a, b) => (priceOf(a, cloud) ?? 0) - (priceOf(b, cloud) ?? 0) || b.memory - a.memory);
    for (const g of ordered) candidates.push({ gpu: g.id, name: g.name, memory: g.memory, cloud, pricePerHour: (priceOf(g, cloud) ?? 0) * count, availability: g.availability });
  }
  if (!candidates.length) {
    return { candidates, maxMinutes, budgetUsd, maxCostUsd: 0, minCostUsd: 0, ok: false, reason: `No GPU with ${minMemory} GB${o.minCudaVersion ? ` and CUDA ${o.minCudaVersion}+` : ""} is offered${o.maxPricePerHour ? ` under $${o.maxPricePerHour}/h` : ""} right now.` };
  }
  // Only candidates whose worst case fits the budget are tried.
  const affordable = candidates.filter((c) => (c.pricePerHour * maxMinutes) / 60 <= budgetUsd);
  const cost = (c: Candidate) => round2((c.pricePerHour * maxMinutes) / 60);
  if (!affordable.length) {
    const cheapest = candidates.reduce((a, b) => (a.pricePerHour <= b.pricePerHour ? a : b));
    return { candidates, maxMinutes, budgetUsd, maxCostUsd: cost(cheapest), minCostUsd: cost(cheapest), ok: false, reason: `The cheapest fit (${cheapest.name}, $${cheapest.pricePerHour.toFixed(2)}/h) could cost $${cost(cheapest).toFixed(2)} over ${maxMinutes} min, over the $${budgetUsd.toFixed(2)} budget.` };
  }
  return {
    candidates: affordable,
    maxMinutes,
    budgetUsd,
    maxCostUsd: Math.max(...affordable.map(cost)),
    minCostUsd: Math.min(...affordable.map(cost)),
    ok: true,
  };
}

const round2 = (n: number) => Math.round(n * 100) / 100;

export interface RentOptions {
  /** Named POD_PREFIX + name (+ a time stamp). */
  name: string;
  plan: Plan;
  image: string;
  disk?: number;
  env?: Record<string, string>;
  ports?: string[];
  entrypoint?: string[];
  cmd?: string[];
  minCudaVersion?: string;
  count?: number;
  /** For the watchdog's API calls (it runs as its own process). */
  apiKey: string;
  /** Where the watchdog's log goes. Default the temp dir. */
  logDir?: string;
  onLog?: (line: string) => void;
}

export interface Rental {
  pod: Pod;
  id: string;
  candidate: Candidate;
  startedAt: number;
  deadline: number;
  /** https://<id>-<port>.proxy.runpod.net */
  url(port: number): string;
  /** Spent so far at the candidate's rate (an estimate; RunPod bills by the second). */
  spentUsd(): number;
  /** Ends the pod now (and the watchdog). Safe to call twice. */
  terminate(): Promise<void>;
}

/**
 * Starts a pod on the plan's first candidate that places (a candidate without capacity is skipped), with a
 * watchdog that terminates it at the plan's deadline. Throws a RunPodError (category budget) for a plan that
 * isn't ok; nothing is created then.
 */
export async function rent(client: RunPodClient, o: RentOptions): Promise<Rental> {
  if (!o.plan.ok) throw new RunPodError("budget", 0, o.plan.reason ?? "The plan isn't within budget.", undefined, "budget");
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..+/, "").replace("T", "-");
  const name = `${POD_PREFIX}${o.name}-${stamp}`.slice(0, 60);
  let lastErr: unknown;
  for (const c of o.plan.candidates) {
    const body: CreatePodBody = {
      name,
      image: o.image,
      disk: o.disk ?? 40,
      env: o.env,
      ports: o.ports,
      entrypoint: o.entrypoint,
      cmd: o.cmd,
      cloud: c.cloud,
      gpu: { id: c.gpu, count: o.count ?? 1, ...(o.minCudaVersion ? { minCudaVersion: o.minCudaVersion } : {}) },
    };
    let pod: Pod;
    try {
      pod = await client.createPod(body);
    } catch (e) {
      lastErr = e;
      if (isRunPodError(e, "capacity") || (isRunPodError(e, "request") && /gpu|cuda|machine|instance|available/i.test((e as Error).message))) {
        o.onLog?.(`${c.name} (${c.cloud.toLowerCase()}) has no machine free: trying the next.`);
        continue;
      }
      throw e;
    }
    const startedAt = Date.now();
    const deadline = startedAt + o.plan.maxMinutes * 60_000;
    const watchdog = spawnWatchdog(pod.id, deadline, o.apiKey, o.logDir);
    o.onLog?.(`Rented ${c.name} (${c.memory} GB, ${c.cloud.toLowerCase()}, $${c.pricePerHour.toFixed(2)}/h) as ${pod.id}; it ends by ${new Date(deadline).toLocaleTimeString()} at the latest.`);
    let ended = false;
    return {
      pod,
      id: pod.id,
      candidate: c,
      startedAt,
      deadline,
      url: (port) => proxyUrl(pod.id, port),
      spentUsd: () => round2((c.pricePerHour * (Date.now() - startedAt)) / 3_600_000),
      terminate: async () => {
        if (ended) return;
        ended = true;
        let tries = 0;
        for (;;) {
          try {
            await client.terminate(pod.id);
            break;
          } catch (e) {
            if (++tries >= 5) {
              o.onLog?.(`Couldn't terminate ${pod.id} (${(e as Error).message}); the watchdog still will at ${new Date(deadline).toLocaleTimeString()}. Check: btkulka-runpod pods`);
              return;
            }
            await new Promise((r) => setTimeout(r, 3000 * tries));
          }
        }
        if (watchdog) await killTree(watchdog).catch(() => false);
        o.onLog?.(`Terminated ${pod.id} after ${Math.round((Date.now() - startedAt) / 60_000)} min (about $${round2((c.pricePerHour * (Date.now() - startedAt)) / 3_600_000).toFixed(2)}).`);
      },
    };
  }
  throw lastErr instanceof Error ? lastErr : new RunPodError("no_capacity", 0, "None of the plan's GPUs had a machine free.", undefined, "capacity");
}

/** The watchdog's script: wait for the deadline, then terminate the pod (a few tries), logging what it did. */
export const WATCHDOG_SCRIPT = String.raw`
const [podId, deadline] = process.argv.slice(1);
const key = process.env.RUNPOD_API_KEY;
const wait = Math.max(0, Number(deadline) - Date.now());
const log = (m) => console.log(new Date().toISOString() + " " + m);
log("watching " + podId + " until " + new Date(Number(deadline)).toISOString());
setTimeout(async () => {
  for (let i = 0; i < 10; i++) {
    try {
      const r = await fetch("https://api.runpod.io/v2/pods/" + encodeURIComponent(podId), { method: "DELETE", headers: { Authorization: "Bearer " + key } });
      if (r.ok || r.status === 404) { log("deadline: terminated " + podId + " (" + r.status + ")"); process.exit(0); }
      log("terminate answered " + r.status);
    } catch (e) { log("terminate failed: " + e.message); }
    await new Promise((res) => setTimeout(res, 15000));
  }
  log("gave up: terminate " + podId + " by hand (btkulka-runpod terminate " + podId + ")");
  process.exit(1);
}, wait);
`;

/** Starts the detached watchdog for a pod. Returns its pid (undefined if it couldn't start: the caller still terminates). */
export function spawnWatchdog(podId: string, deadline: number, apiKey: string, logDir?: string): number | undefined {
  const log = path.join(logDir ?? os.tmpdir(), "btkulka-runpod", `watchdog-${podId}.log`);
  const child = spawnDetached(process.execPath, ["-e", WATCHDOG_SCRIPT, podId, String(deadline)], {
    log,
    env: { ...process.env, RUNPOD_API_KEY: apiKey },
  });
  return child.pid;
}

/** Terminates every pod whose name starts with the prefix (strays from runs that died). Returns the ids ended. */
export async function sweep(client: RunPodClient, prefix = POD_PREFIX): Promise<string[]> {
  const ended: string[] = [];
  for (const p of await client.pods()) {
    if (!p.name?.startsWith(prefix) || p.status === "TERMINATED") continue;
    if (await client.terminate(p.id)) ended.push(p.id);
  }
  return ended;
}

/** Waits until an HTTP address on the pod answers 2xx (through RunPod's proxy), reporting progress. */
export async function waitForPodHttp(
  url: string,
  o: { headers?: Record<string, string>; timeoutMs?: number; intervalMs?: number; signal?: AbortSignal; onWait?: (secs: number) => Promise<void> | void } = {},
): Promise<boolean> {
  const started = Date.now();
  const limit = o.timeoutMs ?? 20 * 60_000;
  let last = 0;
  while (Date.now() - started < limit) {
    if (o.signal?.aborted) return false;
    try {
      const r = await fetch(url, { headers: o.headers, signal: AbortSignal.timeout(15_000) });
      if (r.ok) return true;
    } catch {
      // Not up yet.
    }
    const secs = Math.round((Date.now() - started) / 1000);
    if (o.onWait && secs - last >= 30) {
      last = secs;
      await o.onWait(secs);
    }
    await new Promise((r) => setTimeout(r, o.intervalMs ?? 5000));
  }
  return false;
}
