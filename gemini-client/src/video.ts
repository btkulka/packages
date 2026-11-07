// Video generation on the Gemini API: Gemini Omni Flash through the Interactions API. Veo, and its
// `:predictLongRunning` call, left the Gemini API (Veo 3.1 previews shut down 2026-10-22); a request
// naming a Veo model is refused before it's sent.
//
// The long-running shape is the Interactions API's background mode: `start` creates the interaction
// with `background: true` and gets its id at once, `get` reads it, `wait` polls it with backoff until
// it's `completed` (or failed, cancelled, out of time, or the caller's AbortSignal fires), and
// `download` turns its video into bytes: inline base64 (what `get` returns), or a Files API `uri`.

import { sleep } from "@btkulka/http-kit";
import { base64ToBytes, bytesToBase64 } from "./bytes.js";
import { seg, type CallOptions, type Transport } from "./call.js";
import { GeminiError, invalid, wrap } from "./errors.js";
import { DEFAULT_VIDEO_MODEL, retiredVideoModel, type UsageLike, type VideoResolution } from "./pricing.js";

export type AspectRatio = "16:9" | "9:16";
export type VideoTask = "text_to_video" | "image_to_video" | "reference_to_video" | "edit" | "extend";
export type VideoDelivery = "inline" | "uri";

export const ASPECT_RATIOS: readonly AspectRatio[] = ["16:9", "9:16"];
export const RESOLUTIONS: readonly VideoResolution[] = ["360p", "720p", "1080p", "4k"];
export const VIDEO_TASKS: readonly VideoTask[] = ["text_to_video", "image_to_video", "reference_to_video", "edit", "extend"];
/** Omni Flash's documented output length, in seconds. */
export const MIN_SECONDS = 3;
export const MAX_SECONDS = 10;

export type ImageMimeType = "image/png" | "image/jpeg" | "image/webp" | "image/heic" | "image/heif" | "image/gif" | "image/bmp" | "image/tiff";

/** An image for image-to-video, first and last frames, or a subject reference. */
export interface VideoImage {
  /** Base64, or the bytes. */
  data: string | Uint8Array;
  mimeType: ImageMimeType;
}

export interface VideoRequest {
  prompt: string;
  /** Default gemini-omni-1.1-flash. A Veo model throws (code retired_model) without a request. */
  model?: string;
  /** `9:16` portrait or `16:9` landscape. Google's default: 16:9. */
  aspectRatio?: AspectRatio;
  /** 360p, 720p, 1080p or 4k (1080p and 4K are upscaled). Google's default: 720p. */
  resolution?: VideoResolution;
  /**
   * 3 to 10. Sent as `response_format.duration` ("8s"): Google's reference types it as a string and
   * gives no format, so a 400 here means the format changed; leave it out and say the length in the prompt.
   */
  seconds?: number;
  /** Omni has no negative-prompt field: this is added to the prompt as "Avoid: …". */
  negativePrompt?: string;
  /** `generation_config.seed`. Google doesn't promise the same video for the same seed. */
  seed?: number;
  /** Images before the prompt, in order. Refer to them in the prompt as <IMAGE_REF_0>…, or <FIRST_FRAME> and <LAST_FRAME>. */
  images?: VideoImage[];
  /** `generation_config.video_config.task`. Google recommends leaving it to the prompt. */
  task?: VideoTask;
  /** Edit or extend a clip this key generated before (it must have been stored). */
  previousInteractionId?: string;
  /** `inline` (base64 in the interaction) or `uri` (a Files API file). Left out: Google's default, inline. */
  delivery?: VideoDelivery;
}

/** A content item, as the Interactions API writes it. */
export interface InteractionContent {
  type: string;
  text?: string;
  data?: string;
  uri?: string;
  mime_type?: string;
  [key: string]: unknown;
}

export interface InteractionStep {
  type: string;
  content?: InteractionContent[];
  summary?: InteractionContent[];
  [key: string]: unknown;
}

export type InteractionStatus = "in_progress" | "requires_action" | "completed" | "failed" | "cancelled" | "incomplete" | "requires_continuation";

/** An interaction, with Google's own field names. */
export interface Interaction {
  id: string;
  status: InteractionStatus | (string & {});
  model?: string;
  created?: string;
  updated?: string;
  steps?: InteractionStep[];
  /** Older revisions of the API put the model's content here. */
  outputs?: InteractionContent[];
  usage?: UsageLike & Record<string, unknown>;
  errors?: Array<{ code?: string; message?: string }>;
  [key: string]: unknown;
}

