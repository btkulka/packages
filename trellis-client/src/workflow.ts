// ComfyUI's own TRELLIS.2 template (a front-end workflow: nodes, widgets and links) turned into an API prompt with
// the server's node definitions, its switches resolved, the output replaced by a plain SaveGLB of the vertex-painted
// mesh, and everything the output does not need pruned. Plus the concept-image prompt (SDXL) for text input.

export interface ApiNode {
  class_type: string;
  inputs: Record<string, unknown>;
}
export type ApiPrompt = Record<string, ApiNode>;

export interface UiNode {
  id: number | string;
  type: string;
  inputs?: { name: string; link?: number | null; widget?: unknown }[];
  widgets_values?: unknown[] | Record<string, unknown>;
}
export interface UiWorkflow {
  nodes: UiNode[];
  /** [id, fromNode, fromSlot, toNode, toSlot, type] */
  links: (number | string)[][];
}

type InputSpec = [string, Record<string, unknown>?];
interface NodeDef {
  input?: { required?: Record<string, InputSpec>; optional?: Record<string, InputSpec> };
  input_order?: { required?: string[]; optional?: string[] };
}
export type ObjectInfo = Record<string, NodeDef>;

const namesOf = (group?: { required?: Record<string, unknown>; optional?: Record<string, unknown> }): string[] =>
  [...Object.keys(group?.required ?? {}), ...Object.keys(group?.optional ?? {})];

/**
 * A template node's widgets_values, in the front end's widget order, mapped onto the server's input names. A widget
 * is any input the template doesn't show as a plain socket. A seed's 'fixed'/'randomize' companion is skipped, and a
 * dynamic combo (COMFY_DYNAMICCOMBO_V3) is followed by its chosen option's own widgets, named '<combo>.<input>'.
 */
export function widgetInputs(node: UiNode, def: NodeDef): Record<string, unknown> {
  const sockets = new Map((node.inputs ?? []).map((i) => [i.name, i]));
  const order = def.input_order ?? { required: Object.keys(def.input?.required ?? {}), optional: Object.keys(def.input?.optional ?? {}) };
  const specs: Record<string, InputSpec | undefined> = { ...def.input?.required, ...def.input?.optional };
  const values = Array.isArray(node.widgets_values) ? [...node.widgets_values] : [];
  const inputs: Record<string, unknown> = {};
  const take = (name: string, spec?: InputSpec) => {
    if (!values.length) return;
    inputs[name] = values.shift();
    if (spec?.[1]?.control_after_generate) values.shift();
    if (spec?.[0] === "COMFY_DYNAMICCOMBO_V3") {
      const options = (spec[1]?.options ?? []) as { key: unknown; inputs?: { required?: Record<string, InputSpec>; optional?: Record<string, InputSpec> } }[];
      const option = options.find((o) => o.key === inputs[name]);
      const subSpecs: Record<string, InputSpec | undefined> = { ...option?.inputs?.required, ...option?.inputs?.optional };
      for (const sub of namesOf(option?.inputs)) take(`${name}.${sub}`, subSpecs[sub]);
    }
  };
  for (const name of [...(order.required ?? []), ...(order.optional ?? [])]) {
    const socket = sockets.get(name);
    if (socket && !socket.widget) continue; // a wire-only input
    take(name, specs[name]);
  }
  return inputs;
}

/** A front-end workflow as the API prompt the server runs. Nodes the server does not know (notes) are dropped. */
export function toApi(workflow: UiWorkflow, info: ObjectInfo): ApiPrompt {
  const links = new Map(workflow.links.map((l) => [l[0], l]));
  const prompt: ApiPrompt = {};
  for (const node of workflow.nodes) {
    const def = info[node.type];
    if (!def) continue;
    const inputs = widgetInputs(node, def);
    for (const input of node.inputs ?? []) {
      if (input.link == null) continue;
      const l = links.get(input.link);
      if (l) inputs[input.name] = [String(l[1]), l[2]];
    }
    prompt[String(node.id)] = { class_type: node.type, inputs };
  }
  return prompt;
}

/** Replace each ComfySwitchNode with the branch its switch selects. */
export function resolveSwitches(prompt: ApiPrompt): void {
  const valueOf = (v: unknown): unknown => (Array.isArray(v) ? prompt[String(v[0])]?.inputs?.value : v);
  for (const [id, node] of Object.entries(prompt)) {
    if (node.class_type !== "ComfySwitchNode") continue;
    const chosen = valueOf(node.inputs.switch) ? node.inputs.on_true : node.inputs.on_false;
    delete prompt[id];
    for (const other of Object.values(prompt)) {
      for (const [k, v] of Object.entries(other.inputs)) if (Array.isArray(v) && String(v[0]) === id) other.inputs[k] = chosen;
    }
  }
}

/** Keep only `outputId` and what it depends on. */
export function prune(prompt: ApiPrompt, outputId: string): void {
  const keep = new Set<string>();
  const visit = (id: string) => {
    if (keep.has(id) || !prompt[id]) return;
    keep.add(id);
    for (const v of Object.values(prompt[id].inputs)) if (Array.isArray(v)) visit(String(v[0]));
  };
  visit(outputId);
  for (const id of Object.keys(prompt)) if (!keep.has(id)) delete prompt[id];
}

export const ofType = (prompt: ApiPrompt, type: string): [string, ApiNode][] => Object.entries(prompt).filter(([, n]) => n.class_type === type);

