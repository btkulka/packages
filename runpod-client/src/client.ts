// RunPod's REST API v2 (https://api.runpod.io/v2; v1 at rest.runpod.io was retired on Nov 15 2026), the parts a
// GPU rental needs: the GPU catalog with prices, and pods (create, read, list, logs, run a command, actions,
// terminate). Shapes follow the v2 OpenAPI (api.runpod.io/v2/openapi.json, read Nov 16 2026), loosely typed: the
// fields this package uses are named, the rest pass through.

import { defaultFetch, send, type FetchLike } from "@btkulka/http-kit";
import { RunPodError } from "./errors.js";

export const RUNPOD_API = "https://api.runpod.io";

export type Cloud = "SECURE" | "COMMUNITY";
export type PodStatus = "PROVISIONING" | "STARTING" | "RUNNING" | "EXITED" | "ERROR" | "TERMINATED";

export interface GpuType {
  /** What pod creation takes: "NVIDIA RTX A6000", "NVIDIA GeForce RTX 4090"… */
  id: string;
  name: string;
  manufacturer?: string;
  /** VRAM in GB. */
  memory: number;
  secure?: boolean;
  community?: boolean;
  /** List price in USD per hour for one GPU, per cloud. */
  price?: { secure?: number; community?: number; serverless?: number };
  availability?: "NONE" | "LOW" | "MEDIUM" | "HIGH";
  [k: string]: unknown;
}

export interface Pod {
  id: string;
  name: string;
  status: PodStatus;
  cloud?: Cloud;
  /** The pod's hourly compute rate in USD (also while stopped: not what it costs right now). */
  cost?: number;
  gpu?: { id?: string; count?: number; [k: string]: unknown };
  dataCenterId?: string | null;
  cudaVersion?: string | null;
  createdAt?: string;
  startedAt?: string | null;
  /** While the container runs: its uptime (s) and the GPU's use; null until it has started. */
  runtime?: { uptime?: number; gpus?: { util?: number; memoryUtil?: number }[]; [k: string]: unknown } | null;
  [k: string]: unknown;
}

export interface CreatePodBody {
  name: string;
  image?: string;
  /** Container disk in GB (ephemeral). */
  disk?: number;
  env?: Record<string, string>;
  /** "8188/http", "22/tcp". */
  ports?: string[];
  entrypoint?: string[];
  cmd?: string[];
  cloud?: Cloud;
  gpu?: { id: string; count?: number; minCudaVersion?: string; allowedCudaVersions?: string[]; minRamPerGpu?: number; minVcpuCountPerGpu?: number };
  dataCenterIds?: string[];
  templateId?: string;
  [k: string]: unknown;
}

export interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  timedOut: boolean;
  truncated: boolean;
  durationMs: number;
}

export interface RunPodClientOptions {
  apiKey: string;
  /** Default https://api.runpod.io. */
  base?: string;
  fetch?: FetchLike;
  /** Per request. Default 30 s. */
  timeoutMs?: number;
}

export interface RunPodClient {
  /** The account the key belongs to (a cheap call that proves the key). */
  account(): Promise<{ id: string; email?: string | null }>;
  /** The GPU catalog: every type with its VRAM and per-cloud price; filter by cloud and the host's CUDA. */
  gpus(o?: { cloud?: Cloud; minCudaVersion?: string; availability?: boolean }): Promise<GpuType[]>;
  pods(): Promise<Pod[]>;
  pod(id: string): Promise<Pod>;
  createPod(body: CreatePodBody): Promise<Pod>;
  /** Permanently terminates and deletes a pod (compute released, its container disk gone). True when it was there. */
  terminate(id: string): Promise<boolean>;
  action(id: string, action: "start" | "stop" | "restart" | "terminate"): Promise<Pod>;
  /** The container's (or the system's) log, the last `tail` lines. */
  logs(id: string, o?: { source?: "container" | "system"; tail?: number }): Promise<string>;
  /** Runs one command in the pod (argv, no shell) and returns its output when it finishes. */
  exec(id: string, command: string[], o?: { timeoutSeconds?: number; cwd?: string; env?: Record<string, string> }): Promise<ExecResult>;
}

