// ElevenLabs REST client: text-to-speech, sound generation, the voice list.
// No node:* imports here (files.ts has the Node helpers).

export const ELEVENLABS_API_URL = "https://api.elevenlabs.io";
export const DEFAULT_OUTPUT_FORMAT = "mp3_44100_128";
/** ElevenLabs rejects a sound-generation prompt longer than this with a 400. */
export const SOUND_GENERATION_PROMPT_LIMIT = 450;
/** The range sound generation accepts for duration_seconds; requests are clamped into it. */
export const SOUND_GENERATION_MIN_SECONDS = 0.5;
export const SOUND_GENERATION_MAX_SECONDS = 30;

/** The part of a fetch Response this package reads. A real Response fits. */
export interface FetchLikeResponse {
  ok: boolean;
  status: number;
  statusText?: string;
  headers?: { get(name: string): string | null } | null;
  text(): Promise<string>;
  arrayBuffer(): Promise<ArrayBuffer>;
}

export interface FetchLikeInit {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  signal?: AbortSignal;
}

export type FetchLike = (url: string, init?: FetchLikeInit) => Promise<FetchLikeResponse>;

/**
 * Any failed ElevenLabs call.
 * - `status`: the HTTP status, or 0 when no response came back.
 * - `code`: ElevenLabs' own `detail.status` ("quota_exceeded", "voice_not_found", …) when it
 *   sent one, else "missing_api_key" | "timeout" | "network" | "aborted" | "bad_response" | null.
 */
export class ElevenLabsError extends Error {
  readonly status: number;
  readonly code: string | null;
  readonly body: unknown;
  constructor(message: string, init: { status?: number; code?: string | null; body?: unknown; cause?: unknown } = {}) {
    super(message, init.cause === undefined ? undefined : { cause: init.cause });
    this.name = "ElevenLabsError";
    this.status = init.status ?? 0;
    this.code = init.code ?? null;
    this.body = init.body;
  }
}

/** The key is missing, invalid or lacks permission (401/403, except quota_exceeded). Never retried. */
export class ElevenLabsAuthError extends ElevenLabsError {
  constructor(message: string, init: { status?: number; code?: string | null; body?: unknown } = {}) {
    super(message, init);
    this.name = "ElevenLabsAuthError";
  }
}

export interface VoiceSettings {
  stability?: number;
  similarity_boost?: number;
  style?: number;
  use_speaker_boost?: boolean;
  speed?: number;
  [key: string]: unknown;
}

export interface TextToSpeechRequest {
  voiceId: string;
  text: string;
  /** e.g. "eleven_multilingual_v2". Omitted: the API's default model. */
  modelId?: string;
  voiceSettings?: VoiceSettings;
  /** Default "mp3_44100_128". */
  outputFormat?: string;
  signal?: AbortSignal;
}

export interface SoundGenerationRequest {
  /** The prompt. ElevenLabs caps it at SOUND_GENERATION_PROMPT_LIMIT characters. */
  text: string;
  /** Clamped to 0.5–30. Omitted: the model picks a length. */
  durationSeconds?: number;
  /** 0–1, clamped. Lower reads the prompt more loosely. Omitted: the API default (0.3). */
  promptInfluence?: number;
  /** Default "mp3_44100_128". */
  outputFormat?: string;
  signal?: AbortSignal;
}

export interface ElevenLabsVoice {
  voice_id: string;
  name: string;
  category?: string;
  description?: string | null;
  /** gender, age, accent, descriptive, use_case… */
  labels?: Record<string, string>;
  preview_url?: string | null;
  [key: string]: unknown;
}

export interface ElevenLabsClientOptions {
  /** Read it from wherever the app keeps it. A missing key fails each call with ElevenLabsAuthError. */
  apiKey: string | null | undefined;
  /** Defaults to the global fetch. */
  fetch?: FetchLike;
  /** Default https://api.elevenlabs.io */
  baseUrl?: string;
  /** Per attempt, including the body download. Default 60 000. */
  timeoutMs?: number;
  /** Extra attempts after a 429, a 5xx, a timeout or a network error. Default 2. */
  maxRetries?: number;
  /** Backoff base: retryDelayMs, then ×2 each retry. A 429's Retry-After wins. Default 2 000. */
  retryDelayMs?: number;
  /** Ceiling on a Retry-After wait. Default 60. */
  maxRetryAfterSeconds?: number;
}

