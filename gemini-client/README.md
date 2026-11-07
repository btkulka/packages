# @btkulka/gemini-client

The Gemini API (Google AI Studio) for Ben's apps: an API key in, and the calls they make:

- **models**: list them (one page, or every page), get one; the same `GET /v1beta/models` Benhäus uses to test the key;
- **video**: generate a clip with **Gemini Omni Flash** (`gemini-omni-1.1-flash`) through the Interactions API: `start` it in the background, `get` it, `wait` for it with backoff and an `AbortSignal`, `download` the MP4 as bytes, or `generate` to do all four; `cancel` and `delete`;
- **prices**: a per-second table per model and resolution, with the date it was read and its source, a run's estimate, and the real cost from a finished clip's `usage`;
- **`gemini-video`**: a Node-only CLI that renders a prompt, or a JSON file of jobs, to `<name>.mp4` files, with the key from Benhäus Credentials.

**Veo is gone from the Gemini API.** Google shut the Veo 3.1 previews (`veo-3.1-generate-preview`, `veo-3.1-fast-generate-preview`, `veo-3.1-lite-generate-preview`) on 2026-10-22, and `veo-3.0-*` and `veo-2.0-*` from 2026-06-30, so their `:predictLongRunning` call no longer exists on an AI Studio key. Google's replacement is Gemini Omni Flash (GA 2026-08-27), which this package uses. A request naming a Veo model throws (`retired_model`) without a request. Veo 3.1 GA survives on Google Cloud's Gemini Enterprise Agent Platform, which takes Cloud credentials, not this key.

The key is passed in; the library never reads env or `.env`. Nothing generates (or costs anything) unless the app calls `video.start` or `video.generate`. It is built on [`@btkulka/http-kit`](../http-kit): a per-attempt timeout, the caller's `AbortSignal`, a 429 that waits out `Retry-After`, a 5xx or a dropped connection that backs off, and an abort or another 4xx never retried. Browser-safe: no `node:*` imports, no `Buffer` (the CLI is a separate entry the index never imports). ESM and CommonJS builds.

```json
"dependencies": { "@btkulka/gemini-client": "file:../packages/gemini-client" }
```

Build it first (`npm run build` here, or in the packages home); apps load `dist/`.

## The key, from Benhäus Credentials

`package.json` declares the credential (`benhaus.credential`), so Benhäus offers **Gemini (Google AI Studio)** in Settings › Credentials › Add: one secret field, `apiKey` (`AIza…`), env `GEMINI_API_KEY`, tested with `GET https://generativelanguage.googleapis.com/v1beta/models?pageSize=1` and the key in `x-goog-api-key` (200 means it works; that call is free). Its hints name an invalid key (`API_KEY_INVALID`), the API turned off on the key's project (`SERVICE_DISABLED`), a key restricted to other APIs or to websites, and a country the API doesn't serve.

For toejam's clips the credential is `gemini/toejam`. An app reads it with [`@btkulka/benhaus-client`](../benhaus-client)'s `loadCredential`, which falls back to the environment when Benhäus is closed:

```ts
import { loadCredential } from "@btkulka/benhaus-client";
import { createGeminiClient } from "@btkulka/gemini-client";

const cred = await loadCredential("gemini/toejam", { app: "toejam", env: { apiKey: "GEMINI_API_KEY" }, required: ["apiKey"] });
const gemini = createGeminiClient({ apiKey: cred?.fields.apiKey });
```

Without a key the client still makes; every call then throws `GeminiAuthError` (code `missing_api_key`) without a request.

## Getting a key working, once