/** The body `start` sends: what a dry run prints. */
export interface InteractionBody {
  model: string;
  input: string | InteractionContent[];
  response_format: { type: "video"; aspect_ratio?: AspectRatio; resolution?: VideoResolution; duration?: string; delivery?: VideoDelivery };
  generation_config?: { seed?: number; video_config?: { task: VideoTask } };
  previous_interaction_id?: string;
  background: boolean;
  store: boolean;
}

export interface StartOptions extends CallOptions {
  /**
   * true (the default): Google answers at once with the id and works in the background; `wait` for it.
   * false: the call itself waits for the video (a long request; Google closes plain requests after about a minute, so prefer the default).
   */
  background?: boolean;
}

export interface WaitOptions extends CallOptions {
  /** The first wait between polls. Default 5 000. */
  intervalMs?: number;
  /** Each wait is this much longer than the last. Default 1.5. */
  factor?: number;
  /** The longest wait between polls. Default 30 000. */
  maxIntervalMs?: number;
  /** Give up after this long (code wait_timeout; the generation carries on, so `wait` again by id). Default 20 minutes. */
  timeoutMs?: number;
  /** After each poll. */
  onPoll?: (interaction: Interaction, elapsedMs: number) => void;
}

export interface DownloadOptions extends CallOptions {
  /** For a `uri` video: how long to wait for the file to turn ACTIVE. Default 120 000. */
  fileWaitMs?: number;
}

/** A generated video: inline bytes as base64, or a Files API uri. */
export interface VideoOutput {
  mimeType: string;
  data?: string;
  uri?: string;
}

export interface GeneratedVideo {
  interaction: Interaction;
  bytes: Uint8Array;
  mimeType: string;
}

export interface VideoApi {
  /** The interaction body `start` would send, after the same checks. Nothing is sent. */
  request(req: VideoRequest, options?: Pick<StartOptions, "background">): InteractionBody;
  /** `POST /v1beta/interactions`, background by default. Paid. Retried only on a 429, so it can't start two. */
  start(req: VideoRequest, options?: StartOptions): Promise<Interaction>;
  /** `GET /v1beta/interactions/{id}`. */
  get(id: string, options?: CallOptions): Promise<Interaction>;
  /** Polls until the interaction is completed with a video; throws GeminiError otherwise. */
  wait(idOrInteraction: string | Interaction, options?: WaitOptions): Promise<Interaction>;
  /** The first video of a completed interaction (or a VideoOutput) as bytes. */
  download(from: Interaction | VideoOutput, options?: DownloadOptions): Promise<Uint8Array>;
  /** start, wait, download. */
  generate(req: VideoRequest, options?: StartOptions & WaitOptions & DownloadOptions): Promise<GeneratedVideo>;
  /** `POST /v1beta/interactions/{id}/cancel`. */
  cancel(id: string, options?: CallOptions): Promise<Interaction>;
  /** `DELETE /v1beta/interactions/{id}`: the stored interaction and its video go. */
  delete(id: string, options?: CallOptions): Promise<void>;
}

/** Every video in an interaction's model output, in order. */
export function videosOf(interaction: Interaction | undefined): VideoOutput[] {
  const items = [
    ...(interaction?.steps ?? []).filter((s) => s?.type === "model_output").flatMap((s) => s.content ?? []),
    ...(interaction?.outputs ?? []),
  ];
  return items
    .filter((c) => c?.type === "video" && (typeof c.data === "string" || typeof c.uri === "string"))
    .map((c) => ({ mimeType: c.mime_type ?? "video/mp4", data: typeof c.data === "string" ? c.data : undefined, uri: typeof c.uri === "string" ? c.uri : undefined }));
}

/** The text the model wrote in its output (often why there's no video). */
export function textOf(interaction: Interaction | undefined): string {
  const items = [...(interaction?.steps ?? []).filter((s) => s?.type === "model_output").flatMap((s) => s.content ?? []), ...(interaction?.outputs ?? [])];
  return items
    .filter((c) => c?.type === "text" && typeof c.text === "string")
    .map((c) => c.text)
    .join("\n")
    .trim();
}