export interface ElevenLabsClient {
  /** POST /v1/text-to-speech/{voice_id}. Returns the encoded audio. */
  textToSpeech(req: TextToSpeechRequest): Promise<Uint8Array>;
  /** POST /v1/sound-generation. Returns the encoded audio. */
  soundGeneration(req: SoundGenerationRequest): Promise<Uint8Array>;
  /** GET /v2/voices, following next_page_token until has_more is false. */
  listVoices(options?: { pageSize?: number; signal?: AbortSignal }): Promise<ElevenLabsVoice[]>;
}

export function createElevenLabsClient(options: ElevenLabsClientOptions): ElevenLabsClient {
  const apiKey = (options.apiKey ?? "").trim();
  const fetchImpl: FetchLike =
    options.fetch ?? ((url, init) => globalThis.fetch(url, init as RequestInit) as Promise<FetchLikeResponse>);
  const baseUrl = (options.baseUrl ?? ELEVENLABS_API_URL).replace(/\/+$/, "");
  const timeoutMs = options.timeoutMs ?? 60_000;
  const maxRetries = Math.max(0, options.maxRetries ?? 2);
  const retryDelayMs = options.retryDelayMs ?? 2_000;
  const maxRetryAfterSeconds = options.maxRetryAfterSeconds ?? 60;

  async function call<T>(label: string, url: string, init: FetchLikeInit, read: (res: FetchLikeResponse) => Promise<T>, signal?: AbortSignal): Promise<T> {
    if (!apiKey) throw new ElevenLabsAuthError("ElevenLabs API key is not set", { code: "missing_api_key" });
    for (let attempt = 0; ; attempt++) {
      if (signal?.aborted) throw abortError(label, signal);
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), timeoutMs);
      const onAbort = (): void => ac.abort();
      signal?.addEventListener("abort", onAbort, { once: true });
      let failure: ElevenLabsError;
      let res: FetchLikeResponse | undefined;
      try {
        res = await fetchImpl(url, { ...init, headers: { ...init.headers, "xi-api-key": apiKey }, signal: ac.signal });
        if (res.ok) return await read(res);
        const text = await res.text().catch(() => "");
        failure = apiError(label, res.status, text);
      } catch (err) {
        if (err instanceof ElevenLabsError) throw err;
        if (signal?.aborted) throw abortError(label, signal);
        failure = ac.signal.aborted
          ? new ElevenLabsError(`${label} timed out after ${timeoutMs}ms`, { code: "timeout", cause: err })
          : new ElevenLabsError(`${label} failed: ${err instanceof Error ? err.message : String(err)}`, { code: "network", cause: err });
      } finally {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
      }
      if (!retryable(failure) || attempt >= maxRetries) throw failure;
      let wait = retryDelayMs * 2 ** attempt;
      if (failure.status === 429 && res) {
        const after = retryAfterSeconds(res);
        if (after != null) wait = Math.min(after, maxRetryAfterSeconds) * 1000;
      }
      await sleep(wait, signal, label);
    }
  }

  const bytes = async (res: FetchLikeResponse): Promise<Uint8Array> => new Uint8Array(await res.arrayBuffer());
  const json = async <T>(res: FetchLikeResponse): Promise<T> => {
    const text = await res.text();
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new ElevenLabsError(`ElevenLabs sent a non-JSON response (${res.status})`, { status: res.status, code: "bad_response", body: text.slice(0, 300) });
    }
  };

  return {
    textToSpeech(req) {
      const format = req.outputFormat ?? DEFAULT_OUTPUT_FORMAT;
      const url = `${baseUrl}/v1/text-to-speech/${encodeURIComponent(req.voiceId)}?output_format=${encodeURIComponent(format)}`;
      const body = JSON.stringify({ text: req.text, model_id: req.modelId, voice_settings: req.voiceSettings });
      return call("ElevenLabs text-to-speech", url, { method: "POST", headers: { "Content-Type": "application/json" }, body }, bytes, req.signal);
    },

    soundGeneration(req) {
      const format = req.outputFormat ?? DEFAULT_OUTPUT_FORMAT;
      const url = `${baseUrl}/v1/sound-generation?output_format=${encodeURIComponent(format)}`;
      const body = JSON.stringify({
        text: req.text,
        duration_seconds: req.durationSeconds == null ? undefined : clamp(req.durationSeconds, SOUND_GENERATION_MIN_SECONDS, SOUND_GENERATION_MAX_SECONDS),
        prompt_influence: req.promptInfluence == null ? undefined : clamp(req.promptInfluence, 0, 1),
      });
      return call("ElevenLabs sound-generation", url, { method: "POST", headers: { "Content-Type": "application/json" }, body }, bytes, req.signal);
    },

    async listVoices(opts = {}) {
      const pageSize = opts.pageSize ?? 100;
      const voices: ElevenLabsVoice[] = [];
      let token: string | undefined;
      for (let page = 0; page < 100; page++) {
        const q = new URLSearchParams({ page_size: String(pageSize) });
        if (token) q.set("next_page_token", token);
        const data = await call(
          "ElevenLabs voices",
          `${baseUrl}/v2/voices?${q}`,
          { method: "GET" },
          json<{ voices?: ElevenLabsVoice[]; has_more?: boolean; next_page_token?: string | null }>,
          opts.signal,
        );
        voices.push(...(data.voices ?? []));
        const next = data.next_page_token ?? undefined;
        if (!data.has_more || !next || next === token) break;
        token = next;
      }
      return voices;
    },
  };
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}

