// gemini-image's work, with its input and output passed in so tests can run it on a fake fetch.
// Node-only (files, the key from Benhäus); the browser-safe index never imports this.
//
// Spending is opt-in, as with gemini-video: the estimate prints first, --dry-run prints the requests and
// sends nothing, and without --yes nothing is sent at all. Each image lands as <name>.png (or the type
// Google sent) with <name>.json beside it: the prompt, the references, the model, the size, what the
// model said and what it cost, so a concept can be traced back to how it was made.

import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { basename, dirname, extname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { loadCredential } from "@btkulka/benhaus-client";
import { createGeminiClient, type GeminiFetch } from "../client.js";
import { isGeminiError, type GeminiError } from "../errors.js";
import { IMAGE_ASPECT_RATIOS, IMAGE_SIZES, imageBody, type ImageAspectRatio, type ImageRequest, type ReferenceImage } from "../image.js";
import { costOfImageUsage, DEFAULT_IMAGE_MODEL, estimateImageCost, formatUsd, imageModel, IMAGE_PRICES_READ_ON, PRICES_SOURCE, type ImageSize } from "../pricing.js";
import type { ImageMimeType } from "../video.js";

export const DEFAULT_CREDENTIAL = "gemini/toejam";
export const DEFAULT_APP = "toejam";
export const KEY_ENV = "GEMINI_API_KEY";

export const IMAGE_USAGE = `gemini-image: make images with Nano Banana Pro, Nano Banana 2.1 or Nano Banana 2 into <name>.png files.

  gemini-image "<prompt>" --out <folder> [--name <name>] [--ref <image>]... [options]
  gemini-image --jobs <jobs.json> --out <folder> [options]

A jobs file is a JSON array (or { "jobs": [...] }) of
  { "name", "prompt", "refs"?: [files], "aspect"?, "size"?, "model"?, "count"?, "system"? }
(refs are relative to the jobs file). The flags below are the defaults for every job.

  --out, -o <folder>      where the images go (made if missing)
  --ref <file>            a reference image (png, jpg, webp), repeatable, up to 14: a style to match,
                          or the object to draw again from another side
  --aspect <ratio>        ${IMAGE_ASPECT_RATIOS.join(", ")} (default 1:1)
  --size 1K|2K|4K         default 2K
  --count <1-8>           variations of each (separate calls: <name>-1.png, <name>-2.png…; default 1)
  --model <id>            pro (default, ${DEFAULT_IMAGE_MODEL}), 2.1 (Nano Banana 2.1, a third of the price),
                          flash (Nano Banana 2), or a model id
  --system <text>         a standing brief put ahead of every prompt (a house style)
  --name, -n <name>       the file name for a single prompt (default: its first words)
  --dry-run               print the requests it would make; send nothing
  --yes, -y               spend: without it nothing is sent (the estimate prints either way)
  --force                 make images again even when <name>.png is there
  --credential <id>       the Benhäus credential (default ${DEFAULT_CREDENTIAL}; env ${KEY_ENV} as the fallback)
  --app <id>              the tool id Benhäus shows as the reader (default ${DEFAULT_APP})

Exit codes: 0 done, 1 a failure, 2 needs --yes.`;

export interface ImageCliIo {
  out(line: string): void;
  err(line: string): void;
  fetch?: GeminiFetch;
  loadKey?(credential: string, app: string): Promise<string | undefined>;
  signal?: AbortSignal;
  cwd?: string;
  /** Attempts for a 429 or a 503. Default 6. */
  attempts?: number;
  /** The first wait before a retry, doubled each time. Default 4 000. */
  baseDelayMs?: number;
}

export interface ImageJob {
  name: string;
  prompt: string;
  refs: string[];
  aspect: ImageAspectRatio;
  size: ImageSize;
  model: string;
  count: number;
  system?: string;
}

const MIME: Record<string, ImageMimeType> = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".heic": "image/heic", ".heif": "image/heif" };
const EXT: Record<string, string> = { "image/png": ".png", "image/jpeg": ".jpg", "image/webp": ".webp" };
const exists = (p: string) => stat(p).then(() => true, () => false);

