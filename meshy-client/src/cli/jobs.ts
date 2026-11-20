// meshy-3d's jobs: from a JSON file or from --image/--name pairs, with the flags as defaults, each checked by
// building its request (so a bad option fails before anything is read, priced or sent). Pure: no files.

import { resolve } from "node:path";
import { MeshyError } from "../errors.js";
import { imageTo3dBody, MODEL_FORMATS, POSE_MODES, TOPOLOGIES, type ImageTo3dRequest, type ModelFormat, type PoseMode, type Topology } from "../image-to-3d.js";
import { DEFAULT_AI_MODEL, estimateCredits, type CreditCost, type ModelType, type TextureResolution } from "../pricing.js";

export interface MeshyJob {
  /** Letters, digits, dot, dash, underscore: the file name. */
  name: string;
  /** The concept image, an absolute path. */
  image: string;
  aiModel: string;
  /** Only when asked for (a Smart Topology ai_model sets it by itself). */
  modelType?: ModelType;
  texture: boolean;
  pbr: boolean;
  textureResolution?: TextureResolution;
  texturePrompt?: string;
  topology?: Topology;
  polycount?: number;
  /** undefined: Meshy's default (or on, when topology or polycount asks for it). */
  remesh?: boolean;
  pose?: PoseMode;
  ultra?: "2k" | "4k";
  /** undefined: Meshy's default (on). */
  enhance?: boolean;
  /** Always has glb first. */
  formats: ModelFormat[];
}

export type JobDefaults = Omit<MeshyJob, "name" | "image">;

export class JobError extends Error {}

export const DEFAULTS: JobDefaults = { aiModel: DEFAULT_AI_MODEL, texture: false, pbr: false, formats: ["glb"] };

/** A file name from an image's: its stem, lower case, anything else a dash. */
export function nameFrom(file: string): string {
  const stem = (file.split(/[\\/]/).pop() ?? "").replace(/\.[^.]+$/, "");
  return (
    stem
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, "-")
      .replace(/^-+|-+$/g, "") || "model"
  );
}

/** The stem every file of a job shares: `<name>`, or `<name>-textured` for a textured one. */
export const outBase = (job: Pick<MeshyJob, "name" | "texture">): string => (job.texture ? `${job.name}-textured` : job.name);

/** glb first, the rest as given, each once. */
export function formatsOf(value: unknown, fallback: ModelFormat[] = ["glb"]): ModelFormat[] {
  if (value == null || value === "") return ["glb", ...fallback.filter((f) => f !== "glb")];
  const list = (Array.isArray(value) ? value : String(value).split(",")).map((f) => String(f).trim().toLowerCase()).filter(Boolean);
  const bad = list.find((f) => !MODEL_FORMATS.includes(f as ModelFormat));
  if (bad) throw new JobError(`formats are ${MODEL_FORMATS.join(", ")}; not ${bad}.`);
  return [...new Set(["glb", ...list])] as ModelFormat[];
}

/** The library's request for a job, with this image. */
export function jobRequestOf(job: MeshyJob, image: ImageTo3dRequest["image"]): ImageTo3dRequest {
  return {
    image,
    aiModel: job.aiModel,
    modelType: job.modelType,
    shouldTexture: job.texture,
    enablePbr: job.pbr || undefined,
    textureResolution: job.textureResolution,
    texturePrompt: job.texturePrompt,
    topology: job.topology,
    targetPolycount: job.polycount,
    shouldRemesh: job.remesh,
    poseMode: job.pose,
    geometryResolution: job.ultra,
    imageEnhancement: job.enhance,
    targetFormats: job.formats,
  };
}

/** What a job costs, from the table. */
export const creditsOf = (job: MeshyJob): CreditCost =>
  estimateCredits({ aiModel: job.aiModel, modelType: job.modelType, shouldTexture: job.texture, textureResolution: job.textureResolution, geometryResolution: job.ultra });

const bool = (v: unknown, at: string, what: string): boolean | undefined => {
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "boolean") throw new JobError(`${at}: ${what} is true or false.`);
  return v;
};

