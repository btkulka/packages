# @btkulka/meshy-client

The [Meshy](https://www.meshy.ai) 3D API for Ben's apps: an API key in, and the calls they make:

- **image to 3D**: `create` a task from a local image (sent as a data URI: no upload step), `get` it, `wait` for it with backoff and an `AbortSignal`, `list` and `delete` tasks, or `generate` to create, wait and download the GLB in one go;
- **balance**: the account's credits (free to call; what Benhäus tests the key with);
- **download**: a model or texture file by its signed URL, never with the key;
- **credits**: what a task costs per model, texture and geometry, with the date it was read and its source;
- **`meshy-3d`**: a Node-only CLI that turns concept images (or a JSON file of jobs) into `<name>.glb` files, with a `<name>.meta.json` each and a `meshy-<stamp>.json` run record for toejam's Spend page.

It replaces the rented-GPU Pixal3D / TRELLIS.2 runs (`trellis-client rent`) for toejam's models: first use, the skyline piece. The key is passed in; the library never reads env or `.env`. It is built on [`@btkulka/http-kit`](../http-kit): a per-attempt timeout, the caller's `AbortSignal`, a 429 that waits out `Retry-After`, a 5xx or a dropped connection that backs off, an abort or another 4xx never retried. Browser-safe index: no `node:*` imports, no `Buffer` (the key loader and the CLI are separate Node-only entries). ESM and CommonJS builds.

```json
"dependencies": { "@btkulka/meshy-client": "file:../packages/meshy-client" }
```

Build it first (`npm run build` here, or in the packages home); apps load `dist/`.

## The key, from Benhäus Credentials

`package.json` declares the credential (`benhaus.credential`), so Benhäus offers **Meshy (image to 3D)** in Settings › Credentials › Add: one secret field, `apiKey` (`msy_…`), env `MESHY_API_KEY`, tested with `GET https://api.meshy.ai/openapi/v1/balance` and `Authorization: Bearer <key>` (200 means it works; Meshy says that call is free). Its hints name a key Meshy doesn't know (401), a key it refuses (403: an IP allowlist, an inactive team member, a plan without the API) and a 429.

Save it as credential id **`meshy`**. Keys are made at [meshy.ai › Developers › API Keys](https://www.meshy.ai/developers/keys) (shown once; a monthly credit limit can be set on the key) and need a paid plan: the Free plan has no API. Meshy's shared test-mode key was retired on 2026-09-16 and now answers 401, so there is no free key to try generation with.

```ts
import { loadMeshyKey } from "@btkulka/meshy-client/key";   // Node only: Benhäus credential `meshy`, else MESHY_API_KEY
import { createMeshyClient } from "@btkulka/meshy-client";

const meshy = createMeshyClient({ apiKey: await loadMeshyKey({ app: "toejam" }) });
```

Without a key the client still makes; every API call then throws `MeshyError` (code `missing_api_key`, category `auth`) without a request.

## API

```ts
import { createMeshyClient, estimateCredits, isMeshyError } from "@btkulka/meshy-client";

const meshy = createMeshyClient({ apiKey });
estimateCredits({ shouldTexture: false }).credits;          // 20 (latest = Meshy 7.1, mesh only)
(await meshy.balance()).balance;                           // 1000

const { task, glb } = await meshy.imageTo3d.generate(
  { image: { data: pngBytes, mimeType: "image/png" }, targetFormats: ["glb"], topology: "quad", targetPolycount: 20_000 },
  { signal, onPoll: (t) => console.log(t.status, t.progress) },
);
task.consumed_credits;                                     // what Meshy charged

// Or step by step, keeping the id so a crash can pick it up again.
const id = await meshy.imageTo3d.create({ image: "https://…/concept.png" });   // paid here
const done = await meshy.imageTo3d.wait(id, { signal });
const bytes = await meshy.download(done.model_urls!.glb!);

try { await meshy.imageTo3d.wait(id); } catch (err) {
  if (isMeshyError(err, "task_failed") && err.worthRetrying) { /* Meshy says: create it again (it was refunded) */ }
  if (isMeshyError(err, "credits")) { /* 402: top up */ }
}
```

`createMeshyClient(options)`: `apiKey` (required), `fetch` (default the global fetch; downloads need `arrayBuffer()`), `baseUrl` (`https://api.meshy.ai`), `timeoutMs` (30 000 per attempt), `downloadTimeoutMs` (300 000), `attempts` (3), `baseDelayMs` (1 000, doubled each retry; a 429's `Retry-After` replaces it).

| Call | Meshy | |
|---|---|---|
| `balance()` | `GET /openapi/v1/balance` | `{ balance, monthly_credits, permanent_credits, monthly_resets_at }`. Free. |
| `imageTo3d.request(req)` | | The body `create` would send, after the same checks. Sends nothing. |
| `imageTo3d.create(req)` | `POST /openapi/v1/image-to-3d` | **Paid.** Answers the task id. Retried only on a 429 (refused: nothing made); after a 5xx or a timeout the task may exist, so it throws (look with `list`). |
| `imageTo3d.get(id)` | `GET /openapi/v1/image-to-3d/{id}` | The task. |
| `imageTo3d.wait(id, { intervalMs = 5000, factor = 1.5, maxIntervalMs = 20000, timeoutMs = 60 min, onPoll? })` | `GET …/{id}` until final | Answers the SUCCEEDED task. Each wait is the longer of the backoff and Meshy's `Retry-After` (sent while a task runs), up to `maxIntervalMs`. Throws `MeshyError`: `task_failed` / `task_canceled` (category `task_failed`, `taskError` = Meshy's `task_error`, `worthRetrying` for `timeout`, `service_unavailable`, `server_error`), `wait_timeout` (the task carries on: wait again by id), `aborted`. |
| `imageTo3d.list({ pageNum, pageSize, sortBy })` | `GET /openapi/v1/image-to-3d` | Newest first. |
| `imageTo3d.delete(id)` | `DELETE …/{id}` | For good. A PENDING task is refunded; an IN_PROGRESS one answers 409. |
| `imageTo3d.generate(req, waitOptions)` | create, wait, download | `{ task, glb }`. |
| `download(url)` | the signed URL | Bytes. https only; the key is never sent (it only goes to `api.meshy.ai`). |

## The request (what Meshy's docs said on 2026-11-19)

Read from [docs.meshy.ai/api/image-to-3d](https://docs.meshy.ai/api/image-to-3d). Only what's set is sent, except `ai_model` and `should_texture`.

| `ImageTo3dRequest` | Sent as | |
|---|---|---|
| `image` | `image_url` | A public URL, a `data:image/png;base64,…` URI, or `{ data: bytes or base64, mimeType }` (made into a data URI). JPG, PNG, WebP; up to 20 MB; each side at least 32 px. |
| `aiModel` | `ai_model` | `latest` (default: Meshy 7.1 since 2026-09-18), `meshy-7.1`, `meshy-6`, `meshy-6-lite`, `meshy-7` (deprecated: a 400 from 2026-12-31). Smart Topology: `meshy-t2` (clean topology, parts kept apart), `meshy-t2.5` (its default, sharper detail). An id the table doesn't know is sent as given. |
| `modelType` | `model_type` | `standard` (Meshy's default) or `smart-topology` (triangles only; `should_remesh` ignored). A Smart Topology model sets it. |
| `shouldTexture` | `should_texture` | **Default false here** (mesh only: Ben's shaders do the colour). Meshy's own default is true. |
| `enablePbr` | `enable_pbr` | Metallic, roughness and normal maps too. Needs a texture. |
| `textureResolution` | `texture_resolution` | `2k` (default), `4k`, `8k`. meshy-6-lite: 2k only. |
| `texturePrompt` | `texture_prompt` | Up to 800 characters. |
| `textureModel` | `texture_model` | `meshy-7`, `meshy-n1`, `meshy-6-lite`; doesn't change the price. |
| `shouldRemesh` | `should_remesh` | Meshy's default: true for meshy-6-lite, false for the rest ("false for the highest-quality model"). |
| `topology` | `topology` | `triangle` (default) or `quad` (quad-dominant). Only when remeshing, so it turns `should_remesh` on (off with it is refused). Not on Smart Topology. |
| `targetPolycount` | `target_polycount` | Standard (remeshing): 100–300 000, default 30 000 (also turns remeshing on). meshy-t2: 100–15 000 (4 000); meshy-t2.5: 100–30 000 (15 000). |
| `poseMode` | `pose_mode` | `a-pose` or `t-pose`, for characters. |
| `geometryResolution` | `geometry_resolution` | Ultra: `2k` (latest, meshy-7.1, meshy-7) or `4k` (latest, meshy-7.1); `standard` default. |
| `imageEnhancement` | `image_enhancement` | Meshy's default true; false keeps the exact look. meshy-6, meshy-7.1, latest only. |
| `targetFormats` | `target_formats` | `glb`, `obj`, `fbx`, `stl`, `usdz`, `3mf`. Fewer is faster; Meshy's default is all but 3mf. |
| `moderation` | `moderation` | Screen the inputs; a harmful one answers 400. |
| `extra` | as given | Anything else (`auto_size`, `origin_at`, `decimation_mode`, `save_pre_remeshed_model`, `multi_view_thumbnails`…), over the fields above. |

**No symmetry option:** `symmetry_mode` is deprecated and "has no effect on output", so it isn't offered (put it in `extra` if Meshy ever revives it). The other deprecated fields (`ultra_mode`, `hd_texture`, `is_a_t_pose`, `surface_mode`) are left out too.

A finished task: `status` `SUCCEEDED`, `model_urls` (`glb`, `obj`, `mtl`, `fbx`, `usdz`, `stl`, `3mf`, `pre_remeshed_glb`, only what was made; signed URLs that expire at `expires_at`), `texture_urls[0]` (`base_color`, and `metallic`, `roughness`, `normal` with PBR), `thumbnail_url`, `consumed_credits`. Statuses: `PENDING`, `IN_PROGRESS`, `SUCCEEDED`, `FAILED`, `CANCELED`.

## Credits

`AI_MODELS`, read **2026-11-19** (`PRICES_READ_ON`) from [docs.meshy.ai/api/pricing](https://docs.meshy.ai/api/pricing) (`PRICES_SOURCE`), image to 3D, credits a task:

| `ai_model` | mesh only | + 2K texture | + 4K | + 8K | Ultra geometry |
|---|---|---|---|---|---|
| `latest` / `meshy-7.1` / `meshy-7` | 20 | 30 | 30 | 35 | +5 |
| `meshy-6` | 20 | 30 | 30 | 35 | not offered |
| `meshy-6-lite` | 5 | 15 | not offered | not offered | not offered |
| `meshy-t2`, `meshy-t2.5` (Smart Topology) | 5 | 15 | 15 | 20 | not offered |

PBR maps and the remesh pass add nothing (the page lists no charge for either), and the texture model doesn't change the price. A failed task reports `consumed_credits: 0`: Meshy refunds it. `estimateCredits` / `estimateRunCredits` read the table; a model or combination it doesn't have is `unknown` (0, never guessed).

**Dollars:** Meshy states no price per credit, on the pricing page or in the API docs. Its plans ([meshy.ai/pricing](https://www.meshy.ai/pricing), monthly, 2026-11-19): Pro $20 for 1,000 credits a month (10 tasks at once), Premium $40 for 3,000 (30), Studio $70 for 5,500 (60), Ultra $100 for 8,000 (100); the first month is half; the Free plan (100 credits) has no API. `PLANS` holds them with each one's own rate worked out (`usdPerCredit`: Pro $0.02), and `usdPerCreditOf("pro")` / `usdOf(credits, rate)` price a run only when an app asks. Credit packs are bought in Meshy's subscription settings; their prices aren't published.

Rate limits ([docs.meshy.ai/api/rate-limits](https://docs.meshy.ai/api/rate-limits)): 20 requests a second on every paid plan (polls count), and the concurrent tasks above; past either, a 429 ("NoMorePendingTasks" for too many tasks, without `Retry-After`).

## Errors

Every failure is a `MeshyError` (an `HttpError` from http-kit: `status`, `body`, `url`, `retryAfterMs`, `kind`), with `code` (this package's: `missing_api_key`, `invalid_request`, `task_failed`, `task_canceled`, `no_model`, `wait_timeout`, `insecure_url`, `timeout`, `network`, `aborted`), `taskError` and `taskId` for a task, and a `category`:

| `category` | When | |
|---|---|---|
| `auth` | No key, 401 | Fix the key. Never retried. |
| `credits` | 402: not enough credits, the key's credit limit, or a Free plan | Top up. Never retried. |
| `forbidden` | 403: moderation, IP allowlist, plan, inactive member, banned | Meshy's message says which. Never retried. |
| `validation` | 400, 422, or refused here before sending | Fix the request. |
| `not_found` / `conflict` | 404 / 409 | |
| `rate_limit` | 429 | Retried after `Retry-After` (or the backoff). |
| `task_failed` | The task ended FAILED or CANCELED (refunded) | `worthRetrying`: create it again. `invalid_input`: change the image. |
| `other` | 5xx, timeout, network, abort, `wait_timeout` | Reads retry; `create` doesn't. |

## meshy-3d (the CLI)

```
meshy-3d --image <file> [--name <name>] [--image <file> --name <name>]... --out <folder> [options]
meshy-3d --jobs <jobs.json> --out <folder> [options]
```

Node only (`dist/esm/cli/meshy-3d.js`, the package's `bin`; `npx meshy-3d` from the packages home). The key comes from Benhäus credential `meshy` (field `apiKey`, env `MESHY_API_KEY` as the fallback); `--credential` and `--app` change the id and the reader. The flags are the defaults for every job: `--model`, `--smart-topology`, `--texture`, `--pbr`, `--texture-resolution`, `--texture-prompt`, `--topology`, `--polycount`, `--remesh` / `--no-remesh`, `--pose`, `--ultra 2k|4k`, `--no-enhance`, `--formats obj,fbx` (beside the GLB, always made). `--concurrency` (default 4; Meshy runs tasks in parallel), `--usd-per-credit <number|pro|premium|studio|ultra>`, `--force`, `--help`.

It **prints the plan first, every time** (each job, its credits, the run's credits, and the balance when there is a key), sends nothing without `--yes` (exit 2), and `--dry-run` prints each request (the image shortened). With `--yes` it refuses a run the balance can't cover. It writes, in `--out`:

- `<name>.glb` (`<name>-textured.glb` when textured, with its texture maps as `<name>-textured-base_color.png`…; other formats as `<name>.obj` and its `.mtl`…), through `.part` files;
- `<name>.meta.json` (`<name>-textured.meta.json` for a textured one, so a mesh and a textured version of one concept don't overwrite each other's): the task id, the options sent, the credits, the dollars when given a rate, the seconds, the model, the source image, `tool: "@btkulka/meshy-client"`; Gallery links the model to its concept image through `image`;
- `meshy-<ISO stamp>.json`, the run record: every job with its task, status and credits, the run's credits, `usdPerCredit` and `usd` (null without a rate), the balance before and after, the models made and the failures. It is written when the first task is created and again as each moves, so a killed run still says what it spent. toejam's Spend page reads it.

A created task's id waits in `<out>/.meshy/<name>.json` until its files are written, so a run that stops (Ctrl+C twice, a closed terminal, a timeout, a failed download) picks it up next time at no new charge; that job is marked `resumed` in the new record and its credits stay with the run that created it. One Ctrl+C starts no new tasks and waits for the running ones. A model whose `.glb` exists is skipped. An auth, credits or forbidden error stops the run. Exit codes: 0 done, 1 a failure (or jobs not started), 2 needs `--yes`.

A jobs file is an array (or `{ "jobs": [...] }`) of `{ name?, image, model?, smartTopology?, texture?, pbr?, textureResolution?, texturePrompt?, topology?, polycount?, remesh?, pose?, ultra?, enhance?, formats? }`, `image` relative to the file, `name` defaulting to the image's:

```json
[
  { "name": "tower", "image": "concept/tower.png" },
  { "name": "vault", "image": "concept/vault.png", "topology": "quad", "polycount": 20000 },
  { "name": "crate", "image": "concept/crate.png", "model": "meshy-t2.5" }
]
```

```
npx meshy-3d --jobs jobs.json --out D:/source/toejam/pieces/skyline/models/meshy
npx meshy-3d --jobs jobs.json --out D:/source/toejam/pieces/skyline/models/meshy --yes
```

## Working on it

`npm run build` here (or in the packages home); `npm test` runs `src/**/*.test.ts` against a fake `fetch` and a fake Meshy (`src/fake-fetch.test.ts`); nothing talks to Meshy. `MESHY_LIVE=1 npm test` adds one live check that reads the balance with the real key (free). Source imports use `.js` extensions; no `import.meta` or top-level `await` (the CommonJS build needs neither).
