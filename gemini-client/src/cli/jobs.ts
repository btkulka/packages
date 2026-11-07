// The CLI's jobs: from one prompt on the command line, or a JSON file of them, with the command
// line's flags as the defaults. Pure: no files, no network.

import { DEFAULT_VIDEO_MODEL, type VideoResolution } from "../pricing.js";
import { ASPECT_RATIOS, MAX_SECONDS, MIN_SECONDS, RESOLUTIONS, type AspectRatio } from "../video.js";

/** One clip to make, as the jobs file writes it. */
export interface JobInput {
  name: string;
  prompt: string;
  negativePrompt?: string;
  aspect?: AspectRatio;
  resolution?: VideoResolution;
  seconds?: number;
  model?: string;
  seed?: number;
  /** A start image (image-to-video), relative to the jobs file. */
  image?: string;
}

/** A job with the defaults applied. */
export interface Job {
  name: string;
  prompt: string;
  negativePrompt?: string;
  aspect: AspectRatio;
  resolution: VideoResolution;
  seconds?: number;
  model: string;
  seed?: number;
  image?: string;
}

export interface JobDefaults {
  aspect: AspectRatio;
  resolution: VideoResolution;
  seconds?: number;
  model: string;
  negativePrompt?: string;
}

/** The CLI's defaults: portrait, 720p, Omni Flash, no length asked for. */
export const CLI_DEFAULTS: JobDefaults = { aspect: "9:16", resolution: "720p", model: DEFAULT_VIDEO_MODEL };

/** A file name Windows and the shell are both happy with. */
const NAME = /^[A-Za-z0-9][A-Za-z0-9._ -]{0,99}$/;
const RESERVED = /^(con|prn|aux|nul|com\d|lpt\d)(\..*)?$/i;

export class JobError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "JobError";
  }
}

/** The first few words of a prompt as a file name: "neon-bar-crowd-dancing". */
export function slug(prompt: string, max = 40): string {
  const s = prompt.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  if (s.length <= max) return s || "clip";
  // Cut at the last whole word that fits.
  const at = s.slice(0, max + 1).lastIndexOf("-");
  return (at > 0 ? s.slice(0, at) : s.slice(0, max)) || "clip";
}

function checkOne(raw: unknown, i: number, d: JobDefaults): Job {
  const where = `Job ${i + 1}`;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new JobError(`${where} isn't an object.`);
  const j = raw as Record<string, unknown>;
  const str = (k: string): string | undefined => {
    const v = j[k];
    if (v === undefined || v === null || v === "") return undefined;
    if (typeof v !== "string") throw new JobError(`${where}: ${k} must be a string.`);
    return v.trim() || undefined;
  };
  const num = (k: string): number | undefined => {
    const v = j[k];
    if (v === undefined || v === null || v === "") return undefined;
    const n = typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : NaN;
    if (!Number.isFinite(n)) throw new JobError(`${where}: ${k} must be a number.`);
    return n;
  };
  const prompt = str("prompt");
  if (!prompt) throw new JobError(`${where} has no prompt.`);
  const name = str("name") ?? slug(prompt);
  if (!NAME.test(name) || RESERVED.test(name) || name.endsWith(".") || name.endsWith(" ")) {
    throw new JobError(`${where}: "${name}" won't do as a file name (letters, digits, space, . _ -, up to 100, not starting with a symbol).`);
  }
  const label = `${where} (${name})`;
  const aspect = (str("aspect") ?? d.aspect) as AspectRatio;
  if (!ASPECT_RATIOS.includes(aspect)) throw new JobError(`${label}: aspect must be ${ASPECT_RATIOS.join(" or ")}, not ${aspect}.`);
  const resolution = (str("resolution") ?? d.resolution).toLowerCase() as VideoResolution;
  if (!RESOLUTIONS.includes(resolution)) throw new JobError(`${label}: resolution must be one of ${RESOLUTIONS.join(", ")}, not ${resolution}.`);
  const seconds = num("seconds") ?? d.seconds;
  if (seconds !== undefined && !(Number.isInteger(seconds) && seconds >= MIN_SECONDS && seconds <= MAX_SECONDS)) {
    throw new JobError(`${label}: seconds must be a whole number from ${MIN_SECONDS} to ${MAX_SECONDS}, not ${seconds}.`);
  }
  const seed = num("seed");
  if (seed !== undefined && !(Number.isInteger(seed) && seed >= 0 && seed <= 2 ** 32 - 1)) throw new JobError(`${label}: seed must be a whole number from 0 to 4294967295.`);
  const known = new Set(["name", "prompt", "negativePrompt", "aspect", "resolution", "seconds", "model", "seed", "image"]);
  const extra = Object.keys(j).filter((k) => !known.has(k));
  if (extra.length) throw new JobError(`${label}: unknown field${extra.length > 1 ? "s" : ""} ${extra.join(", ")} (known: ${[...known].join(", ")}).`);
  return {
    name,
    prompt,
    negativePrompt: str("negativePrompt") ?? d.negativePrompt,
    aspect,
    resolution,
    seconds,
    model: (str("model") ?? d.model).replace(/^models\//, ""),
    seed,
    image: str("image"),
  };
}

/** A jobs file's JSON: an array of jobs, or `{ "jobs": [...] }`. Names must be unique (ignoring case, as Windows does). */
export function parseJobs(json: unknown, defaults: JobDefaults = CLI_DEFAULTS): Job[] {
  const list = Array.isArray(json) ? json : json && typeof json === "object" && Array.isArray((json as { jobs?: unknown }).jobs) ? (json as { jobs: unknown[] }).jobs : undefined;
  if (!list) throw new JobError('A jobs file is a JSON array of jobs, or { "jobs": [...] }.');
  if (!list.length) throw new JobError("The jobs file has no jobs.");
  const jobs = list.map((raw, i) => checkOne(raw, i, defaults));
  const seen = new Map<string, number>();
  jobs.forEach((j, i) => {
    const k = j.name.toLowerCase();
    if (seen.has(k)) throw new JobError(`Jobs ${seen.get(k)! + 1} and ${i + 1} are both named "${j.name}"; each writes <name>.mp4, so names must differ.`);
    seen.set(k, i);
  });
  return jobs;
}

/** One job from the command line's prompt. */
export function promptJob(prompt: string, name: string | undefined, seed: number | undefined, image: string | undefined, defaults: JobDefaults = CLI_DEFAULTS): Job {
  return parseJobs([{ prompt, name, seed, image }], defaults)[0]!;
}
