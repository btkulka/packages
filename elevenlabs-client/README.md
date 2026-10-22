# @btkulka/elevenlabs-client

The ElevenLabs REST endpoints Ben's apps call, and nothing else:

- **text-to-speech** (`POST /v1/text-to-speech/{voice_id}`), used by starfall's cue tools;
- **sound generation** (`POST /v1/sound-generation`), used by orson's ambience and SFX authoring and starfall's SFX catalog;
- **the voice list** (`GET /v2/voices`, every page), used by starfall's `--list`.

The API key is passed in; the package never reads env or `.env`. Each call retries a 429 (honouring `Retry-After`), a 5xx, a timeout or a network error, up to 2 more times with 2 s then 4 s backoff. It never retries an auth error, a quota error or another 4xx, and it stops at once when the caller's `AbortSignal` fires. Audio comes back as a `Uint8Array`. Node helpers write it atomically and memoize renders on disk, so re-runs don't re-bill.

No runtime dependencies. The client itself has no `node:*` imports; `writeAudioFile`, `cachedAudio` and `requestHash` use `node:fs` and `node:crypto`. No browser app uses this package.

```json
"dependencies": { "@btkulka/elevenlabs-client": "file:../packages/elevenlabs-client" }
```

## API

```ts
import {
  createElevenLabsClient, writeAudioFile, cachedAudio, requestHash,
  ElevenLabsError, ElevenLabsAuthError, SOUND_GENERATION_PROMPT_LIMIT,
} from "@btkulka/elevenlabs-client";

const eleven = createElevenLabsClient({ apiKey: process.env.ELEVENLABS_API_KEY });

const speech = await eleven.textToSpeech({
  voiceId: "lhTvHflPVOqgSWyuWQry",
  text: "夕暮れの市場は…",
  modelId: "eleven_multilingual_v2",
  voiceSettings: { stability: 0.7, similarity_boost: 0.85, style: 0, use_speaker_boost: true },
  // outputFormat: "mp3_44100_128" (default), signal
});

const sfx = await eleven.soundGeneration({ text: "struck metal gong…", durationSeconds: 4.5, promptInfluence: 0.4, signal });
await writeAudioFile("out/candidate_1.mp3", sfx);   // mkdir -p, temp file + rename

const voices = await eleven.listVoices();          // ElevenLabsVoice[]: voice_id, name, labels…

// Disk memo with the app's own cache key (sha1 of JSON.stringify(value), first N hex chars):
const { path, cached } = await cachedAudio(
  `${CACHE_DIR}/${requestHash({ text, voice, modelId, settings, format }, 20)}.mp3`,
  () => eleven.textToSpeech({ voiceId: voice, text, modelId, voiceSettings: settings, outputFormat: format }),
  { force: false },
);
```

`createElevenLabsClient(options)`

| Option | Default | |
|---|---|---|
| `apiKey` | required | Empty or missing: every call throws `ElevenLabsAuthError` (code `missing_api_key`) without a request. Checked per call, so a client can be made before the key is known. |
| `fetch` | global `fetch` | Needs `ok`, `status`, `headers?.get`, `text()`, `arrayBuffer()`. |
| `baseUrl` | `https://api.elevenlabs.io` | |
| `timeoutMs` | 60 000 | Per attempt, body download included. |
| `maxRetries` | 2 | Extra attempts after a retryable failure. |
| `retryDelayMs` | 2 000 | Backoff base, doubled each retry. A 429's `Retry-After` replaces it. |
| `maxRetryAfterSeconds` | 60 | |

Requests:
- `textToSpeech({ voiceId, text, modelId?, voiceSettings?, outputFormat?, signal? })`: fields left out are left out of the body, so the API's defaults apply. Shared-library voices work by `voice_id` without being added to the account.
- `soundGeneration({ text, durationSeconds?, promptInfluence?, outputFormat?, signal? })`: `durationSeconds` is clamped to 0.5–30 and `promptInfluence` to 0–1. Leave them out for the API's defaults (the model picks the length; influence 0.3). `output_format` goes in the query string, where the API reads it. Prompts over `SOUND_GENERATION_PROMPT_LIMIT` (450) characters get a 400; the package doesn't pre-check, so the tool can report every long prompt at once.
- `listVoices({ pageSize? = 100, signal? })`: follows `next_page_token` until `has_more` is false.

Errors:
- `ElevenLabsError`: `status` (0 when no response came back), `code`, `body`. `code` is ElevenLabs' own `detail.status` (`quota_exceeded`, `voice_not_found`, `system_busy`…) or one of `timeout`, `network`, `aborted` (then `name` is `"AbortError"`), `bad_response`. Messages look like `ElevenLabs sound-generation 422: Text too long`.
- `ElevenLabsAuthError extends ElevenLabsError`: missing key, or a 401/403 other than `quota_exceeded`. ElevenLabs answers an exhausted quota with a 401, so check `code === "quota_exceeded"` (a plain `ElevenLabsError`) before telling anyone their key is wrong.

