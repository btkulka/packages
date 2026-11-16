// @btkulka/trellis-client: TRELLIS.2 image-to-3D through a dedicated ComfyUI, and its GLB into OBJ files.

export { TRELLIS2_WEIGHTS, checkWeights, downloadWeights, writeExtraModelPaths } from "./weights.js";
export type { WeightFile, WeightStatus, DownloadOptions } from "./weights.js";

export { TrellisError, resolveEnv, isUp, serve, stopServer, serverPid, watchMemoryFloor, threadBudget } from "./server.js";
export type { TrellisEnv, ResolvedEnv, ServeOptions, ServeHandle, TrellisErrorCode } from "./server.js";

export {
  widgetInputs,
  toApi,
  resolveSwitches,
  prune,
  ofType,
  checkpointName,
  buildTrellisPrompt,
  buildConceptPrompt,
  DEFAULT_CONCEPT_STYLE,
  DEFAULT_CONCEPT_NEGATIVE,
} from "./workflow.js";
export type { ApiPrompt, ApiNode, UiWorkflow, UiNode, ObjectInfo, TrellisPromptOptions, ConceptPromptOptions } from "./workflow.js";

export { generate, CONCEPT_MODELS, TRELLIS_TEMPLATE } from "./generate.js";
export type { GenerateOptions, GenerateResult, ConceptModel, ProgressFn } from "./generate.js";

export { parseGlb, splitByColor, writeObj, glbToObj, meshStats, srgbToOklab, oklabToSrgb } from "./glb.js";
export type { GlbMesh, ColorGroup, ObjFiles, GlbToObjOptions } from "./glb.js";