/** The checks and the body, shared by `request` and `start`. */
export function interactionBody(req: VideoRequest, background = true): InteractionBody {
  const model = (req.model ?? DEFAULT_VIDEO_MODEL).replace(/^models\//, "").trim();
  const retired = retiredVideoModel(model);
  if (retired) {
    throw invalid(`${model} isn't on the Gemini API any more (shut down ${retired.shutDown}); use ${retired.replacement}.`, "retired_model");
  }
  const prompt = (req.prompt ?? "").trim();
  if (!prompt) throw invalid("No prompt given.");
  if (req.aspectRatio !== undefined && !ASPECT_RATIOS.includes(req.aspectRatio)) throw invalid(`aspectRatio must be ${ASPECT_RATIOS.join(" or ")}, not ${String(req.aspectRatio)}.`);
  if (req.resolution !== undefined && !RESOLUTIONS.includes(req.resolution)) throw invalid(`resolution must be one of ${RESOLUTIONS.join(", ")}, not ${String(req.resolution)}.`);
  if (req.seconds !== undefined && !(Number.isInteger(req.seconds) && req.seconds >= MIN_SECONDS && req.seconds <= MAX_SECONDS)) {
    throw invalid(`seconds must be a whole number from ${MIN_SECONDS} to ${MAX_SECONDS}, not ${String(req.seconds)}.`);
  }
  if (req.seed !== undefined && !(Number.isInteger(req.seed) && req.seed >= 0 && req.seed <= 2 ** 32 - 1)) throw invalid(`seed must be a whole number from 0 to 4294967295, not ${String(req.seed)}.`);
  if (req.task !== undefined && !VIDEO_TASKS.includes(req.task)) throw invalid(`task must be one of ${VIDEO_TASKS.join(", ")}, not ${String(req.task)}.`);
  if (req.delivery !== undefined && req.delivery !== "inline" && req.delivery !== "uri") throw invalid(`delivery must be inline or uri, not ${String(req.delivery)}.`);

  const negative = (req.negativePrompt ?? "").trim();
  const text = negative ? `${prompt}\n\nAvoid: ${negative.replace(/\.$/, "")}.` : prompt;
  const images = req.images ?? [];
  const input: string | InteractionContent[] = images.length
    ? [
        ...images.map((img, i): InteractionContent => {
          if (!img?.mimeType || !/^image\//.test(img.mimeType)) throw invalid(`Image ${i} needs an image/* mimeType.`);
          const data = typeof img.data === "string" ? img.data.replace(/^data:[^,]*,/, "") : bytesToBase64(img.data);
          if (!data) throw invalid(`Image ${i} is empty.`);
          return { type: "image", data, mime_type: img.mimeType };
        }),
        { type: "text", text },
      ]
    : text;

  const format: InteractionBody["response_format"] = { type: "video" };
  if (req.aspectRatio) format.aspect_ratio = req.aspectRatio;
  if (req.resolution) format.resolution = req.resolution;
  if (req.seconds !== undefined) format.duration = `${req.seconds}s`;
  if (req.delivery) format.delivery = req.delivery;

  const body: InteractionBody = { model, input, response_format: format, background, store: true };
  const config: NonNullable<InteractionBody["generation_config"]> = {};
  if (req.seed !== undefined) config.seed = req.seed;
  if (req.task) config.video_config = { task: req.task };
  if (Object.keys(config).length) body.generation_config = config;
  if (req.previousInteractionId?.trim()) body.previous_interaction_id = req.previousInteractionId.trim();
  return body;
}

/** `files/abc-123`, `https://…/v1beta/files/abc-123`, or its `:download?alt=media` URL → `abc-123`. */
export function fileIdOf(uri: string): string | undefined {
  return /(?:^|\/)files\/([^/:?#]+)/.exec(uri)?.[1];
}

const FINISHED_BADLY: Record<string, string> = {
  failed: "generation_failed",
  cancelled: "cancelled",
  incomplete: "incomplete",
  requires_action: "requires_action",
  requires_continuation: "requires_continuation",
};
const SAFETY = /\b(safety|blocked|policy|policies|prohibited|responsible ai|filtered|harm)/i;

/** A completed interaction with a video passes; anything else that has stopped throws. In progress: undefined. */
function settle(i: Interaction): Interaction | undefined {
  if (i.status === "completed") {
    if (videosOf(i).length) return i;
    const said = textOf(i);
    throw new GeminiError(`Interaction ${i.id} finished without a video${said ? `: ${said.slice(0, 400)}` : " (most likely a safety filter)"}.`, { code: "no_video", category: "blocked", body: i });
  }
  const code = FINISHED_BADLY[i.status];
  if (!code) return undefined;
  const said = (i.errors ?? []).map((e) => [e.message, e.code].filter(Boolean).join(" ")).filter(Boolean).join("; ") || textOf(i);
  throw new GeminiError(`Interaction ${i.id} ${i.status}${said ? `: ${said.slice(0, 400)}` : ""}.`, {
    code,
    category: code === "generation_failed" && SAFETY.test(said) ? "blocked" : "other",
    body: i,
  });
}

export function videoApi({ call, bytes, root }: Transport): VideoApi {
  const get = (id: string, o: CallOptions = {}) => call<Interaction>("GET", `/interactions/${seg(id, "interaction id")}`, { signal: o.signal });

  const start = async (req: VideoRequest, o: StartOptions = {}): Promise<Interaction> => {
    const background = o.background ?? true;
    const body = interactionBody(req, background);
    const i = await call<Interaction>("POST", "/interactions", { body, signal: o.signal, retry: "rate_limit", timeoutMs: background ? undefined : 15 * 60_000 });
    if (!i || typeof i.id !== "string" || !i.id) throw new GeminiError("Google answered the interaction without an id.", { code: "INTERNAL", category: "other", body: i });
    return i;
  };

  const wait = async (from: string | Interaction, o: WaitOptions = {}): Promise<Interaction> => {
    const started = Date.now();
    const timeoutMs = o.timeoutMs ?? 20 * 60_000;
    const factor = Math.max(1, o.factor ?? 1.5);
    const maxIntervalMs = o.maxIntervalMs ?? 30_000;
    let interval = Math.max(0, o.intervalMs ?? 5_000);
    let current: Interaction | undefined = typeof from === "string" ? undefined : from;
    const id = typeof from === "string" ? from : from.id;
    try {
      for (;;) {
        // A finished interaction passed in (a non-background start) needs no poll.
        if (current) {
          const done = settle(current);
          if (done) return done;
        }
        const elapsed = Date.now() - started;
        if (current && elapsed >= timeoutMs) {
          throw new GeminiError(`Interaction ${id} is still ${current.status} after ${Math.round(elapsed / 1000)} s; it carries on at Google, so wait for it again by id.`, { code: "wait_timeout", category: "other" });
        }
        if (current) {
          await sleep(Math.min(interval, Math.max(0, timeoutMs - elapsed)), o.signal);
          interval = Math.min(maxIntervalMs, interval * factor);
        }
        current = await get(id, { signal: o.signal });
        o.onPoll?.(current, Date.now() - started);
      }
    } catch (err) {
      throw wrap(err);
    }
  };

  const waitForFile = async (id: string, o: DownloadOptions): Promise<void> => {
    const until = Date.now() + (o.fileWaitMs ?? 120_000);
    let interval = 2_000;
    for (;;) {
      const f = await call<{ state?: string; error?: { message?: string } }>("GET", `/files/${seg(id, "file id")}`, { signal: o.signal });
      if (!f?.state || f.state === "ACTIVE") return;
      if (f.state === "FAILED") throw new GeminiError(`File ${id} failed${f.error?.message ? `: ${f.error.message}` : ""}.`, { code: "generation_failed", category: "other", body: f });
      if (Date.now() >= until) throw new GeminiError(`File ${id} is still ${f.state}.`, { code: "wait_timeout", category: "other" });
      await sleep(interval, o.signal);
      interval = Math.min(10_000, interval * 1.5);
    }
  };

  const download = async (from: Interaction | VideoOutput, o: DownloadOptions = {}): Promise<Uint8Array> => {
    const video: VideoOutput | undefined = "id" in from && "status" in from ? videosOf(from as Interaction)[0] : (from as VideoOutput);
    if (!video) throw new GeminiError(`Interaction ${(from as Interaction).id} has no video to download.`, { code: "no_video", category: "blocked" });
    if (video.data) return base64ToBytes(video.data);
    if (!video.uri) throw invalid("The video has neither data nor a uri.");
    try {
      const id = fileIdOf(video.uri);
      if (!id) return await bytes(video.uri, { signal: o.signal });
      await waitForFile(id, o);
      return await bytes(`${root}/files/${encodeURIComponent(id)}:download?alt=media`, { signal: o.signal });
    } catch (err) {
      throw wrap(err);
    }
  };

  return {
    request: (req, o = {}) => interactionBody(req, o.background ?? true),
    start,
    get,
    wait,
    download,
    async generate(req, o = {}) {
      const started = await start(req, o);
      const done = await wait(started, o);
      const out = await download(done, o);
      return { interaction: done, bytes: out, mimeType: videosOf(done)[0]?.mimeType ?? "video/mp4" };
    },
    cancel: (id, o = {}) => call<Interaction>("POST", `/interactions/${seg(id, "interaction id")}/cancel`, { signal: o.signal }),
    async delete(id, o = {}) {
      await call<unknown>("DELETE", `/interactions/${seg(id, "interaction id")}`, { signal: o.signal });
    },
  };
}