/** A file name from a prompt's first words. */
export function nameFrom(prompt: string): string {
  return (
    prompt
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, " ")
      .trim()
      .split(/\s+/)
      .slice(0, 5)
      .join("-") || "image"
  );
}

/** `pro`, `flash` or an id, to the id sent. */
export function modelFlag(m: string | undefined): string {
  if (!m || m === "pro") return DEFAULT_IMAGE_MODEL;
  return imageModel(m)?.id ?? m.replace(/^models\//, "");
}

export class ImageJobError extends Error {}

/** The jobs file's entries, with the flags as defaults; refs resolved against the file's folder. */
export function parseImageJobs(text: string, baseDir: string, d: Omit<ImageJob, "name" | "prompt" | "refs"> & { refs: string[] }): ImageJob[] {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    throw new ImageJobError(`The jobs file isn't JSON: ${(e as Error).message}`);
  }
  const list = Array.isArray(raw) ? raw : (raw as { jobs?: unknown })?.jobs;
  if (!Array.isArray(list) || !list.length) throw new ImageJobError("The jobs file has no jobs: give an array, or { \"jobs\": [...] }.");
  const seen = new Set<string>();
  return list.map((j: Record<string, unknown>, i) => {
    const at = `Job ${i + 1}`;
    const prompt = typeof j.prompt === "string" ? j.prompt.trim() : "";
    if (!prompt) throw new ImageJobError(`${at} has no prompt.`);
    const name = typeof j.name === "string" && j.name.trim() ? j.name.trim() : nameFrom(prompt);
    if (!/^[\w.-]+$/.test(name)) throw new ImageJobError(`${at}'s name "${name}" has characters a file name can't: letters, digits, dot, dash and underscore only.`);
    if (seen.has(name)) throw new ImageJobError(`Two jobs are named "${name}".`);
    seen.add(name);
    const refs = Array.isArray(j.refs) ? j.refs.map((r) => resolve(baseDir, String(r))) : d.refs;
    const aspect = (j.aspect as ImageAspectRatio) ?? d.aspect;
    if (!IMAGE_ASPECT_RATIOS.includes(aspect)) throw new ImageJobError(`${at}: aspect ${aspect} isn't one of ${IMAGE_ASPECT_RATIOS.join(", ")}.`);
    const size = (j.size as ImageSize) ?? d.size;
    if (!IMAGE_SIZES.includes(size)) throw new ImageJobError(`${at}: size ${size} isn't 1K, 2K or 4K.`);
    const count = j.count == null ? d.count : Number(j.count);
    if (!Number.isInteger(count) || count < 1 || count > 8) throw new ImageJobError(`${at}: count must be 1 to 8.`);
    return {
      name,
      prompt,
      refs,
      aspect,
      size,
      model: j.model ? modelFlag(String(j.model)) : d.model,
      count,
      system: typeof j.system === "string" ? j.system : d.system,
    };
  });
}

/** The file names a job writes: <name> alone, or <name>-1… for a count over one. */
export const outNames = (job: ImageJob): string[] => (job.count === 1 ? [job.name] : Array.from({ length: job.count }, (_, k) => `${job.name}-${k + 1}`));

function hint(err: GeminiError, credential: string): string {
  switch (err.category) {
    case "auth":
      return `The key was refused: check ${credential} in Benhäus › Settings › Credentials (or ${KEY_ENV}).`;
    case "setup":
      return "The key's Google project can't make images yet: set up billing for it in AI Studio (aistudio.google.com › API keys › Set up billing), or read Google's message above.";
    case "rate_limit":
      return "Rate limited: try again in a minute.";
    case "blocked":
      return "Google's filters refused it: reword it (no real people's names, nothing sexual, violent or dangerous).";
    default:
      return "";
  }
}