Node helpers:
- `writeAudioFile(path, bytes)`: creates folders, writes `path.<pid>-<rand>.part` and renames it into place, retrying the rename briefly on `EPERM`/`EBUSY`/`EACCES` (Windows antivirus and the indexer hold new files for a moment). A crash never leaves a half-written file for a cache to trust.
- `requestHash(value, length = 20)`: `sha1(JSON.stringify(value))` in hex, cut to `length`. The same formula starfall's caches use, so their existing files keep matching. Key order matters.
- `cachedAudio(path, render, { force? })`: returns `{ path, cached: true }` when `path` holds a non-empty file; otherwise renders, writes atomically and returns `{ path, cached: false }`.

Constants: `ELEVENLABS_API_URL`, `DEFAULT_OUTPUT_FORMAT` (`mp3_44100_128`), `SOUND_GENERATION_PROMPT_LIMIT` (450), `SOUND_GENERATION_MIN_SECONDS` (0.5), `SOUND_GENERATION_MAX_SECONDS` (30).

## Replaces

| Repo | File | What | Replaced by |
|---|---|---|---|
| orson | `src/audio/elevenlabs-rest.ts` | `MissingApiKeyError` (L20), `ElevenLabsApiError` (L27), `generateSoundEffect` (L47–100), `RateLimitedError` (L102), `runWithRetry` (L109–131), `sleep` (L133) | `createElevenLabsClient(...).soundGeneration(...)` + `writeAudioFile`; `ElevenLabsAuthError` / `ElevenLabsError` |
| orson | `src/audio/elevenlabs-rest.ts` | `generateAmbienceTakes` (L146–169) | stays in orson as a short loop over the package (orson's file naming and progress callbacks), see below |
| starfall | `tools/cues/elevenVoices.mjs` | `API` (L10), `tts()` (L85–102), `listVoices()` (L104–108) | `client.textToSpeech` inside `cachedAudio` + `requestHash(…, 20)`; `client.listVoices()` |
| starfall | `tools/cues/gen_ref_eleven.mjs` | `API` (L26), `key()` (L60–67), `listVoices()` fetch (L69–71), the inline TTS fetch in `main()` (L108–120) | `client.listVoices()`, `client.textToSpeech()` |
| starfall | `tools/sfx/gen_eleven_sfx.mjs` | `API` (L35), `key()` (L55–62), `generate()`'s fetch and cache write (L104–124) | `cachedAudio(cachedPath, () => client.soundGeneration(…), { force })` with `requestHash(req, 16)` |
| starfall | `tools/sfx/sfxPool.mjs` | `PROMPT_LIMIT = 450` (L38) | optional: `SOUND_GENERATION_PROMPT_LIMIT` |
| starfall | `tools/cues/gen_vn.mjs`, `tools/cues/gen_anime_seeds.mjs` | nothing directly: they call `tts()` from `elevenVoices.mjs` | unchanged once `elevenVoices.mjs` wraps the package |

Checked and not copies: orson `scripts/elevenlabs-mcp.ps1` / `.sh` (load `.env` and start the Python `elevenlabs-mcp` server through `uvx` for Claude's side; not a REST client, stays), orson `src/desktop/renderer/App.tsx` (a command-palette keyword), orson `src/audio/prompt-seed.ts`, `src/sfx-authoring/gaps.ts`, `src/voices/assign.ts`, `src/notifications/types.ts` and `scripts/orson/*-voices.ts` (prompt text, comments and voice metadata, no API calls), starfall `server/cueGenerators.ts` (only checks that the env var is set), starfall `src/audio/*` (plays baked files). No other in-scope repo calls ElevenLabs.

## Migrating

### orson (Electron main)

Rewrite `src/audio/elevenlabs-rest.ts` as a thin loop and keep its exports so `src/desktop/main.ts` (L113–116) and `src/sfx-authoring/runtime.ts` (L12) barely change:

```ts
import { createElevenLabsClient, writeAudioFile, ElevenLabsAuthError } from "@btkulka/elevenlabs-client";
export { ElevenLabsAuthError as MissingApiKeyError };

export async function generateAmbienceTakes(args: {
  prompt: string; outputDir: string; count: number; durationSeconds?: number;
  onTakeReady?: (idx: number, path: string) => void; signal?: AbortSignal;
}): Promise<string[]> {
  // Read the key at call time, as before (.env is loaded into process.env).
  const eleven = createElevenLabsClient({ apiKey: process.env.ELEVENLABS_API_KEY, timeoutMs: 30_000, maxRetries: 1 });
  const paths: string[] = [];
  for (let i = 0; i < args.count; i++) {
    if (args.signal?.aborted) break;
    const out = `${args.outputDir.replace(/\\$/, "")}/candidate_${i + 1}.mp3`;
    const audio = await eleven.soundGeneration({
      text: args.prompt,
      durationSeconds: Math.min(5, args.durationSeconds ?? 5), // orson's own 5 s cap
      promptInfluence: 0.4,                                      // orson's old default
      signal: args.signal,
    });
    await writeAudioFile(out, audio);
    paths.push(out);
    args.onTakeReady?.(i, out);
  }
  return paths;
}
```

Watch for:
- **Error messages.** `MissingApiKeyError` used to mean "env var unset, or any 401/403". Now `ElevenLabsAuthError` means a missing, invalid or under-permissioned key, and an exhausted quota is a plain `ElevenLabsError` with `code === "quota_exceeded"`. Before, running out of credits would have shown `ELEVENLABS_API_KEY is not set in .env.` Map the quota case to its own message in `main.ts` (L711–716) and `runtime.ts` (L184–189).
- **Durations.** The package clamps to the API's 0.5–30 s, not orson's 0.5–5 s; keep the `Math.min(5, …)`.
- **Defaults.** `promptInfluence` is no longer 0.4 by default; pass it.
- **`output_format`.** Orson put it in the JSON body, where the API ignores it. It's now a query param with the same value (`mp3_44100_128`), so the files don't change.
- **Abort.** Aborting now rejects at once with `name === "AbortError"`. Before, it slept 2 s, retried with the dead signal, then threw. `main.ts` already checks `ctrl.signal.aborted`.
- **Retries.** With `maxRetries: 1` the policy matches the old one (2 attempts). The default of 2 adds one more; either is fine.
- Writes are atomic (temp + rename) instead of streamed into the final path.

### starfall (`tools/**/*.mjs`, plain Node ESM)

Add the dependency to starfall's `package.json`.

`tools/cues/elevenVoices.mjs`: keep `FAMILY_VOICE`, `FAMILY_VOICE_EN`, `apiKey()` (its `process.exit(2)` is the CLI's behaviour), `voiceFor`, `billedChars`, `readCache`, `CACHE_DIR`. Replace `tts` and `listVoices`:

```js
import { createElevenLabsClient, cachedAudio, requestHash } from "@btkulka/elevenlabs-client";
let client;
const eleven = () => (client ??= createElevenLabsClient({ apiKey: apiKey() }));

export async function tts({ text, voice, modelId, settings, format = "mp3_44100_128" }) {
  // Same object, same key order, same 20 chars: the existing .eleven-cache files still hit.
  const key = requestHash({ text, voice, modelId, settings, format }, 20);
  return cachedAudio(resolve(CACHE_DIR, `${key}.mp3`), () =>
    eleven().textToSpeech({ voiceId: voice, text, modelId, voiceSettings: settings, outputFormat: format }));
}
export const listVoices = () => eleven().listVoices();
```

`gen_vn.mjs` and `gen_anime_seeds.mjs` keep importing `tts` and need no change.

`tools/cues/gen_ref_eleven.mjs`: drop `API`, `key()` and its own `listVoices` fetch; import `listVoices` from `elevenVoices.mjs` (the print loop stays). Replace the inline fetch with `const audio = await createElevenLabsClient({ apiKey: apiKey() }).textToSpeech({ voiceId: voice, text: args.text ?? REF_TEXT, modelId: MODEL_ID, voiceSettings: VOICE_SETTINGS })` and `writeFileSync(tmp, audio)`. The ffmpeg/ffprobe steps stay.

`tools/sfx/gen_eleven_sfx.mjs` `generate()`:

```js
const req = { text, duration_seconds: def.seconds, prompt_influence: influence, variant }; // unchanged: it is the cache key
const cachedPath = resolve(CACHE_DIR, `${family}.${id}.${requestHash(req, 16)}.mp3`);
if (args.reshape && !existsSync(cachedPath)) return null;   // --reshape never spends credits
const { path, cached } = await cachedAudio(cachedPath,
  () => eleven.soundGeneration({ text, durationSeconds: def.seconds, promptInfluence: influence }),
  { force: args.force && !args.reshape });
return { path, cached, influence };
```

Watch for:
- **Cache keys.** They must not change, or every cached take re-bills. Keep the exact objects passed to `requestHash` (field names, order, the `variant` field, lengths 20 and 16). The package's tests pin the formula.
- **Retries.** Failures are now retried (429/5xx/network, 2 retries) before the per-take `FAILED` line prints. A long batch takes longer when the API is busy instead of skipping takes.
- **Error text.** It reads `ElevenLabs sound-generation 400: …` instead of `sound-generation 400: …`.
- A zero-byte file in a cache dir is re-rendered instead of served.

## Develop

`npm run build`, `npm run typecheck`, `npm test` (builds, then runs `dist/esm/**/*.test.js` on `node:test`; fake fetch and temp dirs, no network).