1. **Key**: [aistudio.google.com/apikey](https://aistudio.google.com/apikey) › Create API key (AI Studio makes a Google Cloud project for it with the Generative Language API turned on). Save it in Benhäus as above and press Test.
2. **Billing**: video is **paid tier only**: Omni Flash has no free tier, so a free key gets a 429 with `limit: 0` (category `setup`). In AI Studio › API keys (or Projects), "Set up billing" on the key's project: pick a Google billing account (or make one: country, contact, card), then prepay at least $5 (new accounts default to Prepay) or choose Postpay. That's Tier 1, effective at once: a $250 monthly cap per billing account and a $10 spend limit per rolling 10 minutes, which a batch of clips can reach (about 10 one-dollar clips). The Google Cloud $300 welcome credit doesn't pay for the Gemini API (excluded since March 2026). On Prepay, a $0 balance stops every key on the billing account at once.
3. **Region**: the Gemini API serves the United States (and most countries; aistudio.google.com/docs/available-regions). Elsewhere the call fails with `User location is not supported` (category `setup`).

## API

```ts
import { createGeminiClient, estimateRunCost, isGeminiError } from "@btkulka/gemini-client";

const gemini = createGeminiClient({ apiKey });

// What a run would cost, before spending anything.
estimateRunCost([{ seconds: 8 }, { seconds: 8, resolution: "1080p" }]).usd;   // 1.6218

// One clip, start to bytes.
const { bytes, interaction } = await gemini.video.generate(
  { prompt: "Vertical phone footage of a packed club dance floor, strobes, handheld", aspectRatio: "9:16", seconds: 8, negativePrompt: "text, logos" },
  { signal, onPoll: (i, ms) => console.log(i.status, ms) },
);

// Or step by step, keeping the id so a crash can pick it up again.
const started = await gemini.video.start({ prompt, aspectRatio: "9:16" });   // { id, status: "in_progress" }
const done = await gemini.video.wait(started.id, { signal });
const mp4 = await gemini.video.download(done);                               // Uint8Array

try {
  await gemini.video.generate({ prompt });
} catch (err) {
  if (isGeminiError(err, "setup")) { /* billing, the API turned off, or the country */ }
  if (isGeminiError(err, "blocked")) { /* the safety filters */ }
}
```

`createGeminiClient(options)`

| Option | Default | |
|---|---|---|
| `apiKey` | required | Empty: every call throws `GeminiAuthError` (code `missing_api_key`) without a request. Sent as `x-goog-api-key`, never in the URL. |
| `fetch` | global `fetch` | `(url, init) => Promise<{ ok, status, headers?, text(), arrayBuffer?() }>`; `arrayBuffer` only for a download by `uri`. |
| `baseUrl` | `https://generativelanguage.googleapis.com` | The key goes to this origin only: a video `uri` anywhere else is refused. |
| `apiVersion` | `v1beta` | The Interactions API is beta. |
| `timeoutMs` | 60 000 | Per attempt. A finished interaction carries its video inline, so its GET is big. |
| `downloadTimeoutMs` | 300 000 | Per attempt, for a download by `uri`. |
| `attempts` | 3 | In all, for a 429, a 5xx, a timeout or a dropped connection. |
| `baseDelayMs` | 1 000 | The first backoff wait, doubled each retry; a 429's `Retry-After` replaces it. |
| `interactionHeaders` | none | Extra headers on interactions calls, e.g. `{ "Api-Revision": "2026-05-20" }` to pin the revision Google's background-execution examples use. |

Calls (every call takes `{ signal }`):

| Call | Google | |
|---|---|---|
| `models.list({ pageSize?, pageToken? })` | `GET /v1beta/models` | One page: `{ models, nextPageToken? }`. `pageSize` up to 1 000. |
| `models.listAll(options?, limit = 5000)` | | Follows `nextPageToken`. |
| `models.get(id)` | `GET /v1beta/models/{id}` | `models/` in front is fine. |
| `video.request(req)` | | The body `start` would send, after the same checks. Sends nothing: what a dry run prints. |
| `video.start(req, { background = true })` | `POST /v1beta/interactions` | **Paid.** Background: answers at once with the id. Retried only on a 429, since after a 5xx or a timeout the generation may have started. |
| `video.get(id)` | `GET /v1beta/interactions/{id}` | The interaction; once `completed`, its video is inline base64 in `steps[].content[]`. |
| `video.wait(idOrInteraction, { intervalMs = 5000, factor = 1.5, maxIntervalMs = 30000, timeoutMs = 20 min, onPoll? })` | `GET …/{id}` until done | Returns the completed interaction with a video. Throws `GeminiError`: `generation_failed`, `cancelled`, `incomplete`, `no_video` (completed without one: category `blocked`), `wait_timeout` (the clip carries on at Google: wait again by id), or `aborted`. |
| `video.download(interactionOrVideo, { fileWaitMs? })` | inline, or `GET /v1beta/files/{id}` then `…/files/{id}:download?alt=media` | The first video's bytes. |
| `video.generate(req, options)` | start, wait, download | `{ interaction, bytes, mimeType }`. |
| `video.cancel(id)` | `POST /v1beta/interactions/{id}/cancel` | |
| `video.delete(id)` | `DELETE /v1beta/interactions/{id}` | The stored interaction and its video. Google keeps them 55 days on the paid tier otherwise. |

## The video request

| `VideoRequest` | Sent as | |
|---|---|---|
| `prompt` | `input` | Required. With `images`, the last item of `input`. |
| `model` | `model` | Default `gemini-omni-1.1-flash`, the only video model on the Gemini API (2026-11-02). Any `veo-*` throws `retired_model`. |
| `aspectRatio` | `response_format.aspect_ratio` | `9:16` or `16:9` (Google's default). Nothing else. |
| `resolution` | `response_format.resolution` | `360p`, `720p` (Google's default), `1080p`, `4k`. 1080p and 4K are upscaled from 720p. |
| `seconds` | `response_format.duration` as `"8s"` | 3 to 10, whole. Google documents 3–10 s output but types `duration` as a bare string with no format, so this is the one field the docs don't settle: a 400 on it means leave `seconds` out and say the length in the prompt. Left out, Google picks. |
| `negativePrompt` | appended to the prompt as `Avoid: …` | Omni has no negative-prompt field (Google: put negatives in the prompt). |
| `seed` | `generation_config.seed` | Not a promise of the same clip. |
| `images` | `{ type: "image", data, mime_type }` items before the prompt | Image-to-video. Bytes or base64. Name them in the prompt: `<IMAGE_REF_0>`…, `<FIRST_FRAME>`, `<LAST_FRAME>`. |
| `task` | `generation_config.video_config.task` | `text_to_video`, `image_to_video`, `reference_to_video`, `edit`, `extend`. Google recommends leaving it to the prompt. |
| `previousInteractionId` | `previous_interaction_id` | Edit or extend a clip made before (extensions add 3–10 s, up to 40 s in all). |
| `delivery` | `response_format.delivery` | `inline` (Google's default) or `uri`. `wait` reads the inline copy either way. |

Every request is `background: true, store: true` (background needs storage). What Omni doesn't have: a sample count (one clip per interaction: start several), a person-generation switch, or an audio toggle: every clip comes **with generated audio**, steered only by the prompt ("no dialogue", "only the music"); a visualizer mutes or replaces it anyway. Output is 24 fps with an invisible SynthID watermark.

## Prices

`VIDEO_PRICES`, read **2026-11-02** (`PRICES_READ_ON`) from [aistudio.google.com/docs/pricing](https://aistudio.google.com/docs/pricing) (`PRICES_SOURCE`), paid tier, Standard:

| Model | Resolution | $ a second | |
|---|---|---|---|
| `gemini-omni-1.1-flash` | 720p | 0.10136 | Google's figure: 5,792 output tokens a second × $17.50 per 1M ("approximately $0.10 per second"). |
| `gemini-omni-1.1-flash` | 1080p, 4k | 0.10136 (assumed) | Upscaled from 720p; Google gives no separate rate. |
| `gemini-omni-1.1-flash` | 360p | 0.10136 (assumed) | No rate given; probably less. |

`TOKEN_PRICES` holds the per-1M rates (input $1.50, text output and thinking $9.00, video output $17.50). No free tier. An 8-second 720p clip is about $0.81; ten of them about $8.11. `estimateClipCost`/`estimateRunCost` use the table (a clip without `seconds` counts as 10, the maximum) and ignore prompt and thinking tokens (cents). `costOfUsage(model, interaction.usage)` prices a finished clip from Google's own counts, which settles the 1080p and 4K question after one real run.

## Errors

Every failure is a `GeminiError` (an `HttpError` from http-kit, so `status`, `body`, `url`, `retryAfterMs` and `kind` are there). `status` is the HTTP status, `code` Google's status name (`INVALID_ARGUMENT`, `PERMISSION_DENIED`, `RESOURCE_EXHAUSTED`…) or this package's (`missing_api_key`, `retired_model`, `generation_failed`, `no_video`, `wait_timeout`, `timeout`, `network`, `aborted`), `reason` the ErrorInfo reason when Google sent one (`API_KEY_INVALID`, `SERVICE_DISABLED`), `quotaIds` the quotas a 429 names, and `category` is what to do about it:

| `category` | When | |
|---|---|---|
| `auth` | No key; 401; `API_KEY_INVALID` (Google sends a bad key as a 400), expired, or restricted to other APIs or sites | A `GeminiAuthError`. Fix the key. Never retried. |
| `setup` | The key's project can't: `SERVICE_DISABLED`, `BILLING_DISABLED`, a free-tier quota of `limit: 0` (no billing), prepaid credit gone, a spend cap, `User location is not supported` | Fix it in AI Studio or Google Cloud. Never retried. |
| `validation` | Any other 4xx, and requests this package refuses before sending | Fix the request. |
| `not_found` | 404 | No such model, interaction or file. |
| `rate_limit` | 429 | Retried after `Retry-After`; a per-day quota isn't. |
| `blocked` | A safety refusal (400 or a failed interaction whose message says so), or `completed` without a video | Reword the prompt. Never retried. |
| `other` | 5xx, a failed or cancelled generation, a timeout, a dropped connection, an abort | Retried, except an abort and a finished generation. |

`isGeminiError(err, "blocked")` checks the class and the category in one go. Google doesn't document what a blocked interaction looks like, so `blocked` is this package's best reading of it; the error's `body` holds the whole interaction.

## What the filters stop (for bar and club scenes)

Google's [Generative AI Prohibited Use Policy](https://policies.google.com/terms/generative-ai/use-policy) and the Omni page, read 2026-11-02: adults drinking, dancing and partying aren't prohibited; sexually explicit content, violence, minors in anything sensitive, dangerous or illegal activity (drug use on screen is the risk in a club scene), and impersonating a real person are. Omni won't take uploaded images of certain recognizable people, and in the EEA, Switzerland and the UK it won't take uploaded images of minors or edit uploaded videos. So: describe made-up adults ("people in their twenties"), name no celebrities or real DJs, keep it clothed and non-violent, and leave drugs out. Filters run on the prompt and the output and vary by region; a refusal is a `blocked` error (Google doesn't say whether a refused output is billed).

## gemini-video (the CLI)

```
gemini-video "<prompt>" --out <folder> [--name <name>] [options]
gemini-video --jobs <jobs.json> --out <folder> [options]
```

Node only; its own entry (`dist/esm/cli/gemini-video.js`, the package's `bin`). The key comes from Benhäus credential `gemini/toejam` (field `apiKey`, env `GEMINI_API_KEY` as the fallback) through `loadCredential`; `--credential` and `--app` change the id and the reader. The flags are the defaults for every job: `--aspect` (default **9:16**), `--resolution` (720p), `--seconds`, `--negative`, `--model`; `--name`, `--seed` and `--image` (a start frame) are for a single prompt. `--concurrency` (default 2), `--force` (make clips again even when `<name>.mp4` is there), `--help`.

It **prints the estimate first, every time**, sends nothing without `--yes` (exit 2), and `--dry-run` prints each request (the key hidden) and sends nothing. It writes `<name>.mp4` (through a `.part` file). Each started clip leaves its interaction id in `<out>/.gemini-video/<name>.json` until its MP4 is written, so a run that stops (Ctrl+C, a closed terminal, a timeout) picks the clip up on the next run at no new charge; a clip whose `.mp4` exists is skipped. Exit codes: 0 done, 1 a failure, 2 needs `--yes`.

A jobs file is an array (or `{ "jobs": [...] }`) of `{ name, prompt, negativePrompt?, aspect?, resolution?, seconds?, model?, seed?, image? }`, `image` relative to the file:

```json
[
  { "name": "bar-01", "prompt": "Vertical phone footage inside a dim neon cocktail bar, adults in their twenties laughing and clinking glasses, handheld, shallow focus", "seconds": 8 },
  { "name": "club-02", "prompt": "Vertical phone footage from the middle of a packed club dance floor, strobes and haze, arms up, handheld shake", "seconds": 8, "negativePrompt": "text, logos, faces in close-up" }
]
```

```
npx gemini-video --jobs clips.json --out D:/source/toejam/pieces/<piece>/stand-ins --dry-run
npx gemini-video --jobs clips.json --out D:/source/toejam/pieces/<piece>/stand-ins --yes
```

## Working on it

`npm run build` here (or in the packages home), `npm test` runs `src/**/*.test.ts` against a fake `fetch` (`src/fake-fetch.test.ts`); nothing talks to Google. The CLI's tests run in temp folders with a stub key. Wire format checked on 2026-11-02 against aistudio.google.com/docs/omni, /docs/interactions-overview, /docs/background-execution, /api-reference/interactions-api, /docs/deprecations, /docs/changelog, /docs/pricing, /docs/billing and /docs/rate-limits (ai.google.dev/gemini-api/docs now redirects there). Not settled by the docs, so check on the first paid run: the `duration` string's format, whether 1080p and 4K cost more tokens, and what a blocked interaction looks like. Source imports use `.js` extensions; no `import.meta` or top-level `await` (the CommonJS build needs neither).
