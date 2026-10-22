// ComfyService — the complete intermediary between an application and ComfyUI.
//
// The app supplies INTENT (prompt, size, which checkpoint/LoRAs, where to save).
// Everything that touches ComfyUI — building the workflow graph, queueing,
// running, streaming progress, collecting image bytes, and the optional
// ComfyUI-side pixel post-process — lives behind this facade. The app never
// constructs a raw graph, opens the websocket, or calls /prompt itself.
//
// Filesystem note: saving + the pixel pipeline are OPTIONAL and pull in `sharp`
// lazily (dynamic import) so consumers that only want image buffers don't need
// sharp installed. node:fs is imported statically (always available in Node).

import { Buffer } from "node:buffer";
import { existsSync } from "node:fs";
import { writeFile, mkdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import {
  ComfyClient,
  type ComfyImage,
  type ComfyModels,
  type ComfyQueueState,
  type ComfyHistoryItem,
} from "./comfy-client.js";
import { setComfyClientIdPrefix } from "./comfy-ws.js";
import { ImageJobQueue } from "./queue.js";
import {
  buildTextToImageWorkflow,
  type ControlNetSpec,
  type LoraSpec,
  type WorkflowParams,
} from "./workflow.js";
import { buildEditWorkflow, type EditWorkflowParams } from "./edit-workflow.js";
import type { RemoveBackgroundOptions } from "./postprocess.js";

// ─── Config ──────────────────────────────────────────────────────────────────

export interface ComfyServiceConfig {
  /** ComfyUI base URL. Default http://127.0.0.1:8188. */
  url?: string;
  /** Default checkpoint (ComfyUI subpath) used when a request omits one. */
  checkpoint?: string;
  /** Client-id prefix for the websocket (branding only). Default "comfy". */
  clientIdPrefix?: string;
  /** Per-job timeout in ms (ComfyUI generation). Default 120_000. */
  perJobTimeoutMs?: number;
  /**
   * Bound (ms) on the websocket-DROP fallback `/history` poll. When the ws
   * drops mid-job we fall back to polling ComfyUI's `/history`; without a tight
   * bound this blocks the (serial) queue for the full `perJobTimeoutMs` even
   * when ComfyUI is dead. Default: min(perJobTimeoutMs, 30_000) so a crashed
   * ComfyUI fails fast and frees the gate for the next job.
   */
  wsFallbackTimeoutMs?: number;
  /** Max queued+running jobs before submit() rejects. Default 4. */
  queueMaxDepth?: number;
  /**
   * How many jobs may run/stack concurrently onto ComfyUI's queue. Default 1
   * (strict serial — one job on the GPU at a time). Adjustable at runtime via
   * `setQueueDepth()`.
   */
  queueConcurrency?: number;
  /** Generation defaults applied when a request omits the field. */
  defaults?: Partial<GenerationDefaults>;
}

export interface GenerationDefaults {
  width: number;
  height: number;
  steps: number;
  cfg: number;
  sampler: string;
  scheduler: string;
  negativePrompt: string;
}

const BUILTIN_DEFAULTS: GenerationDefaults = {
  width: 1024,
  height: 1024,
  steps: 30,
  cfg: 5.5,
  sampler: "euler_ancestral",
  scheduler: "karras",
  negativePrompt:
    "worst quality, low quality, lowres, blurry, jpeg artifacts, watermark, text, signature",
};

// ─── Progress ────────────────────────────────────────────────────────────────

export type ProgressEvent =
  | { phase: "queued"; promptId: string }
  | { phase: "executing"; promptId: string; node: string | null }
  | { phase: "progress"; promptId: string; value: number; max: number; node: string }
  | { phase: "done"; promptId: string }
  | { phase: "error"; promptId: string; message: string };

export type ProgressHandler = (e: ProgressEvent) => void;

// ─── Pixel post-process / save options ───────────────────────────────────────

export interface PixelateRequest {
  /** Target pixel-grid long edge, px (e.g. 64–128). */
  size: number;
  /** Palette colour count (e.g. 16–32). Omit/0 to skip quantization. */
  colors?: number;
  /** Integer nearest-neighbor upscale of the grid for crisp display export. */
  upscale?: number;
  /** Square-crop to size×size instead of aspect-preserving. */
  square?: boolean;
  /** Thicken dark line work by N px before downscale (0 off, 1 subtle). */
  lineThicken?: number;
}

export interface SaveRequest {
  /** Directory to write outputs into (created if missing). */
  dir: string;
  /** Base filename (without extension). Index is appended for batches. */
  basename: string;
  /** If set, each saved image is pixel-processed before writing. */
  pixelate?: PixelateRequest;
  /**
   * If set, the saved image's background is keyed to transparent by a CORNER
   * FLOOD-FILL (the prompt must force a plain background). Applied AFTER pixelate
   * so it keys flat colours cleanly. `true` uses defaults; a number sets the
   * per-channel colour tolerance; an object additionally configures the white
   * OUTLINE stroke + edge feather ({ tolerance?, outline?, outlineColor?, feather? }).
   * CPU-only — no GPU matte node, so no segfault on low-VRAM machines.
   */
  removeBackground?: boolean | number | RemoveBackgroundOptions;
  /**
   * KEY BEFORE PIXELATE. By default the bg is removed AFTER pixelate (legacy order —
   * keys flat quantized colours). When true, the bg is keyed on the FULL-RES,
   * true-colour image FIRST, then pixelate runs on the already-transparent result.
   * This gives a far cleaner silhouette: the keyer sees real anti-aliased edges
   * (not edges the quantizer merged into the bg palette), so it stops at the true
   * subject boundary instead of nibbling into it. Opt-in so existing callers
   * (pixelate-then-key) are byte-identical. No effect unless BOTH pixelate and
   * removeBackground are set.
   */
  keyBeforePixelate?: boolean;
}

// ─── Request / result shapes ─────────────────────────────────────────────────

/**
 * Optional ControlNet conditioning on a generate request. `image` may be EITHER
 * a local filesystem path (it is read and uploaded to ComfyUI's input/ for you,
 * exactly like `edit()` does its source image) OR an already-staged input name
 * (passed straight to `LoadImage`). The strength/percent fields are optional and
 * default to stylized-friendly values (0.55 / 0.0 / 0.7).
 */
export interface ControlNetRequest {
  model: string;
  image: string;
  strength?: number;
  startPercent?: number;
  endPercent?: number;
}

export interface GenerateRequest {
  positivePrompt: string;
  negativePrompt?: string;
  checkpoint?: string;
  loras?: LoraSpec[];
  width?: number;
  height?: number;
  steps?: number;
  cfg?: number;
  sampler?: string;
  scheduler?: string;
  seed?: number;
  filenamePrefix?: string;
  /** Optional: OpenPose/image-hint pose conditioning (see ControlNetRequest). */
  controlNet?: ControlNetRequest;
  /** Optional: save (and optionally pixelate) the outputs to disk. */
  save?: SaveRequest;
  /** Optional: per-request progress stream. */
  onProgress?: ProgressHandler;
}

export interface EditRequest {
  /** Path to a local source image (uploaded to ComfyUI input/). */
  sourceImagePath: string;
  instruction: string;
  negativePrompt?: string;
  unetName: string;
  clipName: string;
  vaeName: string;
  denoise?: number;
  steps?: number;
  cfg?: number;
  sampler?: string;
  scheduler?: string;
  seed?: number;
  filenamePrefix?: string;
  save?: SaveRequest;
  onProgress?: ProgressHandler;
}

export interface GeneratedImage {
  /** Raw image bytes (post-pixelate if a save+pixelate was requested). */
  bytes: Buffer;
  /** Path written to, if `save` was provided. */
  path?: string;
  /** The ComfyUI source descriptor. */
  source: { filename: string; subfolder: string; type: string };
}

export interface GenerateResult {
  promptId: string;
  images: GeneratedImage[];
}

// ─── Service ─────────────────────────────────────────────────────────────────

export class ComfyService {
  private readonly url: string;
  private readonly client: ComfyClient;
  private readonly queue: ImageJobQueue;
  private readonly defaults: GenerationDefaults;
  private readonly checkpoint?: string;

  constructor(private readonly config: ComfyServiceConfig = {}) {
    this.url = (config.url ?? "http://127.0.0.1:8188").replace(/\/+$/, "");
    if (config.clientIdPrefix) setComfyClientIdPrefix(config.clientIdPrefix);
    const perJobTimeoutMs = config.perJobTimeoutMs ?? 120_000;
    // Tight fallback bound by default: a dropped ws shouldn't pin the serial queue
    // for the full per-job budget when ComfyUI is actually dead.
    const wsFallbackTimeoutMs =
      config.wsFallbackTimeoutMs ?? Math.min(perJobTimeoutMs, 30_000);
    this.client = new ComfyClient(this.url, perJobTimeoutMs, wsFallbackTimeoutMs);
    this.queue = new ImageJobQueue(config.queueMaxDepth ?? 4, config.queueConcurrency ?? 1);
    this.defaults = { ...BUILTIN_DEFAULTS, ...config.defaults };
    this.checkpoint = config.checkpoint;
  }

  /** Reachability check with a friendly message. */
  probe(): Promise<{ reachable: boolean; message: string }> {
    return this.client.probe();
  }

  /** Discover installed checkpoints, LoRAs, VAEs, samplers, schedulers. */
  listModels(): Promise<ComfyModels> {
    return this.client.listModels();
  }

  // ── ComfyUI queue control (passthroughs to the low-level client) ───────────

  /** Read ComfyUI's live queue (running + pending). */
  getQueue(): Promise<ComfyQueueState> {
    return this.client.getQueue();
  }

  /** Read ComfyUI's recent job history (newest first). */
  getHistory(max?: number): Promise<ComfyHistoryItem[]> {
    return this.client.getHistory(max);
  }

  /** Interrupt the job ComfyUI is actively rendering. */
  interrupt(): Promise<void> {
    return this.client.interrupt();
  }

  /** Clear ComfyUI's entire pending queue. */
  clearQueue(): Promise<void> {
    return this.client.clearQueue();
  }

  /** Cancel a single PENDING ComfyUI job by promptId. */
  deleteQueueItem(promptId: string): Promise<void> {
    return this.client.deleteQueueItem(promptId);
  }

  /**
   * Live-adjust how many jobs the internal queue lets run concurrently (how many
   * we stack onto ComfyUI's own queue at once). 1 = strict serial (default).
   */
  setQueueDepth(n: number): void {
    this.queue.setMaxConcurrent(n);
  }

  /** Current concurrency ceiling (jobs allowed to run/stack at once). */
  getQueueDepth(): number {
    return this.queue.getMaxConcurrent();
  }

  /**
   * Text-to-image. Builds the SDXL/Illustrious graph (with optional LoRA
   * stack), queues + runs it, streams progress, returns image buffers, and
   * optionally saves + pixelates them.
   */
  async generate(req: GenerateRequest): Promise<GenerateResult> {
    const checkpoint = req.checkpoint ?? this.checkpoint;
    if (!checkpoint) {
      throw new Error(
        "ComfyService.generate: no checkpoint provided and no default configured.",
      );
    }
    const params: WorkflowParams = {
      checkpoint,
      positivePrompt: req.positivePrompt,
      negativePrompt: req.negativePrompt ?? this.defaults.negativePrompt,
      width: req.width ?? this.defaults.width,
      height: req.height ?? this.defaults.height,
      steps: req.steps ?? this.defaults.steps,
      cfg: req.cfg ?? this.defaults.cfg,
      sampler: req.sampler ?? this.defaults.sampler,
      scheduler: req.scheduler ?? this.defaults.scheduler,
      seed: req.seed ?? randomSeed(),
      loras: req.loras ?? [],
      filenamePrefix: req.filenamePrefix ?? "comfy",
    };
    if (req.controlNet) {
      params.controlNet = await this.resolveControlNet(req.controlNet);
    }
    const workflow = buildTextToImageWorkflow(params);
    return this.run(workflow, req.save, req.onProgress);
  }

  /**
   * Run a CALLER-BUILT ComfyUI graph through the SAME reliable path as
   * `generate()` — the depth-bounded concurrency queue + websocket progress
   * stream + `/history` fallback. Use this for bespoke graphs the built-in
   * workflow builders don't cover (IP-Adapter scenes, GGUF backgrounds, etc.)
   * instead of POSTing `/prompt` directly: a direct POST bypasses the queue gate
   * (so it races other jobs onto the GPU) and gets no progress events.
   *
   * The graph must include its own SaveImage node; the returned images carry the
   * raw bytes (post-`save` pixelate if `save` is provided) plus the ComfyUI
   * source descriptors, so callers can persist/post-process exactly as they did
   * with a manual `/history` + `/view` fetch.
   */
  async generateGraph(
    graph: Record<string, unknown>,
    opts: { save?: SaveRequest; onProgress?: ProgressHandler } = {},
  ): Promise<GenerateResult> {
    return this.run(graph, opts.save, opts.onProgress);
  }

  /**
   * Turn a request-level ControlNet into a workflow-level one: if `image` is a
   * local path that exists, read + upload it to ComfyUI's input/ (reusing the
   * same upload path as `edit()`) and reference the stored name; otherwise treat
   * `image` as an already-staged input name. Fills strength/percent defaults.
   * A stable, path-derived upload name means repeated batch calls with the same
   * skeleton reuse one input file (uploadImage overwrites).
   */
  private async resolveControlNet(cn: ControlNetRequest): Promise<ControlNetSpec> {
    let image = cn.image;
    if (existsSync(cn.image)) {
      const bytes = await readFile(cn.image);
      image = await this.client.uploadImage(bytes, `pose_${stableStamp(cn.image)}.png`);
    }
    return {
      model: cn.model,
      image,
      strength: cn.strength ?? 0.55,
      startPercent: cn.startPercent ?? 0.0,
      endPercent: cn.endPercent ?? 0.7,
    };
  }

  /**
   * Instruction-following img2img edit (Qwen-Image-Edit graph). Uploads the
   * source image, runs the edit, returns/saves the result.
   */
  async edit(req: EditRequest): Promise<GenerateResult> {
    const bytes = await readFile(req.sourceImagePath);
    const stamp = stableStamp(req.sourceImagePath);
    const uploaded = await this.client.uploadImage(bytes, `edit_src_${stamp}.png`);
    const params: EditWorkflowParams = {
      unetName: req.unetName,
      clipName: req.clipName,
      vaeName: req.vaeName,
      sourceImage: uploaded,
      instruction: req.instruction,
      negativePrompt: req.negativePrompt ?? this.defaults.negativePrompt,
      denoise: req.denoise ?? 0.6,
      steps: req.steps ?? this.defaults.steps,
      cfg: req.cfg ?? this.defaults.cfg,
      sampler: req.sampler ?? this.defaults.sampler,
      scheduler: req.scheduler ?? this.defaults.scheduler,
      seed: req.seed ?? randomSeed(),
      filenamePrefix: req.filenamePrefix ?? "comfy_edit",
    };
    const workflow = buildEditWorkflow(params);
    return this.run(workflow, req.save, req.onProgress);
  }

  // ── shared run path: queue → progress sub → run → collect → save ──────────

  private async run(
    workflow: Record<string, unknown>,
    save: SaveRequest | undefined,
    onProgress: ProgressHandler | undefined,
  ): Promise<GenerateResult> {
    // queue.submit serializes jobs (depth-bounded); runWorkflowWithProgress
    // surfaces the real promptId and streams progress frames straight through.
    const { promptId, images } = await this.queue.submit(() =>
      this.client.runWorkflowWithProgress(workflow, {
        onProgress: onProgress
          ? (e) => onProgress(e as ProgressEvent) // RunProgress ⊆ ProgressEvent
          : undefined,
      }),
    );
    const out = await this.persist(images, save);
    return { promptId, images: out };
  }

  private async persist(
    images: ComfyImage[],
    save: SaveRequest | undefined,
  ): Promise<GeneratedImage[]> {
    const out: GeneratedImage[] = [];
    for (let i = 0; i < images.length; i++) {
      const img = images[i];
      let bytes = img.bytes;
      let path: string | undefined;
      if (save) {
        const rbOpts =
          typeof save.removeBackground === "number"
            ? save.removeBackground
            : typeof save.removeBackground === "object"
            ? save.removeBackground
            : undefined;
        const doKey = !!save.removeBackground;
        // KEY-BEFORE-PIXELATE (opt-in): remove bg on the full-res true-colour image
        // first, so the keyer sees real AA edges (not quantizer-merged ones) and cuts
        // the true silhouette. Then pixelate the already-transparent result.
        if (doKey && save.keyBeforePixelate) {
          const { removeBackground } = await import("./postprocess.js");
          bytes = await removeBackground(bytes, rbOpts);
        }
        if (save.pixelate) {
          const { pixelate } = await import("./postprocess.js");
          bytes = await pixelate(bytes, save.pixelate);
        }
        // LEGACY order: background removal AFTER pixelate (keys flat quantized
        // colours). Used unless keyBeforePixelate already did the key above.
        if (doKey && !save.keyBeforePixelate) {
          const { removeBackground } = await import("./postprocess.js");
          bytes = await removeBackground(bytes, rbOpts);
        }
        const suffix = images.length > 1 ? `_${i + 1}` : "";
        path = join(save.dir, `${save.basename}${suffix}.png`);
        await mkdir(dirname(path), { recursive: true });
        await writeFile(path, bytes);
      }
      out.push({
        bytes,
        path,
        source: { filename: img.filename, subfolder: img.subfolder, type: img.type },
      });
    }
    return out;
  }
}

// ─── helpers ─────────────────────────────────────────────────────────────────

function randomSeed(): number {
  // ComfyUI accepts uint53 seeds.
  return Math.floor(Math.random() * 0x1f_ff_ff_ff_ff_ff_ff);
}

/** Deterministic-ish stamp from a path, avoiding Date.now noise in filenames. */
function stableStamp(path: string): string {
  let h = 0;
  for (let i = 0; i < path.length; i++) h = (h * 31 + path.charCodeAt(i)) >>> 0;
  return h.toString(36);
}
