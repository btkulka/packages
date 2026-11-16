# @btkulka/trellis-client

TRELLIS.2 (Microsoft's image-to-3D model) through a dedicated ComfyUI, for any of Ben's apps: the weights, the server guarded for a small machine, one model from an image or a text prompt, and the GLB read into OBJ files by colour. The tome adventures repo grew this as three scripts in Nov 2026; this is that code as a package, with the project's own choices (its palette, its conform step, its fantasy house style) left to the caller.

- **Node only**, ESM and CommonJS. One dependency: `@btkulka/proc-kit` (spawning, probing, PID files, killing a tree).
- **No app paths inside.** The ComfyUI folder, its URL, the shared models folder and the output folder are passed in (`TrellisEnv`); the CLI reads `TRELLIS_COMFY_DIR` and `TRELLIS_URL`.
- **Guarded by default:** one start at a time across every process (a lock file), a free-memory floor (6 GB; the int8 model and its VAEs live in RAM between steps in low-VRAM mode), refuses while another ComfyUI answers on :8188, half the cores, below-normal priority, 1 GB of VRAM kept back for the desktop.

```json
"dependencies": { "@btkulka/trellis-client": "file:../packages/trellis-client" }
```

Build it here first (`npm run build`); apps load `dist/`. `btkulka-trellis` is the same from a terminal.

## The setup it expects

A plain ComfyUI 0.45+ checkout with its own venv (Python 3.12, a CUDA torch), kept apart from the everyday ComfyUI so that install's custom nodes stay untouched. TRELLIS.2 is built into ComfyUI core: nothing to compile, no custom nodes. On this PC: `D:/tools/comfyui-3d`, serving on 127.0.0.1:8190, sharing `D:/source/comfyui/models` for the SDXL checkpoint that draws concept images.

About 9 GB of weights go under its `models/` (`checkWeights`, `downloadWeights`; Hugging Face, resumed):
`diffusion_models/trellis_2_int8_convrot.safetensors` (5.25 GB), `vae/trellis_2_shape_vae_bf16.safetensors`, `vae/trellis_2_texture_vae_bf16.safetensors`, `clip_vision/dino_v3_L_naf_fp32.safetensors`, `background_removal/birefnet.safetensors`.

Hardware floor: an RTX 3070 (8 GB) and 16 GB of RAM. A model takes about 3 minutes; the concept image about 25 s. One at a time, nothing else heavy alongside.

## API

```ts
import { serve, generate, glbToObj, checkWeights, type TrellisEnv } from "@btkulka/trellis-client";

const env: TrellisEnv = { comfyDir: "D:/tools/comfyui-3d", sharedModelsDir: "D:/source/comfyui/models" };
const server = await serve(env, { onLog: console.log });            // or hands back the one already up
const r = await generate(env, { prompt: "a brass safe-deposit drawer", name: "drawer-brass", outDir: "models/trellis" });
const obj = glbToObj(r.glb, "models/trellis/drawer-brass", { colors: 6 });   // drawer-brass_0.obj … + drawer-brass.json
await server.stop();
```

### Weights

```ts
TRELLIS2_WEIGHTS: WeightFile[]
checkWeights(comfyDir, files?): WeightStatus[]                      // { file, path, have, ok, partial }
downloadWeights(comfyDir, { files?, attempts?, retryWaitS?, onLog?, noAria? }): Promise<WeightStatus[]>
writeExtraModelPaths(comfyDir, sharedModelsDir): string | null      // extra_model_paths.yaml, unless it exists
```

`downloadWeights` uses aria2c when it is on the PATH (two connections, no preallocation) and curl otherwise, resuming; Hugging Face's signed links expire mid-file, so each file gets up to 12 attempts from a fresh redirect. A file that still failed comes back `ok: false` rather than throwing.

### The server

```ts
resolveEnv(env): ResolvedEnv
isUp(env): Promise<boolean>
serve(env, { refuseGB? /* 6 */, warnGB? /* 8 */, force?, mainUrl? /* http://127.0.0.1:8188, null to skip */, threads?, reserveVramGB? /* 1 */, lowVram? /* true */, extraArgs?, log?, startTimeoutMs? /* 120 s */, onLog? }): Promise<ServeHandle>
stopServer(env): Promise<boolean>
serverPid(env): number | null
watchMemoryFloor(handle, { floorGB? /* 0.7 */, holdS? /* 30 */, onStop? }): () => void
threadBudget(): number
```

- `serve` returns `{ pid, url, reused, stop }`. The server is **detached** (it outlives the caller; `serverPid` finds it again through a PID file in the temp dir), so a script can start it, run models and leave it up for the next script, or `stop()` it.
- It throws a `TrellisError` with a `code` instead of starting when it should not: `no-comfy`, `no-venv`, `main-comfy-up`, `locked` (another start in progress), `low-memory` (under `refuseGB` free; `force: true` overrides), `not-up` (it did not answer in time; the log says why).
- `watchMemoryFloor` is for a foreground run: when free RAM stays under the floor for 30 s the machine is thrashing, so it stops the server rather than let the desktop freeze.

### A model

```ts
generate(env, {
  image? | prompt?, name, outDir, seed?, quality? /* 'standard' | 'high' */, resolution?,
  concept? /* a ConceptModel; default SDXL Turbo, or SDXL base at quality high */, conceptStyle?, conceptNegative?,
  template? /* the template's name on the server, default TRELLIS_TEMPLATE, or a UiWorkflow */, onProgress?, pollS?
}): Promise<{ glb, concept?, meta, seed, secs }>
CONCEPT_MODELS: { turbo, base }
TRELLIS_TEMPLATE = "3d_pixal3d_trellis2_image_to_model"
```

- The workflow is ComfyUI's own template, fetched from the server (or GitHub), converted to an API prompt with the server's node definitions (`toApi`, `widgetInputs`), its Pixal3D/TRELLIS switches resolved to TRELLIS.2 (`resolveSwitches`), the image and seed set, the cascade sized (1024 on 8 GB; 1536 at quality high), the remesh capped (512; 768), the decimation capped at 250k faces, and the **vertex-painted** mesh (PaintMesh) saved by a plain SaveGLB (`buildTrellisPrompt`). That skips the UV unwrap and the four texture bakes, since a colour per face is what the OBJ split needs. Everything else is pruned.
- A text prompt first draws a concept image with SDXL: the subject plus a style suffix (`DEFAULT_CONCEPT_STYLE`: one object, centred, plain light background, flat even light, clear material zones; pass `conceptStyle` for a house look) and a negative (`DEFAULT_CONCEPT_NEGATIVE`). The checkpoint is found among the server's by file name in any subfolder (`checkpointName`).
- Outputs: `<outDir>/<name>.glb`, `<name>-concept.png` (for a prompt), `<name>-prompt.json` (the exact API prompt) and `<name>.meta.json` (seed, input, settings, seconds).
- The input image that works: one object, centred, fully visible, plain light background, readable silhouette, clear material zones, even flat light, no text, nothing cropped.

### GLB to OBJ

```ts
parseGlb(buf): GlbMesh[]                                            // triangles in scene space, normals and vertex colours when present
meshStats(meshes): { meshes, vertices, triangles, colored, bounds }
splitByColor(mesh, k? /* 6 */, seed?): { group: Uint16Array; groups: ColorGroup[] }
writeObj(mesh, group, groups, prefix, { scale?, precision? }): ObjFiles
glbToObj(glbPath, prefix, { colors?, scale?, merge? }): ObjFiles    // <prefix>_<k>.obj + <prefix>.json
srgbToOklab(r, g, b), oklabToSrgb(L, a, b)
```

- `splitByColor` takes each face's colour (the mean of its vertices') and clusters them with k-means in OKLab (k-means++ seeding, a fixed seed, so the same file always splits the same way); groups come back brightest first with their mean sRGB and hex.
- `writeObj` writes one OBJ per group with renumbered vertices (`v`, `vn`, `f a//a b//b c//c`) and a manifest of the groups' colours and face counts: one Geometry COMP and material per file in TouchDesigner, the way toejam's `models/` are laid out. glTF is Y up; so are TouchDesigner and Blender.

