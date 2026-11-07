// @btkulka/gemini-client: the Gemini API (Google AI Studio) for Ben's apps. An API key in; the models
// list and video generation (Gemini Omni Flash through the Interactions API: start, get, wait, download),
// with a per-second price table and cost estimates. Built on @btkulka/http-kit. Browser-safe: no node:*
// imports, no Buffer. The Node-only CLI (`gemini-video`, src/cli) isn't exported here.
// Source imports use .js extensions; no import.meta or top-level await (the CommonJS build needs neither).

export {
  createGeminiClient,
  GEMINI_API_URL,
  GEMINI_API_VERSION,
  retryable,
  USER_AGENT,
  type GeminiClient,
  type GeminiClientOptions,
  type GeminiFetch,
  type GeminiFetchResponse,
} from "./client.js";
export type { CallOptions } from "./call.js";
export { categoryOf, GeminiAuthError, GeminiError, isGeminiError, type GeminiErrorCategory, type GeminiErrorCode } from "./errors.js";
export { modelId, type ListModelsOptions, type Model, type ModelList, type ModelsApi } from "./models.js";
export {
  ASPECT_RATIOS,
  fileIdOf,
  interactionBody,
  MAX_SECONDS,
  MIN_SECONDS,
  RESOLUTIONS,
  textOf,
  VIDEO_TASKS,
  videosOf,
  type AspectRatio,
  type DownloadOptions,
  type GeneratedVideo,
  type ImageMimeType,
  type Interaction,
  type InteractionBody,
  type InteractionContent,
  type InteractionStatus,
  type InteractionStep,
  type StartOptions,
  type VideoApi,
  type VideoDelivery,
  type VideoImage,
  type VideoOutput,
  type VideoRequest,
  type VideoTask,
  type WaitOptions,
} from "./video.js";
export {
  costOfUsage,
  DEFAULT_VIDEO_MODEL,
  DEPRECATIONS_SOURCE,
  estimateClipCost,
  estimateRunCost,
  formatUsd,
  PRICES_READ_ON,
  PRICES_SOURCE,
  retiredVideoModel,
  RETIRED_VIDEO_MODELS,
  TOKEN_PRICES,
  VIDEO_MODELS,
  VIDEO_PRICES,
  videoPrice,
  type ClipCost,
  type ClipCostInput,
  type RetiredVideoModel,
  type RunCost,
  type TokenPrices,
  type UsageLike,
  type VideoModelInfo,
  type VideoPrice,
  type VideoResolution,
  type VideoTier,
} from "./pricing.js";
export { base64ToBytes, bytesToBase64 } from "./bytes.js";
export type { FetchLike, FetchLikeInit, FetchLikeResponse } from "@btkulka/http-kit";
