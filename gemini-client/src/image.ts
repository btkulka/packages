// Image generation on the Gemini API: Nano Banana Pro (`gemini-3-pro-image`), Nano Banana 2.1 and Nano
// Banana 2, through the Interactions API (`POST /v1beta/interactions`, the way Google documents image
// generation since 2026, the same call video uses) with `response_format: { type: "image" }`. Up to 14
// reference images ride along before the prompt's text: a style to match, the object from the front for
// its other sides. The call answers when the image is drawn (no background mode, no polling).
//
// The models think before they draw and may make up to two draft images on the way (thought steps,
// not charged); the finished image is the last image in the model's output. A paid generation isn't
// repeated on a 500 or a timeout (Google may have made and billed it): only a 429 or a 503 ("high demand"),
// which Google turns away before drawing anything.

import { bytesToBase64, base64ToBytes } from "./bytes.js";
import type { CallOptions, Transport } from "./call.js";
import { GeminiError, invalid, wrap } from "./errors.js";
import { DEFAULT_IMAGE_MODEL, imageModel, type ImageSize } from "./pricing.js";
import type { ImageMimeType, Interaction, InteractionContent } from "./video.js";

export type ImageAspectRatio = "1:1" | "1:4" | "1:8" | "2:3" | "3:2" | "3:4" | "4:1" | "4:3" | "4:5" | "5:4" | "8:1" | "9:16" | "16:9" | "21:9";
/** Every ratio a Nano Banana model takes; Pro takes the ten without 1:4, 1:8, 4:1 and 8:1. */
export const IMAGE_ASPECT_RATIOS: readonly ImageAspectRatio[] = ["1:1", "1:4", "1:8", "2:3", "3:2", "3:4", "4:1", "4:3", "4:5", "5:4", "8:1", "9:16", "16:9", "21:9"];
const WIDE_ONLY: readonly ImageAspectRatio[] = ["1:4", "1:8", "4:1", "8:1"];
/** Upper-case K: Google rejects `2k`. */
export const IMAGE_SIZES: readonly ImageSize[] = ["1K", "2K", "4K"];
/** References a call takes at most (Pro holds 5 at high fidelity, 3 of them styles). */
export const MAX_REFERENCE_IMAGES = 14;

/** A reference image: base64 or bytes. */
export interface ReferenceImage {
  data: string | Uint8Array;
  mimeType: ImageMimeType;
}

export interface ImageRequest {
  prompt: string;
  /** Default gemini-3-pro-image (Nano Banana Pro). Aliases: `pro`, `2.1`, `flash`, `nano-banana-pro`… */
  model?: string;
  /** Before the prompt's text, in order; refer to them in the prompt ("the object in the first image"). */
  images?: ReferenceImage[];
  /** Left out: the first reference's shape, or square with none. */
  aspectRatio?: ImageAspectRatio;
  /** 1K (Google's default), 2K or 4K. */
  size?: ImageSize;
  /** A standing brief (the house style), put ahead of the prompt as its own paragraph. */
  system?: string;
  /** Also ask for text: the model then says what it drew, or why it didn't. Default false (image only, as Google's examples). */
  text?: boolean;
}

/** The body `generate` sends: what a dry run prints. */
export interface ImageInteractionBody {
  model: string;
  input: string | InteractionContent[];
  response_format: Record<string, unknown> | Record<string, unknown>[];
}

export interface GeneratedImage {
  bytes: Uint8Array;
  mimeType: string;
}

export interface ImageResult {
  /** The finished image. */
  image: GeneratedImage;
  /** Draft images from the model's thinking, when Google sent them. */
  thoughts: GeneratedImage[];
  /** What the model said alongside. */
  text: string;
  /** The model id that answered. */
  model: string;
  interaction: Interaction;
}

export interface GenerateImageOptions extends CallOptions {
  /** Per attempt. Default 300 000 (a 4K image with thinking can take a minute or two). */
  timeoutMs?: number;
}

export interface ImageApi {
  /** The body `generate` would send, after the same checks. Nothing is sent. */
  request(req: ImageRequest): ImageInteractionBody;
  /** One image from a prompt and any references. Paid. */
  generate(req: ImageRequest, options?: GenerateImageOptions): Promise<ImageResult>;
}

