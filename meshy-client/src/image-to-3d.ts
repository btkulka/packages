// Image to 3D (docs.meshy.ai/api/image-to-3d, read 2026-11-19): POST /openapi/v1/image-to-3d answers
// { result: <task id> } and the task runs at Meshy; GET /openapi/v1/image-to-3d/{id} reads it (status PENDING,
// IN_PROGRESS, SUCCEEDED, FAILED or CANCELED; model_urls once it SUCCEEDED, as signed URLs that expire). The image
// goes in the body as a data URI, so a local file needs no upload step.
//
// Credits are spent when the task is created: `create` is retried only on a 429 (refused, nothing created), never
// on a 5xx or a timeout, after which the task may exist (look for it with `list` before creating another).

import { sleep } from "@btkulka/http-kit";
import { dataUri, IMAGE_TYPES, MAX_IMAGE_BYTES, type ImageMimeType } from "./bytes.js";
import type { CallOptions, Transport } from "./call.js";
import { invalid, MeshyError, wrap, type TaskError } from "./errors.js";
import { aiModel, DEFAULT_AI_MODEL, DEFAULT_SMART_TOPOLOGY_MODEL, type GeometryResolution, type ModelType, type TextureResolution } from "./pricing.js";

export type Topology = "triangle" | "quad";
export type PoseMode = "a-pose" | "t-pose";
export type ModelFormat = "glb" | "obj" | "fbx" | "stl" | "usdz" | "3mf";
export type TaskStatus = "PENDING" | "IN_PROGRESS" | "SUCCEEDED" | "FAILED" | "CANCELED";

export const TOPOLOGIES: readonly Topology[] = ["triangle", "quad"];
export const POSE_MODES: readonly PoseMode[] = ["a-pose", "t-pose"];
export const MODEL_FORMATS: readonly ModelFormat[] = ["glb", "obj", "fbx", "stl", "usdz", "3mf"];
export const TEXTURE_RESOLUTIONS: readonly TextureResolution[] = ["2k", "4k", "8k"];
export const GEOMETRY_RESOLUTIONS: readonly GeometryResolution[] = ["standard", "2k", "4k"];
export const MODEL_TYPES: readonly ModelType[] = ["standard", "smart-topology"];
/** texture_prompt's limit. */
export const MAX_TEXTURE_PROMPT = 800;

/** A local image's bytes (or base64) and type. */
export interface ImageBytes {
  data: Uint8Array | string;
  mimeType: ImageMimeType;
}

export interface ImageTo3dRequest {
  /** A public https URL, a `data:image/...;base64,` URI, or the bytes (sent as a data URI). JPG, PNG or WebP, up to 20 MB, each side at least 32 px. */
  image: string | ImageBytes;
  /** `latest` (Meshy's default, Meshy 7.1), `meshy-7.1`, `meshy-6`, `meshy-6-lite`; `meshy-t2`, `meshy-t2.5` for Smart Topology. */
  aiModel?: string;
  /** `standard` (Meshy's default) or `smart-topology`. A Smart Topology ai_model sets it by itself. */
  modelType?: ModelType;
  /** Texture it too. Default **false** here (mesh only); Meshy's own default is true. */
  shouldTexture?: boolean;
  /** Metallic, roughness and normal maps as well. Needs shouldTexture. */
  enablePbr?: boolean;
  /** 2k (Meshy's default), 4k, 8k. Needs shouldTexture; meshy-6-lite does 2k only. */
  textureResolution?: TextureResolution;
  /** Steers the texture, up to 800 characters. Needs shouldTexture. */
  texturePrompt?: string;
  /** `meshy-7`, `meshy-n1`, `meshy-6-lite` (the price doesn't change). Needs shouldTexture. */
  textureModel?: string;
  /** Run the remesh pass. Meshy's default: true for meshy-6-lite, false for the rest. Smart Topology ignores it. */
  shouldRemesh?: boolean;
  /** `triangle` (Meshy's default) or `quad` (quad-dominant). Only when remeshing; quad not on Smart Topology. Implies shouldRemesh on standard models. */
  topology?: Topology;
  /** The remesh's target: 100 to 300 000 on standard models (default 30 000; implies shouldRemesh); meshy-t2 up to 15 000, meshy-t2.5 up to 30 000. */
  targetPolycount?: number;
  /** For characters: `a-pose` or `t-pose`. Left out: no pose. */
  poseMode?: PoseMode;
  /** Ultra geometry: `2k` (2048³) or `4k` (4096³), +5 credits; `standard` (the default). 4k needs Meshy 7.1. */
  geometryResolution?: GeometryResolution;
  /** Meshy cleans up the image first (its default, true). false keeps the exact look. Only meshy-6, meshy-7.1, latest. */
  imageEnhancement?: boolean;
  /** The formats Meshy makes (fewer is faster). Meshy's default: all but 3mf. */
  targetFormats?: ModelFormat[];
  /** Screen the inputs; a harmful one answers 400 and nothing is made. */
  moderation?: boolean;
  /** Anything else, sent as given and over the fields above (Meshy's own names: `auto_size`, `decimation_mode`…). */
  extra?: Record<string, unknown>;
}