const intOf = (v: unknown, at: string, what: string): number | undefined => {
  if (v === undefined || v === null || v === "") return undefined;
  const n = Number(v);
  if (!Number.isInteger(n)) throw new JobError(`${at}: ${what} is a whole number.`);
  return n;
};

const oneOf = <T extends string>(v: unknown, list: readonly T[], at: string, what: string): T | undefined => {
  if (v === undefined || v === null || v === "") return undefined;
  if (!list.includes(String(v).toLowerCase() as T)) throw new JobError(`${at}: ${what} is ${list.join(" or ")}, not ${String(v)}.`);
  return String(v).toLowerCase() as T;
};

/**
 * The jobs file's entries (an array, or { "jobs": [...] }), with `defaults` for what an entry leaves out; images
 * resolved against `baseDir`. Each job's request is built once with a stand-in image, so a bad option fails here.
 */
export function parseJobs(text: string, baseDir: string, defaults: JobDefaults = DEFAULTS): MeshyJob[] {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    throw new JobError(`The jobs file isn't JSON: ${(e as Error).message}`);
  }
  const list = Array.isArray(raw) ? raw : (raw as { jobs?: unknown })?.jobs;
  if (!Array.isArray(list) || !list.length) throw new JobError('The jobs file has no jobs: give an array, or { "jobs": [...] }.');
  const seen = new Set<string>();
  return list.map((entry: unknown, i) => {
    const at = `Job ${i + 1}`;
    if (!entry || typeof entry !== "object") throw new JobError(`${at} isn't an object.`);
    const j = entry as Record<string, unknown>;
    const image = typeof j.image === "string" ? j.image.trim() : "";
    if (!image) throw new JobError(`${at} has no image.`);
    const name = typeof j.name === "string" && j.name.trim() ? j.name.trim() : nameFrom(image);
    if (!/^[\w.-]+$/.test(name)) throw new JobError(`${at}'s name "${name}" has characters a file name can't: letters, digits, dot, dash and underscore only.`);
    const smart = bool(j.smartTopology, at, "smartTopology");
    const ultra = oneOf(j.ultra, ["2k", "4k"] as const, at, "ultra");
    const job: MeshyJob = {
      name,
      image: resolve(baseDir, image),
      aiModel: typeof j.model === "string" && j.model.trim() ? j.model.trim().toLowerCase() : defaults.aiModel,
      modelType: smart === undefined ? defaults.modelType : smart ? "smart-topology" : undefined,
      texture: bool(j.texture, at, "texture") ?? defaults.texture,
      pbr: bool(j.pbr, at, "pbr") ?? defaults.pbr,
      textureResolution: oneOf(j.textureResolution, ["2k", "4k", "8k"] as const, at, "textureResolution") ?? defaults.textureResolution,
      texturePrompt: typeof j.texturePrompt === "string" ? j.texturePrompt : defaults.texturePrompt,
      topology: oneOf(j.topology, TOPOLOGIES, at, "topology") ?? defaults.topology,
      polycount: intOf(j.polycount, at, "polycount") ?? defaults.polycount,
      remesh: bool(j.remesh, at, "remesh") ?? defaults.remesh,
      pose: oneOf(j.pose, POSE_MODES, at, "pose") ?? defaults.pose,
      ultra: ultra ?? defaults.ultra,
      enhance: bool(j.enhance, at, "enhance") ?? defaults.enhance,
      formats: j.formats === undefined ? defaults.formats : formatsOf(j.formats),
    };
    if (job.modelType === "smart-topology" && job.aiModel === DEFAULT_AI_MODEL) job.aiModel = "meshy-t2.5";
    const base = outBase(job);
    if (seen.has(base)) throw new JobError(`Two jobs make ${base}.glb.`);
    seen.add(base);
    try {
      imageTo3dBody(jobRequestOf(job, "https://stand-in.invalid/image.png"));
    } catch (e) {
      throw new JobError(`${at} (${name}): ${e instanceof MeshyError ? e.message : String(e)}`);
    }
    return job;
  });
}