## CLI

```
btkulka-trellis check|fetch [--comfy DIR]
btkulka-trellis serve [--comfy DIR] [--url URL] [--shared-models DIR] [--force]     (foreground; Ctrl+C stops it)
btkulka-trellis stop
btkulka-trellis generate (--image FILE | --prompt TEXT) --name NAME [--out DIR] [--quality high] [--seed N] [--resolution N] [--style TEXT]
btkulka-trellis obj IN.glb OUT_PREFIX [--colors N] [--scale S]
```

## Renting a GPU (for what 8 GB can't hold)

Boxy, closed objects need more than an 8 GB card has (see below). `rent` does the same run on a GPU rented by the minute on RunPod, through `@btkulka/runpod-client`:

```
btkulka-trellis rent --image drawer.png --image counter.png --out models/trellis            # the plan and its price; rents nothing
btkulka-trellis rent --image drawer.png --image counter.png --out models/trellis --yes      # rents, models, terminates
```

1. **The plan** (spends nothing): the GPUs with at least 40 GB (`--min-memory`) on hosts with CUDA 13 (the torch below needs it), cheapest first, Community Cloud then Secure, and the worst case: the dearest candidate's rate over the deadline (15 min + 5 a model, at least 30; `--minutes`). Over the budget (`--budget`, default $2) it won't rent. In Nov 2026 a 48 GB A40 was about $0.35 an hour, so four models cost about $0.20.
2. **The pod** (`--yes`): `runpod/pytorch` with the same ComfyUI commit the local install runs (`COMFY_REV`), torch 2.14.1 for CUDA 13, the TRELLIS.2 weights from Hugging Face, ComfyUI on the pod's localhost and a small token proxy (`PROXY_PY`) on its port 8188: RunPod's HTTPS proxy has no authentication, so every request carries a random per-rental token. Setup takes about 10 minutes (the boot script's steps show as it goes); then each model takes a minute or two on a 48 GB card.
3. **The models**: `generate()` against the pod (`remote: true`: the GLB comes back over ComfyUI's `/view`), into `--out` as usual. A model that fails is reported and the rest go on.
4. **The end**: the pod is terminated when the models are done, on an error, on Ctrl+C, and at the deadline at the latest, twice over: a detached watchdog on this PC and the pod's own timer. `btkulka-runpod pods` shows anything still running; `btkulka-runpod sweep` ends strays.

The key: Benhäus › Settings › Credentials › RunPod (`runpod/shared`), or `RUNPOD_API_KEY`. Only image input works on a rented GPU (the concept-image checkpoint isn't downloaded there).

```ts
const plan = await rentPlan({ apiKey, jobs: [{ image: "drawer.png", name: "drawer" }], outDir: "models/trellis" });
if (plan.ok && (await ask(`at most $${plan.maxCostUsd}?`))) {
  const r = await rentAndGenerate({ apiKey, jobs, outDir: "models/trellis", onLog: console.log });
  // r.results (GenerateResult[]), r.failures, r.spentUsd, r.minutes, r.gpu
}
```

`TrellisEnv` takes `headers` (sent with every request) and `remote` (results over HTTP) for any ComfyUI on another machine, rented or not.

## What the first runs taught (tome adventures, Nov 12 2026)

- Timings on this machine: the SDXL Turbo concept about 25 s, the TRELLIS run about 3 minutes (250k triangles, 7.5 MB GLB). Free RAM dipped to about 1.6 GB during sampling with the desktop apps closed.
- SDXL base in the main ComfyUI is a truncated download; Turbo is the one that works.
- Don't voxel-remesh TRELLIS output: it is a thin shell and remeshing hollows it into holes.
- Organic and ruined subjects come out well; crisp architecture is still better built by hand. Use it for one-off hero pieces, not for kits of repeated parts.
- On an 8 GB card, boxy closed objects don't fit (toejam's mms, Nov 16 2026): a box's flat faces each span the whole 1024 grid, millions of surface voxels, and the shape decoder's later stages need single tensors of 7 GB and more. A safe-deposit drawer, a money counter, a banknote bundle and a brick all ran out in VaeDecodeShapeTrellis; 1024 is the upsample stage's minimum, and slicing the decoder's MLP only moved the overflow to the next stage. Open, round or slender subjects came through in 1 to 4 minutes (a lamp on a pier, a round vault door, a doorway, a desk scanner, a money heap). For boxes, use a hosted generator or a bigger GPU.
- TRELLIS cannot take a mesh in. To "improve" an existing model you can only render it to an image and generate a new mesh from that, which re-interprets it at lower fidelity. Use it for things you have no model of.
