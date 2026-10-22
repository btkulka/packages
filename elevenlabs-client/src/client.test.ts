import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createElevenLabsClient,
  ElevenLabsAuthError,
  ElevenLabsError,
  type FetchLike,
  type FetchLikeInit,
  type FetchLikeResponse,
} from "./index.js";

type Reply = { status: number; body?: unknown; headers?: Record<string, string> } | Error | "hang";

/** Replies in order; the last reply repeats. */
function fake(replies: Reply[]) {
  const calls: { url: string; init: FetchLikeInit }[] = [];
  let i = 0;
  const fetch: FetchLike = (url, init = {}) => {
    calls.push({ url, init });
    const r = replies[Math.min(i++, replies.length - 1)]!;
    if (r === "hang") {
      return new Promise((_res, reject) => init.signal?.addEventListener("abort", () => reject(new Error("The operation was aborted"))));
    }
    if (r instanceof Error) return Promise.reject(r);
    const raw = r.body instanceof Uint8Array ? r.body : new TextEncoder().encode(typeof r.body === "string" ? r.body : JSON.stringify(r.body ?? {}));
    const h = new Map(Object.entries(r.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
    const res: FetchLikeResponse = {
      ok: r.status >= 200 && r.status < 300,
      status: r.status,
      headers: { get: (n) => h.get(n.toLowerCase()) ?? null },
      text: async () => new TextDecoder().decode(raw),
      arrayBuffer: async () => raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength) as ArrayBuffer,
    };
    return Promise.resolve(res);
  };
  return { fetch, calls };
}

const AUDIO = new Uint8Array([0x49, 0x44, 0x33, 1, 2, 3]);
const client = (f: FetchLike, extra: Partial<Parameters<typeof createElevenLabsClient>[0]> = {}) =>
  createElevenLabsClient({ apiKey: "k-123", fetch: f, retryDelayMs: 1, ...extra });

test("textToSpeech posts text, model and settings to the voice and returns the bytes", async () => {
  const f = fake([{ status: 200, body: AUDIO }]);
  const out = await client(f.fetch).textToSpeech({
    voiceId: "lhTvHflPVOqgSWyuWQry",
    text: "こんにちは",
    modelId: "eleven_multilingual_v2",
    voiceSettings: { stability: 0.7, similarity_boost: 0.85, style: 0, use_speaker_boost: true },
  });
  assert.deepEqual([...out], [...AUDIO]);
  const { url, init } = f.calls[0]!;
  assert.equal(url, "https://api.elevenlabs.io/v1/text-to-speech/lhTvHflPVOqgSWyuWQry?output_format=mp3_44100_128");
  assert.equal(init.method, "POST");
  assert.equal(init.headers!["xi-api-key"], "k-123");
  assert.equal(init.headers!["Content-Type"], "application/json");
  assert.deepEqual(JSON.parse(init.body!), {
    text: "こんにちは",
    model_id: "eleven_multilingual_v2",
    voice_settings: { stability: 0.7, similarity_boost: 0.85, style: 0, use_speaker_boost: true },
  });
});

test("textToSpeech leaves out what wasn't given and honours outputFormat and baseUrl", async () => {
  const f = fake([{ status: 200, body: AUDIO }]);
  await client(f.fetch, { baseUrl: "http://localhost:9/" }).textToSpeech({ voiceId: "v/1", text: "hi", outputFormat: "pcm_24000" });
  assert.equal(f.calls[0]!.url, "http://localhost:9/v1/text-to-speech/v%2F1?output_format=pcm_24000");
  assert.deepEqual(JSON.parse(f.calls[0]!.init.body!), { text: "hi" });
});

test("soundGeneration sends output_format as a query param and clamps duration and influence", async () => {
  const f = fake([{ status: 200, body: AUDIO }]);
  const c = client(f.fetch);
  await c.soundGeneration({ text: "gong", durationSeconds: 6, promptInfluence: 0.4 });
  await c.soundGeneration({ text: "tick", durationSeconds: 0.3, promptInfluence: 1.5 });
  await c.soundGeneration({ text: "long", durationSeconds: 45, promptInfluence: -1 });
  await c.soundGeneration({ text: "free" });
  assert.equal(f.calls[0]!.url, "https://api.elevenlabs.io/v1/sound-generation?output_format=mp3_44100_128");
  const bodies = f.calls.map((c) => JSON.parse(c.init.body!));
  assert.deepEqual(bodies, [
    { text: "gong", duration_seconds: 6, prompt_influence: 0.4 },
    { text: "tick", duration_seconds: 0.5, prompt_influence: 1 },
    { text: "long", duration_seconds: 30, prompt_influence: 0 },
    { text: "free" },
  ]);
});

test("a missing key fails with ElevenLabsAuthError before any request", async () => {
  const f = fake([{ status: 200, body: AUDIO }]);
  for (const apiKey of [undefined, null, "", "   "]) {
    await assert.rejects(
      createElevenLabsClient({ apiKey, fetch: f.fetch }).soundGeneration({ text: "x" }),
      (e: unknown) => e instanceof ElevenLabsAuthError && e.code === "missing_api_key" && e.status === 0,
    );
  }
  assert.equal(f.calls.length, 0);
});

test("401 is an auth error and is not retried", async () => {
  const f = fake([{ status: 401, body: { detail: { status: "invalid_api_key", message: "Invalid API key" } } }]);
  await assert.rejects(client(f.fetch).textToSpeech({ voiceId: "v", text: "t" }), (e: unknown) => {
    assert.ok(e instanceof ElevenLabsAuthError);
    assert.equal(e.status, 401);
    assert.equal(e.code, "invalid_api_key");
    assert.match(e.message, /ElevenLabs text-to-speech 401: invalid_api_key: Invalid API key/);
    return true;
  });
  assert.equal(f.calls.length, 1);
});

test("quota_exceeded is not an auth error and is not retried", async () => {
  const f = fake([{ status: 401, body: { detail: { status: "quota_exceeded", message: "This request exceeds your quota of 10000." } } }]);
  await assert.rejects(client(f.fetch).soundGeneration({ text: "x" }), (e: unknown) => {
    assert.ok(e instanceof ElevenLabsError && !(e instanceof ElevenLabsAuthError));
    assert.equal(e.code, "quota_exceeded");
    assert.match(e.message, /exceeds your quota/);
    return true;
  });
  assert.equal(f.calls.length, 1);
});

test("other 4xx are thrown at once with the API's detail", async () => {
  const f = fake([{ status: 422, body: { detail: [{ loc: ["body", "text"], msg: "Text too long" }, { msg: "Bad duration" }] } }]);
  await assert.rejects(client(f.fetch).soundGeneration({ text: "x" }), (e: unknown) => e instanceof ElevenLabsError && e.status === 422 && /Text too long; Bad duration/.test(e.message));
  const g = fake([{ status: 400, body: { detail: "plain string detail" } }]);
  await assert.rejects(client(g.fetch).soundGeneration({ text: "x" }), /400: plain string detail/);
  const h = fake([{ status: 404, body: "<html>nope</html>" }]);
  await assert.rejects(client(h.fetch).soundGeneration({ text: "x" }), /404: <html>nope<\/html>/);
  assert.equal(f.calls.length + g.calls.length + h.calls.length, 3);
});

test("5xx is retried with backoff, then succeeds", async () => {
  const f = fake([{ status: 500, body: { detail: "boom" } }, { status: 503 }, { status: 200, body: AUDIO }]);
  const out = await client(f.fetch).soundGeneration({ text: "x" });
  assert.equal(out.length, AUDIO.length);
  assert.equal(f.calls.length, 3);
});

test("retries stop after maxRetries", async () => {
  const f = fake([{ status: 503, body: { detail: { status: "system_busy", message: "busy" } } }]);
  await assert.rejects(client(f.fetch, { maxRetries: 1 }).soundGeneration({ text: "x" }), (e: unknown) => e instanceof ElevenLabsError && e.status === 503 && e.code === "system_busy");
  assert.equal(f.calls.length, 2);
  const g = fake([{ status: 500 }]);
  await assert.rejects(client(g.fetch, { maxRetries: 0 }).soundGeneration({ text: "x" }));
  assert.equal(g.calls.length, 1);
});

test("429 waits for Retry-After", async () => {
  const f = fake([{ status: 429, body: { detail: { status: "too_many_concurrent_requests", message: "slow" } }, headers: { "Retry-After": "0" } }, { status: 200, body: AUDIO }]);
  const started = Date.now();
  await client(f.fetch, { retryDelayMs: 10_000 }).soundGeneration({ text: "x" });
  assert.ok(Date.now() - started < 2_000, "Retry-After: 0 beats the 10 s backoff");
  assert.equal(f.calls.length, 2);
});

test("network errors and timeouts are retried, then reported", async () => {
  const f = fake([new TypeError("fetch failed"), { status: 200, body: AUDIO }]);
  await client(f.fetch).textToSpeech({ voiceId: "v", text: "t" });
  assert.equal(f.calls.length, 2);

  const g = fake(["hang"]);
  await assert.rejects(client(g.fetch, { timeoutMs: 20, maxRetries: 1 }).textToSpeech({ voiceId: "v", text: "t" }), (e: unknown) => e instanceof ElevenLabsError && e.code === "timeout" && /timed out after 20ms/.test(e.message));
  assert.equal(g.calls.length, 2);
});

test("an aborted signal stops at once, mid-request and mid-backoff, without retrying", async () => {
  const pre = new AbortController();
  pre.abort();
  const f = fake([{ status: 200, body: AUDIO }]);
  await assert.rejects(client(f.fetch).soundGeneration({ text: "x", signal: pre.signal }), (e: unknown) => e instanceof ElevenLabsError && e.code === "aborted" && e.name === "AbortError");
  assert.equal(f.calls.length, 0);

  const mid = new AbortController();
  const g = fake(["hang"]);
  const p = client(g.fetch).soundGeneration({ text: "x", signal: mid.signal });
  setTimeout(() => mid.abort(), 10);
  await assert.rejects(p, (e: unknown) => e instanceof ElevenLabsError && e.code === "aborted");
  assert.equal(g.calls.length, 1);

  const backoff = new AbortController();
  const h = fake([{ status: 500 }]);
  const started = Date.now();
  const q = client(h.fetch, { retryDelayMs: 10_000 }).soundGeneration({ text: "x", signal: backoff.signal });
  setTimeout(() => backoff.abort(), 20);
  await assert.rejects(q, (e: unknown) => e instanceof ElevenLabsError && e.code === "aborted");
  assert.ok(Date.now() - started < 2_000);
  assert.equal(h.calls.length, 1);
});

test("listVoices follows next_page_token", async () => {
  const f = fake([
    { status: 200, body: { voices: [{ voice_id: "a", name: "A", labels: { gender: "female" } }], has_more: true, next_page_token: "p2" } },
    { status: 200, body: { voices: [{ voice_id: "b", name: "B" }], has_more: false, next_page_token: null } },
  ]);
  const voices = await client(f.fetch).listVoices();
  assert.deepEqual(voices.map((v) => v.voice_id), ["a", "b"]);
  assert.equal(f.calls[0]!.url, "https://api.elevenlabs.io/v2/voices?page_size=100");
  assert.equal(f.calls[1]!.url, "https://api.elevenlabs.io/v2/voices?page_size=100&next_page_token=p2");
  assert.equal(f.calls[0]!.init.method, "GET");
  assert.equal(f.calls[0]!.init.headers!["xi-api-key"], "k-123");
});

test("listVoices stops on a repeated token and on a missing voices array", async () => {
  const f = fake([{ status: 200, body: { voices: [{ voice_id: "a", name: "A" }], has_more: true, next_page_token: "same" } }]);
  const v = await client(f.fetch).listVoices({ pageSize: 10 });
  assert.equal(f.calls.length, 2);
  assert.equal(v.length, 2);
  assert.match(f.calls[0]!.url, /page_size=10$/);
  const g = fake([{ status: 200, body: {} }]);
  assert.deepEqual(await client(g.fetch).listVoices(), []);
});

test("a non-JSON voices reply is a bad_response error", async () => {
  const f = fake([{ status: 200, body: "<html>" }]);
  await assert.rejects(client(f.fetch).listVoices(), (e: unknown) => e instanceof ElevenLabsError && e.code === "bad_response");
  assert.equal(f.calls.length, 1);
});