/** The body `create` sends. */
export interface ImageTo3dBody {
  image_url: string;
  ai_model: string;
  model_type?: ModelType;
  should_texture: boolean;
  enable_pbr?: boolean;
  texture_resolution?: TextureResolution;
  texture_prompt?: string;
  texture_model?: string;
  should_remesh?: boolean;
  topology?: Topology;
  target_polycount?: number;
  pose_mode?: PoseMode;
  geometry_resolution?: GeometryResolution;
  image_enhancement?: boolean;
  target_formats?: ModelFormat[];
  moderation?: boolean;
  [extra: string]: unknown;
}

/** A Meshy task, as GET answers it. Times are Unix milliseconds (0 until they happen). */
export interface Task {
  id: string;
  type?: string;
  status: TaskStatus | (string & {});
  /** Percent, 0 until it starts, 100 when it succeeded. */
  progress?: number;
  created_at?: number;
  started_at?: number;
  finished_at?: number;
  expires_at?: number;
  /** Tasks ahead in the queue, while PENDING. */
  preceding_tasks?: number;
  /** Signed download URLs by format: glb, fbx, obj, usdz, mtl, stl, 3mf, pre_remeshed_glb. Only what was made. */
  model_urls?: Partial<Record<ModelFormat | "mtl" | "pre_remeshed_glb", string>> & Record<string, string | undefined>;
  thumbnail_url?: string;
  /** Texture maps, usually one set: base_color, and metallic, roughness, normal with PBR; emission sometimes. */
  texture_urls?: Array<Record<string, string | undefined>>;
  texture_prompt?: string;
  geometry_resolution?: string;
  task_error?: TaskError | null;
  /** Credits it used (0 once FAILED: refunded). */
  consumed_credits?: number;
  [field: string]: unknown;
}

export interface WaitOptions extends CallOptions {
  /** The first wait between polls. Default 5 000. */
  intervalMs?: number;
  /** Each wait is this much longer than the last. Default 1.5. */
  factor?: number;
  /** The longest wait between polls. Default 20 000. A Retry-After from Meshy is honoured up to this. */
  maxIntervalMs?: number;
  /** Give up after this long (code wait_timeout; the task carries on at Meshy, so wait again by id). Default 60 minutes (Meshy's own example). */
  timeoutMs?: number;
  /** After each poll, with how long it has been. */
  onPoll?: (task: Task, elapsedMs: number) => void;
}

export interface ListOptions extends CallOptions {
  /** From 1 (up to 255). */
  pageNum?: number;
  /** Up to 100. Default 10. */
  pageSize?: number;
  /** Newest first by default. */
  sortBy?: "+created_at" | "-created_at";
}

export interface GenerateResult {
  task: Task;
  /** The GLB's bytes. */
  glb: Uint8Array;
}

