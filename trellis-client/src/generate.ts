// One model: an image (or a text prompt drawn as a concept image first) through the running 3D ComfyUI to a
// vertex-painted GLB, with its provenance beside it.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { buildConceptPrompt, buildTrellisPrompt, checkpointName } from "./workflow.js";
import type { ApiPrompt, ObjectInfo, UiWorkflow } from "./workflow.js";
import { TrellisError, resolveEnv } from "./server.js";
import type { TrellisEnv } from "./server.js";

export const TRELLIS_TEMPLATE = "3d_pixal3d_trellis2_image_to_model";

export interface ConceptModel {
  /** The checkpoint file name (looked up among the server's, any subfolder). */
  file: string;
  size: number;
  steps: number;
  cfg: number;
  sampler: string;
  scheduler: string;
}

/** Concept-image models: SDXL Turbo (four steps at 512, plenty for TRELLIS) and SDXL base. */
export const CONCEPT_MODELS: Record<"turbo" | "base", ConceptModel> = {
  turbo: { file: "sd_xl_turbo_1.0.safetensors", size: 512, steps: 4, cfg: 1.0, sampler: "euler_ancestral", scheduler: "normal" },
  base: { file: "sd_xl_base_1.0.safetensors", size: 1024, steps: 28, cfg: 6.5, sampler: "dpmpp_2m", scheduler: "karras" },
};

export type ProgressFn = (stage: "concept" | "trellis", secs: number) => void;

export interface GenerateOptions {
  /** The reference image (one object, centred, plain background), or a prompt to draw one with SDXL. One of the two. */
  image?: string;
  prompt?: string;
  /** A name for the files: letters, digits and dashes. */
  name: string;
  /** Where the GLB, the concept image, the exact API prompt and the meta file land. */
  outDir: string;
  seed?: number;
  /** 'high' uses the full 1536 cascade, a 768 remesh and SDXL base concepts at 1024 px: better, slower, the most RAM. */
  quality?: "standard" | "high";
  resolution?: number;
  /** The concept model for a text prompt (default turbo, or base at quality high). */
  concept?: ConceptModel;
  /** Appended to the subject for the concept image (the package's default suits props; pass a house style). */
  conceptStyle?: string;
  conceptNegative?: string;
  /** The template's name on the server (default TRELLIS_TEMPLATE), or a workflow to use instead of fetching one. */
  template?: string | UiWorkflow;
  onProgress?: ProgressFn;
  /** Seconds between history polls (default 3). */
  pollS?: number;
}

export interface GenerateResult {
  glb: string;
  concept?: string;
  meta: string;
  seed: number;
  /** Seconds the TRELLIS run took. */
  secs: number;
}

/** A file a node saved, as ComfyUI's history reports it. */
export interface SavedFile {
  filename: string;
  subfolder: string;
  type: string;
}

interface History {
  status?: { completed?: boolean; status_str?: string; messages?: [string, { node_type?: string; exception_message?: string }][] };
  outputs?: Record<string, Record<string, unknown>>;
}

/** Where the server is and what every request carries (a rented GPU's token). */
interface Conn {
  url: string;
  headers: Record<string, string>;
}

async function api(c: Conn, route: string, init: RequestInit = {}): Promise<unknown> {
  const res = await fetch(c.url + route, { ...init, headers: { ...c.headers, ...((init.headers as Record<string, string> | undefined) ?? {}) } });
  if (!res.ok) throw new TrellisError("failed", `${route}: ${res.status} ${(await res.text()).slice(0, 500)}`);
  return res.headers.get("content-type")?.includes("json") ? res.json() : res.text();
}

async function upload(c: Conn, file: string, name: string): Promise<string> {
  const form = new FormData();
  form.append("image", new Blob([fs.readFileSync(file)]), name);
  form.append("overwrite", "true");
  return ((await api(c, "/upload/image", { method: "POST", body: form })) as { name: string }).name;
}