/** A checkpoint's name as this server lists it (subfolder separators differ by OS). */
export function checkpointName(info: ObjectInfo, file: string): string {
  const names = (info.CheckpointLoaderSimple?.input?.required?.ckpt_name?.[0] as unknown as string[] | undefined) ?? [];
  const hit = names.find((n) => n.replaceAll("\\", "/").endsWith(file));
  if (!hit) throw new Error(`No ${file} among the server's checkpoints; check extra_model_paths.yaml`);
  return hit;
}

export interface TrellisPromptOptions {
  /** The uploaded image's name on the server. */
  imageName: string;
  seed: number;
  /** The upsample stage's target resolution (1024 fits an 8 GB card; 1536 is the full cascade). */
  resolution?: number;
  /** Cap on the remesh resolution (512 for 8 GB, 768 for quality). */
  remesh?: number;
  /** Cap on decimated faces (default 250000). */
  maxFaces?: number;
  /** SaveGLB's filename_prefix (under ComfyUI's output folder). */
  savePrefix: string;
  /** The id of the save node added (default "trellis_save"). */
  saveId?: string;
}

/**
 * The TRELLIS.2 API prompt from the template: the Pixal3D/TRELLIS switches set to TRELLIS.2, the image and seed in,
 * the cascade and remesh sized, and the vertex-painted mesh (PaintMesh) saved by a plain SaveGLB (the template's
 * Save3DAdvanced needs viewer state only the browser supplies, and its UV-textured branch is four bakes a
 * colour-per-face consumer does not need).
 */
export function buildTrellisPrompt(template: UiWorkflow, info: ObjectInfo, o: TrellisPromptOptions): ApiPrompt {
  const prompt = toApi(template, info);
  for (const [, n] of ofType(prompt, "PrimitiveBoolean")) n.inputs.value = true;
  resolveSwitches(prompt);
  for (const [, n] of ofType(prompt, "LoadImage")) n.inputs.image = o.imageName;
  for (const [, n] of ofType(prompt, "KSampler")) n.inputs.seed = o.seed;
  for (const [, n] of ofType(prompt, "Trellis2UpsampleStage")) n.inputs.target_resolution = o.resolution ?? 1024;
  const remesh = o.remesh ?? 512;
  for (const [, n] of ofType(prompt, "RemeshMesh")) if (typeof n.inputs.resolution === "number") n.inputs.resolution = Math.min(n.inputs.resolution, remesh);
  const maxFaces = o.maxFaces ?? 250_000;
  for (const [, n] of ofType(prompt, "DecimateMesh")) for (const k of Object.keys(n.inputs)) if (typeof n.inputs[k] === "number" && (n.inputs[k] as number) > maxFaces) n.inputs[k] = maxFaces;
  const paint = ofType(prompt, "PaintMesh")[0];
  if (!paint) throw new Error("The template has no PaintMesh node; is it ComfyUI's TRELLIS.2 template?");
  const saveId = o.saveId ?? "trellis_save";
  prompt[saveId] = { class_type: "SaveGLB", inputs: { mesh: [paint[0], 0], filename_prefix: o.savePrefix } };
  prune(prompt, saveId);
  return prompt;
}

export const DEFAULT_CONCEPT_STYLE =
  "single object, centered, entire object visible, three-quarter view from slightly above, plain light grey background, soft even lighting, clear distinct material zones, game asset concept art, no text";
export const DEFAULT_CONCEPT_NEGATIVE =
  "cropped, cut off, multiple objects, scenery, busy background, ground plane, harsh shadows, text, watermark, logo, blurry";

export interface ConceptPromptOptions {
  subject: string;
  /** The checkpoint as the server names it (checkpointName). */
  ckpt: string;
  size: number;
  steps: number;
  cfg: number;
  sampler: string;
  scheduler: string;
  seed: number;
  /** SaveImage's filename_prefix. */
  prefix: string;
  /** Appended to the subject (default DEFAULT_CONCEPT_STYLE). */
  style?: string;
  negative?: string;
}

/** A one-image SDXL prompt: the subject drawn the way TRELLIS likes it (one object, centred, flat light). */
export function buildConceptPrompt(o: ConceptPromptOptions): ApiPrompt {
  const positive = `${o.subject}, ${o.style ?? DEFAULT_CONCEPT_STYLE}`;
  return {
    1: { class_type: "CheckpointLoaderSimple", inputs: { ckpt_name: o.ckpt } },
    2: { class_type: "CLIPTextEncode", inputs: { text: positive, clip: ["1", 1] } },
    3: { class_type: "CLIPTextEncode", inputs: { text: o.negative ?? DEFAULT_CONCEPT_NEGATIVE, clip: ["1", 1] } },
    4: { class_type: "EmptyLatentImage", inputs: { width: o.size, height: o.size, batch_size: 1 } },
    5: { class_type: "KSampler", inputs: { model: ["1", 0], positive: ["2", 0], negative: ["3", 0], latent_image: ["4", 0], seed: o.seed, steps: o.steps, cfg: o.cfg, sampler_name: o.sampler, scheduler: o.scheduler, denoise: 1 } },
    6: { class_type: "VAEDecode", inputs: { samples: ["5", 0], vae: ["1", 2] } },
    7: { class_type: "SaveImage", inputs: { images: ["6", 0], filename_prefix: o.prefix } },
  };
}