export interface ImageTo3dApi {
  /** The body `create` would send, after the same checks. Sends nothing: what a dry run prints. */
  request(req: ImageTo3dRequest): ImageTo3dBody;
  /** **Paid.** Creates the task and answers its id. Retried only on a 429. */
  create(req: ImageTo3dRequest, o?: CallOptions): Promise<string>;
  get(id: string, o?: CallOptions): Promise<Task>;
  /** Polls until SUCCEEDED (answered) or FAILED / CANCELED (thrown, category task_failed). */
  wait(idOrTask: string | Task, o?: WaitOptions): Promise<Task>;
  list(o?: ListOptions): Promise<Task[]>;
  /** Deletes a task for good. A PENDING one is refunded; an IN_PROGRESS one can't be (409). */
  delete(id: string, o?: CallOptions): Promise<void>;
  /** create, wait, download the GLB. Needs glb among targetFormats (when they're given). */
  generate(req: ImageTo3dRequest, o?: WaitOptions): Promise<GenerateResult>;
}

const PATH = "/openapi/v1/image-to-3d";
const FINAL = new Set(["SUCCEEDED", "FAILED", "CANCELED"]);

const has = <T>(list: readonly T[], v: unknown): v is T => list.includes(v as T);

function imageUrlOf(image: ImageTo3dRequest["image"]): string {
  if (typeof image === "string") {
    const s = image.trim();
    if (/^data:image\/(png|jpe?g|webp);base64,/i.test(s)) return s;
    if (/^https?:\/\//i.test(s)) return s;
    throw invalid("The image is a public https URL, a data:image/…;base64, URI, or bytes with their type.");
  }
  if (!image || !Object.values(IMAGE_TYPES).includes(image.mimeType)) throw invalid("Meshy takes PNG, JPEG or WebP images.");
  if (typeof image.data === "string") {
    const b64 = image.data.replace(/\s+/g, "");
    if (!b64) throw invalid("The image is empty.");
    if ((b64.length * 3) / 4 > MAX_IMAGE_BYTES) throw invalid("The image is over Meshy's 20 MB.");
    return `data:${image.mimeType};base64,${b64}`;
  }
  if (!image.data?.length) throw invalid("The image is empty.");
  if (image.data.length > MAX_IMAGE_BYTES) throw invalid("The image is over Meshy's 20 MB.");
  return dataUri(image.data, image.mimeType);
}

/** The request as Meshy's body, checked against what the docs say Meshy refuses. Throws MeshyError (validation). */
export function imageTo3dBody(req: ImageTo3dRequest): ImageTo3dBody {
  if (!req || typeof req !== "object") throw invalid("No request.");
  const image_url = imageUrlOf(req.image);
  const named = req.aiModel?.trim().toLowerCase() || undefined;
  if (req.modelType !== undefined && !has(MODEL_TYPES, req.modelType)) throw invalid(`model_type is standard or smart-topology, not ${req.modelType}.`);
  const known = named ? aiModel(named) : undefined;
  const modelType: ModelType = req.modelType ?? known?.modelType ?? "standard";
  if (known && known.modelType !== modelType) throw invalid(`${known.id} runs under model_type ${known.modelType}, not ${modelType}.`);
  const ai_model = named ?? (modelType === "smart-topology" ? DEFAULT_SMART_TOPOLOGY_MODEL : DEFAULT_AI_MODEL);
  const info = aiModel(ai_model);
  const smart = modelType === "smart-topology";
  const textured = req.shouldTexture === true;

  const body: ImageTo3dBody = smart ? { image_url, ai_model, model_type: "smart-topology", should_texture: textured } : { image_url, ai_model, should_texture: textured };

  const textureOnly: [keyof ImageTo3dRequest, string][] = [["enablePbr", "enable_pbr"], ["textureResolution", "texture_resolution"], ["texturePrompt", "texture_prompt"], ["textureModel", "texture_model"]];
  for (const [k, wire] of textureOnly) if (req[k] !== undefined && req[k] !== false && !textured) throw invalid(`${wire} needs should_texture (a mesh-only task has no texture).`);
  if (req.enablePbr) body.enable_pbr = true;
  if (req.textureResolution !== undefined) {
    if (!has(TEXTURE_RESOLUTIONS, req.textureResolution)) throw invalid(`texture_resolution is 2k, 4k or 8k, not ${req.textureResolution}.`);
    if (info && info.texture[req.textureResolution] == null) throw invalid(`${info.id} has no ${req.textureResolution} texture.`);
    body.texture_resolution = req.textureResolution;
  }
  if (req.texturePrompt !== undefined) {
    const p = req.texturePrompt.trim();
    if (p.length > MAX_TEXTURE_PROMPT) throw invalid(`texture_prompt is at most ${MAX_TEXTURE_PROMPT} characters (this is ${p.length}).`);
    if (p) body.texture_prompt = p;
  }
  if (req.textureModel) body.texture_model = req.textureModel.trim();

  if (req.topology !== undefined) {
    if (!has(TOPOLOGIES, req.topology)) throw invalid(`topology is triangle or quad, not ${req.topology}.`);
    if (smart && req.topology === "quad") throw invalid("Smart Topology makes triangles only (topology quad is refused).");
  }
  if (req.targetPolycount !== undefined) {
    const n = req.targetPolycount;
    const range = info?.polycount ?? { min: 100, max: 300_000 };
    if (!Number.isInteger(n) || n < range.min || n > range.max) throw invalid(`target_polycount for ${ai_model} is a whole number from ${range.min} to ${range.max}.`);
  }
  if (smart) {
    // Smart Topology ignores should_remesh; its polycount applies as it is.
    if (req.topology !== undefined) body.topology = req.topology;
    if (req.targetPolycount !== undefined) body.target_polycount = req.targetPolycount;
  } else {
    const wantsRemesh = req.topology !== undefined || req.targetPolycount !== undefined;
    if (wantsRemesh && req.shouldRemesh === false) throw invalid("topology and target_polycount only apply when remeshing: leave should_remesh on.");
    const remesh = req.shouldRemesh ?? (wantsRemesh ? true : undefined);
    if (remesh !== undefined) body.should_remesh = remesh;
    if (req.topology !== undefined) body.topology = req.topology;
    if (req.targetPolycount !== undefined) body.target_polycount = req.targetPolycount;
  }

  if (req.poseMode !== undefined) {
    if (!has(POSE_MODES, req.poseMode)) throw invalid(`pose_mode is a-pose or t-pose, not ${req.poseMode}.`);
    body.pose_mode = req.poseMode;
  }
  if (req.geometryResolution !== undefined) {
    const g = req.geometryResolution;
    if (!has(GEOMETRY_RESOLUTIONS, g)) throw invalid(`geometry_resolution is standard, 2k or 4k, not ${g}.`);
    if (g !== "standard" && info && !info.ultraResolutions.includes(g)) throw invalid(`${info.id} has no ${g} Ultra geometry (2k: latest, meshy-7.1 or meshy-7; 4k: latest or meshy-7.1).`);
    body.geometry_resolution = g;
  }
  if (req.imageEnhancement !== undefined) {
    if (info && !info.imageEnhancement) throw invalid(`image_enhancement works only with meshy-6, meshy-7.1 or latest, not ${info.id}.`);
    body.image_enhancement = req.imageEnhancement;
  }
  if (req.targetFormats !== undefined) {
    const formats = [...new Set(req.targetFormats.map((f) => String(f).trim().toLowerCase()))];
    const bad = formats.find((f) => !has(MODEL_FORMATS, f));
    if (bad) throw invalid(`target_formats are ${MODEL_FORMATS.join(", ")}; not ${bad}.`);
    if (!formats.length) throw invalid("target_formats needs at least one format.");
    body.target_formats = formats as ModelFormat[];
  }
  if (req.moderation !== undefined) body.moderation = req.moderation;
  return { ...body, ...(req.extra ?? {}) };
}

/** The task's failure (FAILED or CANCELED) as a MeshyError, or undefined while it hasn't failed. */
export function taskFailure(task: Task): MeshyError | undefined {
  if (task.status === "FAILED") {
    const e = task.task_error ?? {};
    const why = [e.type, e.code].filter(Boolean).join(", ");
    return new MeshyError(`Meshy task ${task.id} failed${why ? ` (${why})` : ""}: ${e.message || "no reason given"}`, { code: "task_failed", category: "task_failed", taskError: e, taskId: task.id, body: task });
  }
  if (task.status === "CANCELED") return new MeshyError(`Meshy task ${task.id} was canceled.`, { code: "task_canceled", category: "task_failed", taskId: task.id, body: task });
  return undefined;
}

export function imageTo3dApi({ call }: Transport, download: (url: string, o?: CallOptions) => Promise<Uint8Array>): ImageTo3dApi {
  const seg = (id: string) => {
    const v = (id ?? "").trim();
    if (!v) throw invalid("No task id given.");
    return encodeURIComponent(v);
  };
  const getAnswer = (id: string, o: CallOptions = {}) => call<Task>("GET", `${PATH}/${seg(id)}`, { signal: o.signal });

  const create = async (req: ImageTo3dRequest, o: CallOptions = {}): Promise<string> => {
    const body = imageTo3dBody(req);
    const r = await call<{ result?: unknown }>("POST", PATH, { body, signal: o.signal, retry: "refused", timeoutMs: 120_000 });
    const id = r.data?.result;
    if (typeof id !== "string" || !id) throw new MeshyError("Meshy answered the new task without an id.", { body: r.data });
    return id;
  };

  const wait = async (from: string | Task, o: WaitOptions = {}): Promise<Task> => {
    const started = Date.now();
    const timeoutMs = o.timeoutMs ?? 60 * 60_000;
    const factor = Math.max(1, o.factor ?? 1.5);
    const maxIntervalMs = o.maxIntervalMs ?? 20_000;
    let interval = Math.max(0, o.intervalMs ?? 5_000);
    let current: Task | undefined = typeof from === "string" ? undefined : from;
    let retryAfterMs: number | undefined;
    const id = typeof from === "string" ? from : from.id;
    try {
      for (;;) {
        if (current && FINAL.has(current.status)) {
          const failed = taskFailure(current);
          if (failed) throw failed;
          return current;
        }
        const elapsed = Date.now() - started;
        if (current && elapsed >= timeoutMs) {
          throw new MeshyError(`Meshy task ${id} is still ${current.status} (${current.progress ?? 0}%) after ${Math.round(elapsed / 1000)} s; it carries on at Meshy, so wait for it again by id.`, { code: "wait_timeout", category: "other", taskId: id });
        }
        if (current) {
          // Meshy sends Retry-After while a task runs: the wait is the longer of it and the backoff, up to the cap.
          const ms = Math.min(maxIntervalMs, Math.max(interval, retryAfterMs ?? 0));
          await sleep(Math.min(ms, Math.max(0, timeoutMs - elapsed)), o.signal);
          interval = Math.min(maxIntervalMs, interval * factor);
        }
        const r = await getAnswer(id, { signal: o.signal });
        current = r.data;
        retryAfterMs = r.retryAfterMs;
        if (!current || typeof current.status !== "string") throw new MeshyError(`Meshy answered task ${id} without a status.`, { body: r.data, taskId: id });
        o.onPoll?.(current, Date.now() - started);
      }
    } catch (err) {
      throw wrap(err);
    }
  };

  return {
    request: imageTo3dBody,
    create,
    get: async (id, o = {}) => (await getAnswer(id, o)).data,
    wait,
    async list(o = {}) {
      const r = await call<Task[]>("GET", PATH, { signal: o.signal, query: { page_num: o.pageNum, page_size: o.pageSize, sort_by: o.sortBy ?? "-created_at" } });
      return Array.isArray(r.data) ? r.data : [];
    },
    async delete(id, o = {}) {
      await call<unknown>("DELETE", `${PATH}/${seg(id)}`, { signal: o.signal });
    },
    async generate(req, o = {}) {
      if (req.targetFormats && !req.targetFormats.includes("glb")) throw invalid("generate downloads the GLB: put glb among targetFormats.");
      const id = await create(req, o);
      const task = await wait(id, o);
      const url = task.model_urls?.glb;
      if (!url) throw new MeshyError(`Meshy task ${id} succeeded without a GLB.`, { code: "no_model", category: "other", taskId: id, body: task });
      return { task, glb: await download(url, o) };
    },
  };
}
