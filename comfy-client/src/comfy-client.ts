import { Buffer } from "node:buffer";
import { tracedFetch } from "./comfy-trace.js";
import { getComfyWs, type ComfyExecutionError } from "./comfy-ws.js";

interface QueueResponse {
  prompt_id: string;
  number?: number;
  node_errors?: Record<string, unknown>;
}

interface HistoryEntry {
  outputs?: Record<string, { images?: Array<{ filename: string; subfolder: string; type: string }> }>;
  status?: { completed?: boolean; status_str?: string; messages?: unknown[] };
}

export class ComfyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ComfyError";
  }
}

export interface ComfyImage {
  filename: string;
  subfolder: string;
  type: string;
  bytes: Buffer;
}

/** Progress frames streamed by `runWorkflowWithProgress`. */
export type RunProgress =
  | { phase: "queued"; promptId: string }
  | { phase: "executing"; promptId: string; node: string | null }
  | { phase: "progress"; promptId: string; value: number; max: number; node: string }
  | { phase: "done"; promptId: string }
  | { phase: "error"; promptId: string; message: string };

/** Shape of the slice of ComfyUI's `/object_info` we read for model discovery. */
interface ObjectInfoResponse {
  CheckpointLoaderSimple?: { input?: { required?: { ckpt_name?: [unknown] } } };
  LoraLoader?: { input?: { required?: { lora_name?: [unknown] } } };
  VAELoader?: { input?: { required?: { vae_name?: [unknown] } } };
  KSampler?: {
    input?: { required?: { sampler_name?: [unknown]; scheduler?: [unknown] } };
  };
}

/** Lists of installed assets, as ComfyUI reports them. */
export interface ComfyModels {
  checkpoints: string[];
  loras: string[];
  vaes: string[];
  samplers: string[];
  schedulers: string[];
}

/** One entry in ComfyUI's live queue (running or pending). */
export interface ComfyQueueItem {
  /** ComfyUI's queue sequence number (execution order key). */
  number: number;
  promptId: string;
}

/** ComfyUI's live queue, split into the running job(s) and the pending backlog. */
export interface ComfyQueueState {
  running: ComfyQueueItem[];
  pending: ComfyQueueItem[];
}

/** A recently-finished job from ComfyUI's `/history`, newest first. */
export interface ComfyHistoryItem {
  promptId: string;
  /** ComfyUI's status string, e.g. "success" | "error" — undefined if absent. */
  status?: string;
  completed?: boolean;
  /** Output image descriptors collected across all output nodes. */
  images: Array<{ filename: string; subfolder: string; type: string }>;
}

export class ComfyClient {
  private get clientId(): string {
    return getComfyWs(this.baseUrl).clientId;
  }

  /**
   * Bound on the ws-DROP `/history` fallback poll. Defaults to perJobTimeoutMs
   * (legacy behaviour) when not supplied, so existing callers are byte-identical;
   * ComfyService passes a tighter default so a dead ComfyUI fails fast.
   */
  private readonly wsFallbackTimeoutMs: number;

  constructor(
    private readonly baseUrl: string,
    private readonly perJobTimeoutMs: number,
    wsFallbackTimeoutMs?: number,
  ) {
    this.wsFallbackTimeoutMs = wsFallbackTimeoutMs ?? perJobTimeoutMs;
  }

  async ping(): Promise<boolean> {
    try {
      const res = await tracedFetch(`${this.baseUrl}/system_stats`, {
        tag: "system_stats",
        timeoutMs: 3000,
      });
      return res.ok;
    } catch {
      return false;
    }
  }

  /**
   * Reachability check with a structured result (no throw), so callers can
   * surface a friendly message without inspecting errors.
   */
  async probe(): Promise<{ reachable: boolean; message: string }> {
    try {
      const res = await tracedFetch(`${this.baseUrl}/system_stats`, {
        tag: "system_stats",
        timeoutMs: 3000,
      });
      if (!res.ok) return { reachable: false, message: `${this.baseUrl} → HTTP ${res.status}` };
      return { reachable: true, message: `${this.baseUrl} reachable` };
    } catch (err) {
      return { reachable: false, message: `${this.baseUrl} unreachable: ${(err as Error).message}` };
    }
  }