/** Every file a finished prompt's nodes saved, from its history entry, with one of these extensions. */
export function savedFiles(outputs: Record<string, Record<string, unknown>> | undefined, exts: string[]): SavedFile[] {
  const out: SavedFile[] = [];
  for (const node of Object.values(outputs ?? {}))
    for (const list of Object.values(node ?? {}))
      if (Array.isArray(list))
        for (const f of list as Partial<SavedFile>[])
          if (f && typeof f.filename === "string" && exts.some((x) => (f.filename as string).toLowerCase().endsWith(x))) out.push({ filename: f.filename, subfolder: f.subfolder ?? "", type: f.type ?? "output" });
  return out;
}

/** A saved file's bytes over HTTP (ComfyUI's /view), written to dest. */
async function download(c: Conn, f: SavedFile, dest: string): Promise<void> {
  const q = new URLSearchParams({ filename: f.filename, subfolder: f.subfolder, type: f.type });
  const res = await fetch(`${c.url}/view?${q}`, { headers: c.headers });
  if (!res.ok) throw new TrellisError("no-output", `/view ${f.filename}: ${res.status}`);
  fs.writeFileSync(dest, Buffer.from(await res.arrayBuffer()));
}

/** A finished prompt's file into dest: from the local output folder when the server is here, else over HTTP. */
async function fetchResult(c: Conn, comfyDir: string, remote: boolean, outputs: History["outputs"], stem: string, exts: string[], dest: string): Promise<boolean> {
  const local = !remote && comfyDir ? newestOutput(comfyDir, stem, exts) : undefined;
  if (local) {
    fs.copyFileSync(local, dest);
    return true;
  }
  const leaf = stem.split("/").pop() ?? stem;
  const files = savedFiles(outputs, exts);
  const f = files.find((x) => x.filename.includes(leaf)) ?? files[0];
  if (!f) return false;
  await download(c, f, dest);
  return true;
}

/** Queue a prompt and wait for it. Returns what its nodes saved. */
async function run(c: Conn, prompt: ApiPrompt, label: "concept" | "trellis", onProgress?: ProgressFn, pollS = 3): Promise<History["outputs"]> {
  const client = crypto.randomUUID();
  const queued = (await api(c, "/prompt", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ prompt, client_id: client }) })) as {
    prompt_id: string;
    node_errors?: Record<string, unknown>;
  };
  if (queued.node_errors && Object.keys(queued.node_errors).length) throw new TrellisError("bad-prompt", `${label}: ${JSON.stringify(queued.node_errors).slice(0, 2000)}`);
  const started = Date.now();
  let last = 0;
  for (;;) {
    await new Promise((r) => setTimeout(r, pollS * 1000));
    const hist = ((await api(c, `/history/${queued.prompt_id}`)) as Record<string, History>)[queued.prompt_id];
    if (hist?.status?.completed) return hist.outputs;
    if (hist?.status?.status_str === "error") {
      const err = hist.status.messages?.find((m) => m[0] === "execution_error")?.[1];
      throw new TrellisError("failed", `${label} failed in ${err?.node_type ?? "?"}: ${err?.exception_message ?? JSON.stringify(hist.status).slice(0, 800)}`);
    }
    const secs = Math.round((Date.now() - started) / 1000);
    if (secs - last >= 30) {
      onProgress?.(label, secs);
      last = secs;
    }
  }
}

/** The newest file under ComfyUI's output folder whose path contains `stem`. */
function newestOutput(comfyDir: string, stem: string, exts: string[]): string | undefined {
  const root = path.join(comfyDir, "output");
  if (!fs.existsSync(root)) return undefined;
  const found: [number, string][] = [];
  const walk = (dir: string) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (p.replaceAll("\\", "/").includes(stem) && exts.some((x) => p.toLowerCase().endsWith(x))) found.push([fs.statSync(p).mtimeMs, p]);
    }
  };
  if (fs.existsSync(root)) walk(root);
  return found.sort((a, b) => b[0] - a[0])[0]?.[1];
}

async function loadTemplate(c: Conn, template: string | UiWorkflow | undefined): Promise<UiWorkflow> {
  if (template && typeof template !== "string") return template;
  const name = template ?? TRELLIS_TEMPLATE;
  try {
    return (await api(c, `/templates/${name}.json`)) as UiWorkflow;
  } catch {
    const res = await fetch(`https://raw.githubusercontent.com/Comfy-Org/workflow_templates/main/templates/${name}.json`);
    if (!res.ok) throw new TrellisError("no-template", `No ${name} template from the server or GitHub`);
    return (await res.json()) as UiWorkflow;
  }
}