function retryable(e: ElevenLabsError): boolean {
  if (e instanceof ElevenLabsAuthError) return false;
  if (e.code === "quota_exceeded") return false;
  if (e.code === "timeout" || e.code === "network") return true;
  return e.status === 429 || e.status === 408 || e.status >= 500;
}

/** ElevenLabs errors look like {"detail":{"status":"quota_exceeded","message":"…"}}, {"detail":"…"} or a 422 list. */
function apiError(label: string, status: number, text: string): ElevenLabsError {
  let code: string | null = null;
  let message = "";
  let body: unknown = text;
  try {
    body = JSON.parse(text);
  } catch {
    /* not JSON */
  }
  const detail = body && typeof body === "object" ? (body as { detail?: unknown }).detail : undefined;
  if (detail && typeof detail === "object" && !Array.isArray(detail)) {
    const d = detail as { status?: unknown; message?: unknown; code?: unknown };
    if (typeof d.status === "string") code = d.status;
    else if (typeof d.code === "string") code = d.code;
    if (typeof d.message === "string") message = d.message;
  } else if (typeof detail === "string") {
    message = detail;
  } else if (Array.isArray(detail)) {
    message = detail
      .map((d) => (d && typeof d === "object" && typeof (d as { msg?: unknown }).msg === "string" ? (d as { msg: string }).msg : JSON.stringify(d)))
      .join("; ");
  }
  if (!message) message = text.slice(0, 300) || `HTTP ${status}`;
  const full = `${label} ${status}: ${code && !message.includes(code) ? `${code}: ` : ""}${message}`;
  if ((status === 401 || status === 403) && code !== "quota_exceeded") {
    return new ElevenLabsAuthError(full, { status, code, body });
  }
  return new ElevenLabsError(full, { status, code, body });
}

function retryAfterSeconds(res: FetchLikeResponse): number | null {
  const raw = res.headers?.get?.("retry-after");
  if (raw == null || raw.trim() === "") return null;
  const n = Number(raw);
  if (Number.isFinite(n)) return Math.max(0, n);
  const at = Date.parse(raw);
  return Number.isFinite(at) ? Math.max(0, (at - Date.now()) / 1000) : null;
}

function abortError(label: string, signal: AbortSignal): ElevenLabsError {
  const e = new ElevenLabsError(`${label} was aborted`, { code: "aborted", cause: signal.reason });
  e.name = "AbortError";
  return e;
}

function sleep(ms: number, signal: AbortSignal | undefined, label: string): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(abortError(label, signal));
    const onAbort = (): void => {
      clearTimeout(t);
      reject(abortError(label, signal!));
    };
    const t = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
