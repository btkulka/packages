// The video models the Gemini API serves, the ones it retired, and what a second of video costs.
// Read from Google's pages on PRICES_READ_ON; prices change, so check PRICES_SOURCE before a big run.

/** When the prices and models below were read from Google's pages. */
export const PRICES_READ_ON = "2026-11-02";
/** Where the prices came from (ai.google.dev/gemini-api/docs/pricing redirects here). */
export const PRICES_SOURCE = "https://aistudio.google.com/docs/pricing";
/** Where the retirements came from. */
export const DEPRECATIONS_SOURCE = "https://aistudio.google.com/docs/deprecations";

export type VideoTier = "standard" | "fast" | "lite";

export interface VideoModelInfo {
  id: string;
  label: string;
  tier: VideoTier;
  /** GA, preview… */
  stage: "ga" | "preview";
  released: string;
  /** Output length Google documents, in seconds. */
  minSeconds: number;
  maxSeconds: number;
  fps: number;
  /** Usable on a free-tier key (no billing). */
  freeTier: boolean;
}

/**
 * The video models on the Gemini API, newest first. On 2026-11-02 there is one: Gemini Omni Flash
 * (GA 2026-08-27, Interactions API). Google lists no standard ("pro") or lite Omni tier, and Veo left
 * the Gemini API (RETIRED_VIDEO_MODELS).
 */
export const VIDEO_MODELS: readonly VideoModelInfo[] = [
  { id: "gemini-omni-1.1-flash", label: "Gemini Omni Flash", tier: "fast", stage: "ga", released: "2026-08-27", minSeconds: 3, maxSeconds: 10, fps: 24, freeTier: false },
];

export const DEFAULT_VIDEO_MODEL = "gemini-omni-1.1-flash";

export interface RetiredVideoModel {
  id: string;
  shutDown: string;
  replacement: string;
}

/**
 * Video models the Gemini API shut down (DEPRECATIONS_SOURCE, read PRICES_READ_ON). A request naming
 * one is refused before it's sent. Veo 3.1 GA lives on in Google Cloud's Gemini Enterprise Agent
 * Platform, which an AI Studio key doesn't open.
 */
export const RETIRED_VIDEO_MODELS: readonly RetiredVideoModel[] = [
  { id: "gemini-omni-flash-preview", shutDown: "2026-10-22", replacement: "gemini-omni-1.1-flash" },
  { id: "veo-3.1-generate-preview", shutDown: "2026-10-22", replacement: "gemini-omni-1.1-flash" },
  { id: "veo-3.1-fast-generate-preview", shutDown: "2026-10-22", replacement: "gemini-omni-1.1-flash" },
  { id: "veo-3.1-lite-generate-preview", shutDown: "2026-10-22", replacement: "gemini-omni-1.1-flash" },
  { id: "veo-3.0-generate-001", shutDown: "2026-06-30", replacement: "gemini-omni-1.1-flash" },
  { id: "veo-3.0-fast-generate-001", shutDown: "2026-06-30", replacement: "gemini-omni-1.1-flash" },
  { id: "veo-2.0-generate-001", shutDown: "2026-06-30", replacement: "gemini-omni-1.1-flash" },
  { id: "veo-3.0-generate-preview", shutDown: "2025-11-12", replacement: "gemini-omni-1.1-flash" },
  { id: "veo-3.0-fast-generate-preview", shutDown: "2025-11-12", replacement: "gemini-omni-1.1-flash" },
];