  /**
   * Discover installed checkpoints, LoRAs, VAEs, samplers, and schedulers by
   * reading ComfyUI's `/object_info`. Empty arrays where a node is absent.
   */
  async listModels(): Promise<ComfyModels> {
    const res = await tracedFetch(`${this.baseUrl}/object_info`, {
      tag: "object_info",
      timeoutMs: 8000,
    });
    if (!res.ok) throw new ComfyError(`/object_info → HTTP ${res.status}`);
    const data = (await res.json()) as ObjectInfoResponse;
    const asStrings = (v: unknown): string[] =>
      Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
    return {
      checkpoints: asStrings(data?.CheckpointLoaderSimple?.input?.required?.ckpt_name?.[0]),
      loras: asStrings(data?.LoraLoader?.input?.required?.lora_name?.[0]),
      vaes: asStrings(data?.VAELoader?.input?.required?.vae_name?.[0]),
      samplers: asStrings(data?.KSampler?.input?.required?.sampler_name?.[0]),
      schedulers: asStrings(data?.KSampler?.input?.required?.scheduler?.[0]),
    };
  }

  /**
   * Read ComfyUI's live queue (`GET /queue`). Returns the running job(s) and the
   * pending backlog as normalized `{ number, promptId }` items. Each raw queue
   * entry is the tuple `[number, promptId, prompt, extra, outputs]`; we keep only
   * the first two fields (the rest is the full graph, which callers don't need).
   * Returns empty lists if ComfyUI is unreachable or the shape is unexpected.
   */
  async getQueue(): Promise<ComfyQueueState> {
    const res = await tracedFetch(`${this.baseUrl}/queue`, {
      tag: "queue-status",
      timeoutMs: 5_000,
    });
    if (!res.ok) throw new ComfyError(`/queue → HTTP ${res.status}`);
    const data = (await res.json().catch(() => ({}))) as {
      queue_running?: unknown[];
      queue_pending?: unknown[];
    };
    const norm = (rows: unknown[] | undefined): ComfyQueueItem[] =>
      (Array.isArray(rows) ? rows : [])
        .map((row) => {
          if (!Array.isArray(row)) return null;
          const number = typeof row[0] === "number" ? row[0] : 0;
          const promptId = typeof row[1] === "string" ? row[1] : "";
          return promptId ? { number, promptId } : null;
        })
        .filter((x): x is ComfyQueueItem => x !== null);
    return { running: norm(data.queue_running), pending: norm(data.queue_pending) };
  }

  /**
   * Read ComfyUI's recent job history (`GET /history?max_items=N`), newest first.
   * Each entry carries its status + the output image descriptors. ComfyUI returns
   * a `{ [promptId]: entry }` map (no inherent order) — we reverse the key order so
   * the most-recently-added entries come first, which is a good-enough recency proxy.
   */
  async getHistory(max = 50): Promise<ComfyHistoryItem[]> {
    const res = await tracedFetch(`${this.baseUrl}/history?max_items=${max}`, {
      tag: "history",
      timeoutMs: 6_000,
    });
    if (!res.ok) throw new ComfyError(`/history → HTTP ${res.status}`);
    const data = (await res.json().catch(() => ({}))) as Record<string, HistoryEntry>;
    const out: ComfyHistoryItem[] = [];
    for (const promptId of Object.keys(data).reverse()) {
      const entry = data[promptId];
      const images: ComfyHistoryItem["images"] = [];
      for (const nodeOutput of Object.values(entry?.outputs ?? {})) {
        for (const img of nodeOutput.images ?? []) images.push(img);
      }
      out.push({
        promptId,
        status: entry?.status?.status_str,
        completed: entry?.status?.completed,
        images,
      });
    }
    return out;
  }

  /** Interrupt whatever ComfyUI is ACTIVELY rendering (`POST /interrupt`). */
  async interrupt(): Promise<void> {
    const res = await tracedFetch(`${this.baseUrl}/interrupt`, {
      tag: "queue-status",
      timeoutMs: 5_000,
      method: "POST",
    });
    if (!res.ok) throw new ComfyError(`/interrupt → HTTP ${res.status}`);
  }