export async function runImage(argv: string[], io: ImageCliIo): Promise<number> {
  const cwd = io.cwd ?? process.cwd();
  let a: ReturnType<typeof parse>;
  try {
    a = parse(argv);
  } catch (e) {
    io.err(`${(e as Error).message}\n\n${IMAGE_USAGE}`);
    return 1;
  }
  const { values: v, positionals } = a;
  if (v.help) {
    io.out(IMAGE_USAGE);
    return 0;
  }
  const prompt = positionals.join(" ").trim();
  if (!prompt && !v.jobs) {
    io.err(`Give a prompt or --jobs <file>.\n\n${IMAGE_USAGE}`);
    return 1;
  }
  if (prompt && v.jobs) {
    io.err("Give a prompt or --jobs, not both.");
    return 1;
  }
  if (!v.out) {
    io.err("Say where the images go: --out <folder>.");
    return 1;
  }
  const outDir = resolve(cwd, v.out);
  const credential = v.credential ?? DEFAULT_CREDENTIAL;
  const app = v.app ?? DEFAULT_APP;

  let jobs: ImageJob[];
  try {
    const defaults = {
      refs: (v.ref ?? []).map((r) => resolve(cwd, r)),
      aspect: (v.aspect ?? "1:1") as ImageAspectRatio,
      size: (v.size ?? "2K") as ImageSize,
      model: modelFlag(v.model),
      count: v.count == null ? 1 : Number(v.count),
      system: v.system,
    };
    if (v.jobs) {
      const file = resolve(cwd, v.jobs);
      jobs = parseImageJobs(await readFile(file, "utf8"), dirname(file), defaults);
    } else {
      const name = v.name ?? nameFrom(prompt);
      jobs = parseImageJobs(JSON.stringify([{ name, prompt }]), cwd, defaults);
    }
  } catch (e) {
    io.err((e as Error).message);
    return 1;
  }
  if (jobs.some((j) => j.refs.length > 14)) {
    io.err("A call takes at most 14 reference images.");
    return 1;
  }
  for (const r of new Set(jobs.flatMap((j) => j.refs))) {
    if (!MIME[extname(r).toLowerCase()]) {
      io.err(`${r}: a reference has to be png, jpg, webp, heic or heif.`);
      return 1;
    }
    if (!(await exists(r))) {
      io.err(`${r}: no such file.`);
      return 1;
    }
  }

  // What's already there is skipped unless --force.
  const work: { job: ImageJob; file: string }[] = [];
  for (const job of jobs) {
    for (const n of outNames(job)) {
      const done = await Promise.all(Object.values(EXT).map((e) => exists(join(outDir, `${n}${e}`))));
      if (done.some(Boolean) && !v.force) io.out(`[${n}] already there, skipped (--force makes it again)`);
      else work.push({ job, file: n });
    }
  }

  const est = estimateImageCost(work.map(({ job }) => ({ model: job.model, size: job.size, references: job.refs.length })));
  io.out(`${work.length} image${work.length === 1 ? "" : "s"}, about ${formatUsd(est.usd)}${est.unknown ? " (a model here has no price: counted as $0)" : ""} (prices read ${IMAGE_PRICES_READ_ON}, ${PRICES_SOURCE}).`);
  for (const job of jobs) io.out(`  ${job.name}: ${job.model}, ${job.size}, ${job.aspect}${job.refs.length ? `, ${job.refs.length} ref${job.refs.length === 1 ? "" : "s"}` : ""}${job.count > 1 ? `, ×${job.count}` : ""}`);
  if (!work.length) {
    io.out("Nothing to do.");
    return 0;
  }

  const refCache = new Map<string, ReferenceImage>();
  const refsOf = async (job: ImageJob): Promise<ReferenceImage[]> => {
    const out: ReferenceImage[] = [];
    for (const r of job.refs) {
      if (!refCache.has(r)) refCache.set(r, { data: new Uint8Array(await readFile(r)), mimeType: MIME[extname(r).toLowerCase()]! });
      out.push(refCache.get(r)!);
    }
    return out;
  };
  const requestOf = async (job: ImageJob): Promise<ImageRequest> => ({
    prompt: job.prompt,
    model: job.model,
    images: await refsOf(job),
    aspectRatio: job.aspect,
    size: job.size,
    system: job.system,
  });

  if (v["dry-run"]) {
    for (const { job, file } of work) {
      const body = imageBody(await requestOf(job));
      const input = typeof body.input === "string" ? body.input : body.input.map((c) => (c.type === "image" ? { ...c, data: "<base64>" } : c));
      io.out(`\n[${file}] POST /v1beta/interactions`);
      io.out(JSON.stringify({ ...body, input }, null, 2));
    }
    io.out("\nNothing sent (--dry-run).");
    return 0;
  }
  if (!v.yes) {
    io.out(`\nNothing sent. Run again with --yes to make ${work.length === 1 ? "it" : "them"} (about ${formatUsd(est.usd)}), or --dry-run to see the requests.`);
    return 2;
  }

  const apiKey = await (io.loadKey ?? defaultLoadKey)(credential, app);
  if (!apiKey) {
    io.err(`No Gemini key. Add it in Benhäus › Settings › Credentials (${credential}, "Gemini (Google AI Studio)"), or set ${KEY_ENV}. Keys come from https://aistudio.google.com/apikey; image models need billing on the key's project.`);
    return 1;
  }
  // Busy hours answer 503 to one call in three: wait it out (4, 8, 16, 32, 64 s) rather than fail the image.
  const client = createGeminiClient({ apiKey, fetch: io.fetch, attempts: io.attempts ?? 6, baseDelayMs: io.baseDelayMs ?? 4_000 });
  await mkdir(outDir, { recursive: true });

  let made = 0;
  let failed = 0;
  let spent = 0;
  // One at a time: Tier 1 caps spend per 10 minutes, and a concept set is a handful of images.
  for (const { job, file } of work) {
    if (io.signal?.aborted) break;
    const say = (s: string) => io.out(`[${file}] ${s}`);
    const t0 = Date.now();
    try {
      say(`drawing (${job.size})…`);
      // No signal: an image in flight is already paid for, so it's let finish and saved.
      const r = await client.image.generate(await requestOf(job));
      const img = r.image;
      const path = join(outDir, `${file}${EXT[img.mimeType] ?? ".png"}`);
      await writeFile(`${path}.part`, img.bytes);
      await rename(`${path}.part`, path);
      const cost = costOfImageUsage(job.model, job.size, r.interaction.usage);
      if (cost) spent += cost.usd;
      const meta = {
        name: file,
        prompt: job.prompt,
        system: job.system,
        refs: job.refs.map((p) => ({ path: p, file: basename(p) })),
        model: r.model,
        size: job.size,
        aspect: job.aspect,
        text: r.text || undefined,
        interaction: r.interaction.id,
        usage: r.interaction.usage,
        usd: cost?.usd,
        secs: Math.round((Date.now() - t0) / 100) / 10,
        at: new Date().toISOString(),
      };
      await writeFile(join(outDir, `${file}.json`), JSON.stringify(meta, null, 2) + "\n");
      made++;
      say(`${basename(path)} in ${meta.secs}s${cost ? `, ${formatUsd(cost.usd)}` : ""}`);
    } catch (err) {
      failed++;
      const msg = err instanceof Error ? err.message : String(err);
      say(`failed: ${msg}`);
      if (isGeminiError(err)) {
        const h = hint(err, credential);
        if (h) say(h);
        if (err.category === "auth" || err.category === "setup") break;
      }
    }
  }
  io.out(`\n${made} made${failed ? `, ${failed} failed` : ""}${spent ? `, ${formatUsd(spent)} spent` : ""}, in ${outDir}`);
  return failed ? 1 : 0;
}

function parse(argv: string[]) {
  return parseArgs({
    args: argv,
    allowPositionals: true,
    strict: true,
    options: {
      out: { type: "string", short: "o" },
      jobs: { type: "string" },
      name: { type: "string", short: "n" },
      ref: { type: "string", multiple: true },
      aspect: { type: "string" },
      size: { type: "string" },
      count: { type: "string" },
      model: { type: "string" },
      system: { type: "string" },
      "dry-run": { type: "boolean" },
      yes: { type: "boolean", short: "y" },
      force: { type: "boolean" },
      credential: { type: "string" },
      app: { type: "string" },
      help: { type: "boolean", short: "h" },
    },
  });
}

async function defaultLoadKey(credential: string, app: string): Promise<string | undefined> {
  const c = await loadCredential(credential, { app, env: { apiKey: KEY_ENV }, required: ["apiKey"] });
  return c?.fields.apiKey;
}