/** The retirement for a model id (`models/` in front is fine), or undefined. Any `veo-*` counts. */
export function retiredVideoModel(model: string): RetiredVideoModel | undefined {
  const id = model.replace(/^models\//, "").trim();
  return RETIRED_VIDEO_MODELS.find((m) => m.id === id) ?? (/^veo-/i.test(id) ? { id, shutDown: "2026-10-22", replacement: DEFAULT_VIDEO_MODEL } : undefined);
}

export type VideoResolution = "360p" | "720p" | "1080p" | "4k";

/** Token prices per 1M, paid tier, Standard (not Batch or Flex). */
export interface TokenPrices {
  input: number;
  outputText: number;
  outputVideo: number;
}

export interface VideoPrice {
  model: string;
  resolution: VideoResolution;
  /** US dollars a second of output video. */
  usdPerSecond: number;
  /** Video output tokens a second of this resolution. */
  tokensPerSecond: number;
  /** false: Google gives no figure for this resolution and this row assumes the 720p one. */
  verified: boolean;
  note: string;
}

/** Per-1M-token prices per model, paid tier (PRICES_SOURCE, PRICES_READ_ON). No free tier for video. */
export const TOKEN_PRICES: Readonly<Record<string, TokenPrices>> = {
  "gemini-omni-1.1-flash": { input: 1.5, outputText: 9, outputVideo: 17.5 },
};

/** Google: "calculated at a rate of 5,792 tokens per second of 720p video", "approximately $0.10 per second". */
const OMNI_720P_TOKENS_PER_SECOND = 5_792;
const omni = (resolution: VideoResolution, verified: boolean, note: string): VideoPrice => ({
  model: "gemini-omni-1.1-flash",
  resolution,
  tokensPerSecond: OMNI_720P_TOKENS_PER_SECOND,
  usdPerSecond: (OMNI_720P_TOKENS_PER_SECOND * 17.5) / 1_000_000,
  verified,
  note,
});

/**
 * What a second of video costs, per model and resolution (paid tier, Standard). Read on PRICES_READ_ON
 * from PRICES_SOURCE. Google prices output video by token ($17.50 per 1M) and gives a rate only for
 * 720p (5,792 tokens a second, about $0.10); 1080p and 4K are upscaled from it and 360p isn't priced,
 * so those rows assume the 720p rate until a real run's `usage` says otherwise.
 */
export const VIDEO_PRICES: readonly VideoPrice[] = [
  omni("720p", true, "5,792 tokens/s × $17.50 per 1M (Google: about $0.10 a second)."),
  omni("1080p", false, "Upscaled from 720p; Google gives no separate rate, so this assumes 720p's."),
  omni("4k", false, "Upscaled from 720p; Google gives no separate rate, so this assumes 720p's."),
  omni("360p", false, "Google gives no rate; this assumes 720p's (likely an overestimate)."),
];

/** The price row for a model and resolution (720p when none is given), or undefined for a model without one. */
export function videoPrice(model: string = DEFAULT_VIDEO_MODEL, resolution: VideoResolution = "720p"): VideoPrice | undefined {
  const id = model.replace(/^models\//, "");
  return VIDEO_PRICES.find((p) => p.model === id && p.resolution === resolution);
}

export interface ClipCostInput {
  model?: string;
  resolution?: VideoResolution;
  /** Seconds of video. Left out: the model's maximum (10 for Omni Flash), since Google doesn't promise a shorter one. */
  seconds?: number;
}

export interface ClipCost {
  model: string;
  resolution: VideoResolution;
  seconds: number;
  /** The seconds were assumed (none given). */
  assumedSeconds: boolean;
  usdPerSecond: number;
  usd: number;
  /** The price row is Google's own figure, not an assumption. */
  verified: boolean;
  /** No price for this model: usd is 0 and means "unknown". */
  unknown: boolean;
}

/** An estimate for one clip: seconds × the per-second price. Prompt tokens and the model's thinking aren't counted (cents at most). */
export function estimateClipCost(input: ClipCostInput = {}): ClipCost {
  const model = (input.model ?? DEFAULT_VIDEO_MODEL).replace(/^models\//, "");
  const resolution = input.resolution ?? "720p";
  const info = VIDEO_MODELS.find((m) => m.id === model);
  const assumedSeconds = input.seconds == null;
  const seconds = input.seconds ?? info?.maxSeconds ?? 10;
  const price = videoPrice(model, resolution);
  const usdPerSecond = price?.usdPerSecond ?? 0;
  return { model, resolution, seconds, assumedSeconds, usdPerSecond, usd: round(seconds * usdPerSecond), verified: price?.verified ?? false, unknown: !price };
}

export interface RunCost {
  usd: number;
  clips: ClipCost[];
  /** Some clip used an assumed price or length. */
  approximate: boolean;
  /** Some clip's model has no price here. */
  unknown: boolean;
}

/** The estimate for a run of clips. */
export function estimateRunCost(clips: readonly ClipCostInput[]): RunCost {
  const each = clips.map(estimateClipCost);
  return {
    usd: round(each.reduce((s, c) => s + c.usd, 0)),
    clips: each,
    approximate: each.some((c) => !c.verified || c.assumedSeconds),
    unknown: each.some((c) => c.unknown),
  };
}

/** The Interactions API's `usage`, as far as cost needs it. */
export interface UsageLike {
  total_input_tokens?: number;
  total_output_tokens?: number;
  total_thought_tokens?: number;
  output_tokens_by_modality?: Array<{ modality?: string; tokens?: number }>;
}

/**
 * What a finished interaction cost, from its `usage`: video output tokens at the video rate, other
 * output and thinking at the text rate, input at the input rate. Undefined for a model without prices.
 */
export function costOfUsage(model: string, usage: UsageLike | undefined): { usd: number; videoTokens: number; seconds720p: number } | undefined {
  const p = TOKEN_PRICES[model.replace(/^models\//, "")];
  if (!p || !usage) return undefined;
  const byModality = usage.output_tokens_by_modality ?? [];
  const videoTokens = byModality.filter((m) => m.modality === "video").reduce((s, m) => s + (m.tokens ?? 0), 0);
  const otherOutput = Math.max(0, (usage.total_output_tokens ?? 0) - videoTokens);
  const usd = (videoTokens * p.outputVideo + (otherOutput + (usage.total_thought_tokens ?? 0)) * p.outputText + (usage.total_input_tokens ?? 0) * p.input) / 1_000_000;
  return { usd: round(usd), videoTokens, seconds720p: Math.round((videoTokens / OMNI_720P_TOKENS_PER_SECOND) * 10) / 10 };
}

/** Dollars to the hundredth of a cent. */
const round = (usd: number): number => Math.round(usd * 10_000) / 10_000;

/** `$0.81` (cents) or `$0.0123` under a cent. */
export function formatUsd(usd: number): string {
  return usd > 0 && usd < 0.01 ? `$${usd.toFixed(4)}` : `$${usd.toFixed(2)}`;
}

// ---- Images: Nano Banana Pro, Nano Banana 2.1, Nano Banana 2 ----

export type ImageSize = "1K" | "2K" | "4K";

/** When the image models and prices were read (PRICES_SOURCE, aistudio.google.com/docs/models, /docs/image-generation). */
export const IMAGE_PRICES_READ_ON = "2026-11-18";

export interface ImageModelInfo {
  id: string;
  /** Short names the CLI and apps accept. */
  aliases: string[];
  label: string;
  tier: "pro" | "flash";
  stage: "ga" | "preview";
  released?: string;
  freeTier: boolean;
}

/**
 * The image models, on 2026-11-18: all three Stable, none with a free tier. The previews
 * (`gemini-3-pro-image-preview`, `gemini-3.1-flash-image-preview`) shut down 2026-06-25. Google
 * recommends Nano Banana 2.1 for new projects; Pro is the one that thinks hardest and keeps 5
 * references at high fidelity.
 */
export const IMAGE_MODELS: readonly ImageModelInfo[] = [
  { id: "gemini-3-pro-image", aliases: ["nano-banana-pro", "pro"], label: "Nano Banana Pro (Gemini 3 Pro Image)", tier: "pro", stage: "ga", freeTier: false },
  { id: "gemini-nano-banana-2.1", aliases: ["nano-banana-2.1", "2.1", "banana-2.1"], label: "Nano Banana 2.1", tier: "flash", stage: "ga", released: "2026-10-06", freeTier: false },
  { id: "gemini-3.1-flash-image", aliases: ["nano-banana-2", "flash"], label: "Nano Banana 2 (Gemini 3.1 Flash Image)", tier: "flash", stage: "ga", freeTier: false },
];

export const DEFAULT_IMAGE_MODEL = "gemini-3-pro-image";

/** The model for an id or an alias (`models/` in front is fine; a retired preview id maps to its replacement), or undefined. */
export function imageModel(model: string): ImageModelInfo | undefined {
  const id = model.replace(/^models\//, "").trim().toLowerCase();
  const renamed = id === "gemini-3-pro-image-preview" ? "gemini-3-pro-image" : id === "gemini-3.1-flash-image-preview" ? "gemini-nano-banana-2.1" : id;
  return IMAGE_MODELS.find((m) => m.id === renamed || m.aliases.includes(renamed));
}

export interface ImagePrice {
  model: string;
  size: ImageSize;
  /** US dollars an output image (Google's figure). */
  usdPerImage: number;
  /** Output image tokens an image of this size. */
  tokensPerImage: number;
}

/** Per-1M-token prices, paid tier, Standard. `outputImage` prices the image tokens; thinking is billed as text output. */
export const IMAGE_TOKEN_PRICES: Readonly<Record<string, { input: number; outputText: number; outputImage: number }>> = {
  "gemini-3-pro-image": { input: 2, outputText: 12, outputImage: 120 },
  "gemini-nano-banana-2.1": { input: 1.5, outputText: 7.5, outputImage: 30 },
  "gemini-3.1-flash-image": { input: 0.5, outputText: 3, outputImage: 60 },
};

/** Pro: "Image input is set at 560 tokens or $0.0011 per image." The others give no count; this assumes Pro's. */
export const INPUT_IMAGE_TOKENS = 560;

const ip = (model: string, size: ImageSize, tokensPerImage: number, usdPerImage: number): ImagePrice => ({ model, size, tokensPerImage, usdPerImage });

/**
 * What an output image costs (PRICES_SOURCE, read IMAGE_PRICES_READ_ON). Draft images from thinking are
 * not charged. Nano Banana 2.1 at 4K: the image page says 2,520 tokens, the pricing page 3,780 and
 * $0.113 (which 3,780 × $30 per 1M matches); this takes the pricing page's.
 */
export const IMAGE_PRICES: readonly ImagePrice[] = [
  ip("gemini-3-pro-image", "1K", 1120, 0.134),
  ip("gemini-3-pro-image", "2K", 1120, 0.134),
  ip("gemini-3-pro-image", "4K", 2000, 0.24),
  ip("gemini-nano-banana-2.1", "1K", 1120, 0.0336),
  ip("gemini-nano-banana-2.1", "2K", 1680, 0.0504),
  ip("gemini-nano-banana-2.1", "4K", 3780, 0.113),
  ip("gemini-3.1-flash-image", "1K", 1120, 0.067),
  ip("gemini-3.1-flash-image", "2K", 1680, 0.101),
  ip("gemini-3.1-flash-image", "4K", 2520, 0.151),
];

/** The price row for a model (any of its names) and size, or undefined. */
export function imagePrice(model: string = DEFAULT_IMAGE_MODEL, size: ImageSize = "1K"): ImagePrice | undefined {
  const id = imageModel(model)?.id ?? model;
  return IMAGE_PRICES.find((p) => p.model === id && p.size === size);
}

export interface ImageCostInput {
  model?: string;
  size?: ImageSize;
  /** Reference images sent with it. */
  references?: number;
}

export interface ImageCost {
  model: string;
  size: ImageSize;
  usd: number;
  /** No price for this model: usd is 0 and means "unknown". */
  unknown: boolean;
}

export interface ImageRunCost {
  usd: number;
  images: ImageCost[];
  unknown: boolean;
}

/** An estimate for a run of images: each image's price plus its references at the input rate. The prompt's text and the thinking aren't counted (a cent or so). */
export function estimateImageCost(images: readonly ImageCostInput[]): ImageRunCost {
  const each = images.map((i): ImageCost => {
    const size = i.size ?? "1K";
    const id = imageModel(i.model ?? DEFAULT_IMAGE_MODEL)?.id ?? (i.model ?? DEFAULT_IMAGE_MODEL);
    const p = imagePrice(id, size);
    const t = IMAGE_TOKEN_PRICES[id];
    const refs = t ? ((i.references ?? 0) * INPUT_IMAGE_TOKENS * t.input) / 1_000_000 : 0;
    return { model: id, size, usd: p ? round(p.usdPerImage + refs) : 0, unknown: !p };
  });
  return { usd: round(each.reduce((s, c) => s + c.usd, 0)), images: each, unknown: each.some((c) => c.unknown) };
}

/**
 * What a finished image cost, from the interaction's `usage`: image tokens at the image rate, other
 * output and thinking at the text rate, input at the input rate. Without an image figure in
 * `output_tokens_by_modality`, the size's row stands in. Undefined for a model without prices.
 */
export function costOfImageUsage(model: string, size: ImageSize, usage: UsageLike | undefined): { usd: number; imageTokens: number } | undefined {
  const id = imageModel(model)?.id ?? model.replace(/^models\//, "");
  const p = IMAGE_TOKEN_PRICES[id];
  if (!p || !usage) return undefined;
  const reported = (usage.output_tokens_by_modality ?? []).filter((m) => m.modality === "image").reduce((s, m) => s + (m.tokens ?? 0), 0);
  const imageTokens = reported || (imagePrice(id, size)?.tokensPerImage ?? 0);
  const otherOutput = Math.max(0, (usage.total_output_tokens ?? 0) - imageTokens);
  const usd = (imageTokens * p.outputImage + (otherOutput + (usage.total_thought_tokens ?? 0)) * p.outputText + (usage.total_input_tokens ?? 0) * p.input) / 1_000_000;
  return { usd: round(usd), imageTokens };
}
