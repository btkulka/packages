// @btkulka/meshy-client: the Meshy 3D API for Ben's apps. An API key in; image to 3D (create from a data URI,
// get, wait with backoff and an AbortSignal, list, delete, download the files), the balance, and a credit table
// per model and texture. Built on @btkulka/http-kit. Browser-safe: no node:* imports, no Buffer. The key loader
// (Benhäus credential `meshy`) is `@btkulka/meshy-client/key`, and the CLI (`meshy-3d`, src/cli) is Node-only;
// neither is exported here.
// Source imports use .js extensions; no import.meta or top-level await (the CommonJS build needs neither).

export { createMeshyClient, MESHY_API_URL, retryable, USER_AGENT, type Balance, type MeshyClient, type MeshyClientOptions, type MeshyFetch, type MeshyFetchResponse } from "./client.js";
export type { CallOptions } from "./call.js";
export { categoryOf, invalid, isMeshyError, MeshyError, RETRYABLE_TASK_ERRORS, type MeshyErrorCategory, type MeshyErrorCode, type TaskError } from "./errors.js";
export {
  GEOMETRY_RESOLUTIONS,
  imageTo3dBody,
  MAX_TEXTURE_PROMPT,
  MODEL_FORMATS,
  MODEL_TYPES,
  POSE_MODES,
  taskFailure,
  TEXTURE_RESOLUTIONS,
  TOPOLOGIES,
  type GenerateResult,
  type ImageBytes,
  type ImageTo3dApi,
  type ImageTo3dBody,
  type ImageTo3dRequest,
  type ListOptions,
  type ModelFormat,
  type PoseMode,
  type Task,
  type TaskStatus,
  type Topology,
  type WaitOptions,
} from "./image-to-3d.js";
export {
  AI_MODELS,
  aiModel,
  API_SOURCE,
  DEFAULT_AI_MODEL,
  DEFAULT_SMART_TOPOLOGY_MODEL,
  estimateCredits,
  estimateRunCredits,
  formatUsd,
  PLANS,
  PLANS_SOURCE,
  PRICES_READ_ON,
  PRICES_SOURCE,
  usdOf,
  usdPerCreditOf,
  type AiModelInfo,
  type CreditCost,
  type CreditInput,
  type GeometryResolution,
  type ModelType,
  type PlanInfo,
  type RunCredits,
  type TextureResolution,
} from "./pricing.js";
export { bytesToBase64, dataUri, IMAGE_TYPES, imageTypeOf, MAX_IMAGE_BYTES, shortDataUri, type ImageMimeType } from "./bytes.js";
export type { FetchLike, FetchLikeInit, FetchLikeResponse } from "@btkulka/http-kit";