/** The checks and the body. */
export function imageBody(req: ImageRequest): ImageInteractionBody {
  const info = imageModel(req.model ?? DEFAULT_IMAGE_MODEL);
  const model = info?.id ?? (req.model ?? "").replace(/^models\//, "").trim();
  const prompt = (req.prompt ?? "").trim();
  if (!prompt) throw invalid("No prompt given.");
  const refs = req.images ?? [];
  if (refs.length > MAX_REFERENCE_IMAGES) throw invalid(`${refs.length} reference images: the most a call takes is ${MAX_REFERENCE_IMAGES}.`);
  if (req.aspectRatio !== undefined && !IMAGE_ASPECT_RATIOS.includes(req.aspectRatio)) throw invalid(`Aspect ratio ${String(req.aspectRatio)}: use one of ${IMAGE_ASPECT_RATIOS.join(", ")}.`);
  if (req.aspectRatio && info?.tier === "pro" && WIDE_ONLY.includes(req.aspectRatio)) throw invalid(`Nano Banana Pro has no ${req.aspectRatio}; the Flash models do.`);
  if (req.size !== undefined && !IMAGE_SIZES.includes(req.size)) throw invalid(`Size ${String(req.size)}: use 1K, 2K or 4K (capital K).`);

  const system = (req.system ?? "").trim();
  const text = system ? `${system}\n\n${prompt}` : prompt;
  const input: string | InteractionContent[] = refs.length
    ? [
        ...refs.map((r, i): InteractionContent => {
          if (!r?.mimeType || !/^image\//.test(r.mimeType)) throw invalid(`Reference ${i} needs an image/* mimeType.`);
          const data = typeof r.data === "string" ? r.data.replace(/^data:[^,]*,/, "") : bytesToBase64(r.data);
          if (!data) throw invalid(`Reference ${i} is empty.`);
          return { type: "image", data, mime_type: r.mimeType };
        }),
        { type: "text", text },
      ]
    : text;
  const image: Record<string, unknown> = { type: "image" };
  if (req.aspectRatio) image.aspect_ratio = req.aspectRatio;
  if (req.size) image.image_size = req.size;
  return { model, input, response_format: req.text ? [{ type: "text" }, image] : image };
}

const toImage = (c: InteractionContent): GeneratedImage => ({ bytes: base64ToBytes(c.data as string), mimeType: c.mime_type ?? "image/png" });
const isImage = (c: InteractionContent | undefined) => c?.type === "image" && typeof c.data === "string" && !!c.data;

/** The images in the model's output, in order (the finished one is the last). */
export function outputImagesOf(i: Interaction | undefined): GeneratedImage[] {
  const items = [...(i?.steps ?? []).filter((s) => s?.type === "model_output").flatMap((s) => s.content ?? []), ...(i?.outputs ?? [])];
  return items.filter(isImage).map(toImage);
}

/** The draft images from thought steps. */
export function thoughtImagesOf(i: Interaction | undefined): GeneratedImage[] {
  return (i?.steps ?? [])
    .filter((s) => s?.type === "thought")
    .flatMap((s) => [...(s.summary ?? []), ...(s.content ?? [])])
    .filter(isImage)
    .map(toImage);
}

const SAFETY = /\b(safety|blocked|policy|policies|prohibited|responsible ai|filtered|harm)/i;

function textOfOutput(i: Interaction): string {
  return [...(i.steps ?? []).filter((s) => s?.type === "model_output").flatMap((s) => s.content ?? []), ...(i.outputs ?? [])]
    .filter((c) => c?.type === "text" && typeof c.text === "string")
    .map((c) => (c.text as string).trim())
    .filter(Boolean)
    .join("\n");
}

/** A completed interaction with an image passes; anything else throws a GeminiError saying why. */
function settle(i: Interaction, model: string): void {
  const said = textOfOutput(i);
  if (i.status === "completed" || i.status === undefined) {
    if (outputImagesOf(i).length) return;
    throw new GeminiError(`${model} finished without an image${said ? `: ${said.slice(0, 400)}` : " (most likely a safety filter)"}.`, { code: "no_image", category: "blocked", body: i });
  }
  const errs = (i.errors ?? []).map((e) => [e.message, e.code].filter(Boolean).join(" ")).filter(Boolean).join("; ") || said;
  throw new GeminiError(`${model} ${i.status}${errs ? `: ${errs.slice(0, 400)}` : ""}.`, {
    code: i.status === "failed" ? "generation_failed" : String(i.status),
    category: SAFETY.test(errs) ? "blocked" : "other",
    body: i,
  });
}

export function imageApi({ call }: Transport): ImageApi {
  const generate = async (req: ImageRequest, o: GenerateImageOptions = {}): Promise<ImageResult> => {
    const body = imageBody(req);
    try {
      const i = await call<Interaction>("POST", "/interactions", { body, signal: o.signal, retry: "rate_limit", timeoutMs: o.timeoutMs ?? 300_000 });
      settle(i, body.model);
      const out = outputImagesOf(i);
      return { image: out[out.length - 1]!, thoughts: thoughtImagesOf(i), text: textOfOutput(i), model: i.model ?? body.model, interaction: i };
    } catch (err) {
      throw wrap(err);
    }
  };
  return { request: imageBody, generate };
}