/**
 * Make one model. The server must be up (`serve`). Returns the GLB (copied into outDir as `<name>.glb`), the concept
 * image when a prompt was drawn, and `<name>.meta.json` with the seed, the input and the settings; the exact API
 * prompt is saved as `<name>-prompt.json`.
 */
export async function generate(env: TrellisEnv, o: GenerateOptions): Promise<GenerateResult> {
  if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(o.name)) throw new TrellisError("bad-prompt", `name must be letters, digits and dashes: ${o.name}`);
  if (!o.image && !o.prompt) throw new TrellisError("bad-prompt", "pass an image or a prompt");
  const r = resolveEnv(env);
  const url = r.url;
  const c: Conn = { url, headers: env.headers ?? {} };
  const remote = !!env.remote;
  let info: ObjectInfo;
  try {
    info = (await api(c, "/object_info")) as ObjectInfo;
  } catch (err) {
    throw new TrellisError("not-up", `No 3D ComfyUI at ${url}: ${(err as Error).message}`);
  }
  if (!info.Trellis2ShapeStage) throw new TrellisError("no-trellis-nodes", "This ComfyUI has no TRELLIS.2 nodes; update it (0.45+).");
  fs.mkdirSync(o.outDir, { recursive: true });
  const seed = Number.isFinite(o.seed) ? (o.seed as number) : crypto.randomInt(1, 2 ** 31);
  const high = o.quality === "high";

  let image = o.image ? path.resolve(o.image) : undefined;
  let concept: string | undefined;
  if (!image) {
    const m = o.concept ?? (high ? CONCEPT_MODELS.base : CONCEPT_MODELS.turbo);
    let ckpt: string;
    try {
      ckpt = checkpointName(info, m.file);
    } catch (err) {
      throw new TrellisError("no-checkpoint", (err as Error).message);
    }
    const prefix = `trellis/${o.name}-concept`;
    const saved = await run(c, buildConceptPrompt({ subject: o.prompt as string, ckpt, ...m, seed, prefix, style: o.conceptStyle, negative: o.conceptNegative }), "concept", o.onProgress, o.pollS);
    concept = path.join(o.outDir, `${o.name}-concept.png`);
    if (!(await fetchResult(c, r.comfyDir, remote, saved, prefix, [".png"], concept))) throw new TrellisError("no-output", "SDXL finished but its image is missing");
    image = concept;
  }

  const imageName = await upload(c, image, `${o.name}-${path.basename(image)}`);
  const savePrefix = `3d/trellis/${o.name}`;
  const prompt = buildTrellisPrompt(await loadTemplate(c, o.template), info, {
    imageName,
    seed,
    resolution: o.resolution ?? (high ? 1536 : 1024),
    remesh: high ? 768 : 512,
    savePrefix,
  });
  fs.writeFileSync(path.join(o.outDir, `${o.name}-prompt.json`), JSON.stringify(prompt, null, 1));
  const t = Date.now();
  const savedGlb = await run(c, prompt, "trellis", o.onProgress, o.pollS);
  const glb = path.join(o.outDir, `${o.name}.glb`);
  if (!(await fetchResult(c, r.comfyDir, remote, savedGlb, savePrefix, [".glb"], glb))) throw new TrellisError("no-output", "TRELLIS finished but no GLB was saved");
  const secs = Math.round((Date.now() - t) / 1000);
  const meta = path.join(o.outDir, `${o.name}.meta.json`);
  fs.writeFileSync(
    meta,
    JSON.stringify(
      {
        name: o.name,
        seed,
        image: path.basename(image),
        prompt: o.prompt ?? null,
        resolution: o.resolution ?? (high ? 1536 : 1024),
        quality: o.quality ?? "standard",
        template: typeof o.template === "string" ? o.template : o.template ? "(given)" : TRELLIS_TEMPLATE,
        secs,
        made: new Date().toISOString(),
        tool: "@btkulka/trellis-client",
      },
      null,
      1,
    ),
  );
  return { glb, concept, meta, seed, secs };
}