export function createRunPodClient(o: RunPodClientOptions): RunPodClient {
  if (!o.apiKey) throw new RunPodError("missing_api_key", 0, "No RunPod API key: set it in Benhäus › Settings › Credentials (runpod), or RUNPOD_API_KEY.");
  const base = (o.base ?? RUNPOD_API).replace(/\/+$/, "");
  const fetchImpl = o.fetch ?? defaultFetch();
  const call = async <T>(method: string, path: string, body?: unknown, query?: Record<string, string | number | boolean | string[] | undefined>, accept = "application/json"): Promise<T> => {
    const url = new URL(base + path);
    for (const [k, v] of Object.entries(query ?? {})) {
      if (v === undefined) continue;
      if (Array.isArray(v)) for (const x of v) url.searchParams.append(k, x);
      else url.searchParams.set(k, String(v));
    }
    const headers: Record<string, string> = { Authorization: `Bearer ${o.apiKey}`, Accept: accept };
    if (body !== undefined) headers["Content-Type"] = "application/json";
    const r = await send(fetchImpl, url.toString(), { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }, { timeoutMs: o.timeoutMs ?? 30_000, label: `RunPod ${method} ${path}` });
    if (!r.res.ok) throw RunPodError.fromResponse(r.res.status, r.json, r.text, `${method} ${path}`);
    return (accept === "application/json" ? (r.json ?? undefined) : r.text) as T;
  };
  return {
    account: () => call("GET", "/v2/account"),
    gpus: async (q = {}) => {
      const r = await call<{ gpus?: GpuType[] } | GpuType[]>("GET", "/v2/catalog/gpus", undefined, {
        cloud: q.cloud,
        minCudaVersion: q.minCudaVersion,
        product: ["POD"],
        include: q.availability === false ? undefined : ["AVAILABILITY"],
      });
      return Array.isArray(r) ? r : (r?.gpus ?? []);
    },
    pods: async () => {
      const r = await call<{ pods?: Pod[] } | Pod[]>("GET", "/v2/pods");
      return Array.isArray(r) ? r : (r?.pods ?? []);
    },
    pod: (id) => call("GET", `/v2/pods/${encodeURIComponent(id)}`),
    createPod: (body) => call("POST", "/v2/pods", body),
    terminate: async (id) => {
      try {
        await call("DELETE", `/v2/pods/${encodeURIComponent(id)}`);
        return true;
      } catch (e) {
        if (e instanceof RunPodError && e.status === 404) return false;
        throw e;
      }
    },
    action: (id, action) => call("POST", `/v2/pods/${encodeURIComponent(id)}/action`, { action }),
    logs: async (id, q = {}) => {
      // v2 serves logs as a Server-Sent Events stream that stays open to follow new lines, so reading it to the end
      // never finishes. Take the backlog (it arrives at once), stop when the stream goes quiet, keep each event's line.
      const path = `/v2/pods/${encodeURIComponent(id)}/logs`;
      const url = new URL(base + path);
      url.searchParams.set("source", q.source ?? "container");
      url.searchParams.set("tail", String(q.tail ?? 100));
      const ctl = new AbortController();
      const hard = setTimeout(() => ctl.abort(), o.timeoutMs ?? 30_000);
      let raw = "";
      try {
        const res = (await fetchImpl(url.toString(), { method: "GET", headers: { Authorization: `Bearer ${o.apiKey}`, Accept: "text/event-stream, text/plain" }, signal: ctl.signal })) as Awaited<ReturnType<FetchLike>> & { body?: ReadableStream<Uint8Array> | null };
        if (!res.ok) {
          const text = await res.text().catch(() => "");
          let json: unknown;
          try {
            json = JSON.parse(text);
          } catch {
            json = undefined;
          }
          throw RunPodError.fromResponse(res.status, json, text, `GET ${path}`);
        }
        const reader = res.body?.getReader?.();
        if (!reader) return sseLines(await res.text());
        const decoder = new TextDecoder();
        try {
          for (;;) {
            let idle: ReturnType<typeof setTimeout> | undefined;
            const quiet = new Promise<null>((r) => (idle = setTimeout(() => r(null), raw ? 1500 : 10_000)));
            const chunk = await Promise.race([reader.read(), quiet]);
            clearTimeout(idle);
            if (!chunk || chunk.done) break;
            raw += decoder.decode(chunk.value, { stream: true });
          }
        } catch (e) {
          if ((e as Error).name !== "AbortError") throw e;
        }
        reader.cancel().catch(() => undefined);
        return sseLines(raw);
      } catch (e) {
        if ((e as Error).name === "AbortError") return sseLines(raw);
        throw e;
      } finally {
        clearTimeout(hard);
        ctl.abort();
      }
    },
    exec: (id, command, q = {}) => call("POST", `/v2/pods/${encodeURIComponent(id)}/exec`, { command, ...q }),
  };
}

/** The lines of a logs response: each Server-Sent Event's `line` (`data: {"source","line","ts"}`), or plain text as is. */
export function sseLines(raw: string): string {
  if (!/^data:/m.test(raw)) return raw;
  const out: string[] = [];
  for (const l of raw.split(/\r?\n/)) {
    if (!l.startsWith("data:")) continue;
    const d = l.slice(5).trim();
    try {
      const j = JSON.parse(d) as { line?: unknown };
      out.push(typeof j?.line === "string" ? j.line : d);
    } catch {
      out.push(d);
    }
  }
  return out.join("\n");
}

/** A pod's HTTP port through RunPod's proxy: https://<pod id>-<port>.proxy.runpod.net (a 100 s limit per request). */
export const proxyUrl = (podId: string, port: number): string => `https://${podId}-${port}.proxy.runpod.net`;