  /** Clear ComfyUI's entire PENDING queue (`POST /queue {clear:true}`). */
  async clearQueue(): Promise<void> {
    const res = await tracedFetch(`${this.baseUrl}/queue`, {
      tag: "queue-status",
      timeoutMs: 5_000,
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ clear: true }),
    });
    if (!res.ok) throw new ComfyError(`/queue clear → HTTP ${res.status}`);
  }

  /**
   * Cancel a single PENDING job by promptId (`POST /queue {delete:[id]}`). Only
   * affects queued (not-yet-running) jobs; use `interrupt()` to abort the running
   * one. No-op-safe: ComfyUI ignores ids it can't find.
   */
  async deleteQueueItem(promptId: string): Promise<void> {
    const res = await tracedFetch(`${this.baseUrl}/queue`, {
      tag: "queue-status",
      timeoutMs: 5_000,
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ delete: [promptId] }),
    });
    if (!res.ok) throw new ComfyError(`/queue delete → HTTP ${res.status}`);
  }

  /**
   * Stage an image into ComfyUI's `input/` via `/upload/image` so a `LoadImage`
   * node can reference it by name (img2img / edit / IP-Adapter conditioning).
   * Returns the filename ComfyUI stored it under. Pass raw bytes; the caller
   * owns reading from disk (this layer stays filesystem-agnostic).
   */
  async uploadImage(bytes: Buffer, filename: string): Promise<string> {
    const form = new FormData();
    const blob = new Blob([new Uint8Array(bytes)], { type: "image/png" });
    form.append("image", blob, filename);
    form.append("overwrite", "true");
    const res = await tracedFetch(`${this.baseUrl}/upload/image`, {
      tag: "upload",
      timeoutMs: 30_000,
      method: "POST",
      body: form,
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new ComfyError(`/upload/image → HTTP ${res.status}: ${body.slice(0, 200)}`);
    }
    const parsed = (await res.json().catch(() => ({}))) as { name?: string };
    return parsed.name ?? filename;
  }

  async runWorkflow(workflow: Record<string, unknown>): Promise<ComfyImage[]> {
    const { images } = await this.runWorkflowWithProgress(workflow);
    return images;
  }

  /**
   * Like `runWorkflow`, but surfaces the ComfyUI `promptId` (via `onPromptId`,
   * fired as soon as the job is queued) and streams live progress/executing
   * frames (via `onProgress`). Returns the prompt id alongside the images so
   * callers (e.g. a facade) can correlate and report. Falls back to /history
   * polling if the websocket drops, identical to `runWorkflow`.
   */
  async runWorkflowWithProgress(
    workflow: Record<string, unknown>,
    opts: {
      onPromptId?: (promptId: string) => void;
      onProgress?: (e: RunProgress) => void;
    } = {},
  ): Promise<{ promptId: string; images: ComfyImage[] }> {
    const ws = getComfyWs(this.baseUrl);
    // Connect early so the ws is ready by the time /prompt returns. Failure to
    // connect is non-fatal — `awaitCompletion` returns "fallback" and we poll.
    void ws.ready().catch(() => undefined);
    const promptId = await this.queue(workflow);
    opts.onPromptId?.(promptId);

    // Attach a progress subscription for the lifetime of this job.
    let unsub: (() => void) | undefined;
    if (opts.onProgress) {
      const handler = opts.onProgress;
      handler({ phase: "queued", promptId });
      unsub = ws.subscribe(promptId, {
        onExecuting: (node) => handler({ phase: "executing", promptId, node }),
        onProgress: (value, max, node) =>
          handler({ phase: "progress", promptId, value, max, node }),
        onError: (err) =>
          handler({ phase: "error", promptId, message: `${err.exceptionType}: ${err.exceptionMessage}` }),
      });
    }

    try {
      const result = await ws.awaitCompletion(promptId);
      if ("ok" in result && result.ok === false) {
        throw new ComfyError(formatExecutionError(result.error));
      }
      let images: ComfyImage[];
      if ("ok" in result && result.ok === "fallback") {
        // ws dropped before completion — fall back to the historical poll path.
        const entry = await this.pollHistory(promptId);
        images = await this.collectImages(entry);
      } else {
        // ws confirmed executing:null. /history is still the source of truth for
        // output filenames (executed.output payloads are inconsistent across
        // Comfy versions).
        const entry = await this.fetchHistoryEntry(promptId);
        images = await this.collectImages(entry);
      }
      opts.onProgress?.({ phase: "done", promptId });
      return { promptId, images };
    } finally {
      unsub?.();
    }
  }

  private async queue(workflow: Record<string, unknown>): Promise<string> {
    const res = await tracedFetch(`${this.baseUrl}/prompt`, {
      tag: "queue",
      timeoutMs: 10_000,
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: workflow, client_id: this.clientId }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new ComfyError(`ComfyUI /prompt ${res.status}: ${body.slice(0, 500)}`);
    }
    const data = (await res.json()) as QueueResponse;
    if (data.node_errors && Object.keys(data.node_errors).length > 0) {
      throw new ComfyError(`ComfyUI rejected workflow: ${JSON.stringify(data.node_errors).slice(0, 500)}`);
    }
    if (!data.prompt_id) throw new ComfyError("ComfyUI /prompt returned no prompt_id");
    return data.prompt_id;
  }

  // Final history fetch for output filenames after ws says executing:null.
  // Bounded retry handles the rare case where ws fires before disk has flushed.
  private async fetchHistoryEntry(promptId: string): Promise<HistoryEntry> {
    const delays = [0, 200, 400, 800];
    for (const delay of delays) {
      if (delay > 0) await new Promise((r) => setTimeout(r, delay));
      const res = await tracedFetch(`${this.baseUrl}/history/${promptId}`, {
        tag: "history",
        timeoutMs: 5_000,
      });
      if (!res.ok) continue;
      const data = (await res.json()) as Record<string, HistoryEntry>;
      const entry = data[promptId];
      if (!entry) continue;
      if (entry.status?.status_str === "error") {
        throw new ComfyError(`ComfyUI job failed: ${JSON.stringify(entry.status.messages).slice(0, 500)}`);
      }
      if (entry.outputs) return entry;
    }
    throw new ComfyError(`ComfyUI job ${promptId} reported done but /history had no outputs`);
  }

  // Fallback completion path used when the websocket drops mid-job. Identical
  // to the pre-ws behaviour: poll /history with exponential backoff.
  private async pollHistory(promptId: string): Promise<HistoryEntry> {
    const deadline = Date.now() + this.wsFallbackTimeoutMs;
    let backoff = 250;
    while (Date.now() < deadline) {
      const res = await tracedFetch(`${this.baseUrl}/history/${promptId}`, {
        tag: "history",
        timeoutMs: 5_000,
      });
      if (res.ok) {
        const data = (await res.json()) as Record<string, HistoryEntry>;
        const entry = data[promptId];
        if (entry?.status?.completed === true || entry?.outputs) {
          if (entry.status?.status_str === "error") {
            throw new ComfyError(`ComfyUI job failed: ${JSON.stringify(entry.status.messages).slice(0, 500)}`);
          }
          return entry;
        }
      }
      await new Promise((r) => setTimeout(r, backoff));
      backoff = Math.min(backoff * 1.5, 2_000);
    }
    throw new ComfyError(`ComfyUI job ${promptId} did not complete within ${this.wsFallbackTimeoutMs}ms (ws-drop fallback)`);
  }

  private async collectImages(entry: HistoryEntry): Promise<ComfyImage[]> {
    const out: ComfyImage[] = [];
    for (const nodeOutput of Object.values(entry.outputs ?? {})) {
      for (const img of nodeOutput.images ?? []) {
        const url =
          `${this.baseUrl}/view?filename=${encodeURIComponent(img.filename)}` +
          `&subfolder=${encodeURIComponent(img.subfolder)}&type=${encodeURIComponent(img.type)}`;
        const res = await fetchWith404Retry(url);
        if (!res.ok) throw new ComfyError(`ComfyUI /view ${res.status} for ${img.filename}`);
        const bytes = Buffer.from(await res.arrayBuffer());
        out.push({ ...img, bytes });
      }
    }
    if (out.length === 0) throw new ComfyError("ComfyUI job completed with no output images");
    return out;
  }
}

// Bounded retry for /view 404s — ws can fire executing:null before the file
// is fully flushed to disk on slow storage.
async function fetchWith404Retry(url: string): Promise<Response> {
  const delays = [0, 200, 400, 800];
  let last: Response | null = null;
  for (const delay of delays) {
    if (delay > 0) await new Promise((r) => setTimeout(r, delay));
    last = await tracedFetch(url, { tag: "view", timeoutMs: 15_000 });
    if (last.status !== 404) return last;
  }
  return last as Response;
}

function formatExecutionError(err: ComfyExecutionError): string {
  const head = `${err.exceptionType}: ${err.exceptionMessage} (node ${err.nodeId} ${err.nodeType})`;
  const tail = err.traceback.length > 0 ? `\n${err.traceback.join("")}` : "";
  return `ComfyUI execution_error — ${head}${tail}`.slice(0, 4000);
}
