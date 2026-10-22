// @datrapscallion/comfy-client — backend ComfyUI adapter.
//
// Pure Node: HTTP + WebSocket client, workflow-graph builders, job queue, and
// an in-memory trace ring buffer. No UI, no Electron, no IPC. Image post-
// processing (sharp) is a separate optional entry point: "./postprocess".

// High-level facade — the complete intermediary between an app and ComfyUI.
// Most consumers want this; the lower-level client/builders below are for
// advanced or custom orchestration.
export { ComfyService } from "./comfy-service.js";
export type {
  ComfyServiceConfig,
  GenerationDefaults,
  GenerateRequest,
  GenerateResult,
  GeneratedImage,
  ControlNetRequest,
  EditRequest,
  SaveRequest,
  PixelateRequest,
  ProgressEvent,
  ProgressHandler,
} from "./comfy-service.js";

export { ComfyClient, ComfyError } from "./comfy-client.js";
export type {
  ComfyImage,
  ComfyModels,
  RunProgress,
  ComfyQueueState,
  ComfyQueueItem,
  ComfyHistoryItem,
} from "./comfy-client.js";

export {
  getComfyWs,
  setComfyClientIdPrefix,
} from "./comfy-ws.js";
export type {
  ComfyWsClient,
  ComfyWsHandlers,
  ComfyExecutionError,
} from "./comfy-ws.js";

export {
  buildTextToImageWorkflow,
  buildDialogueArtWorkflow,
} from "./workflow.js";
export type { WorkflowParams, LoraSpec, ControlNetSpec } from "./workflow.js";

export { buildEditWorkflow } from "./edit-workflow.js";
export type { EditWorkflowParams } from "./edit-workflow.js";

export { ImageJobQueue, QueueFullError } from "./queue.js";

export { comfyTrace, tracedFetch } from "./comfy-trace.js";
export type { TracedFetchInit } from "./comfy-trace.js";

// Trace entry shapes (plain TS — consumers needing runtime validation keep
// their own schema structurally matched to these).
export type {
  ComfyTag,
  ComfyTraceEntry,
  ComfyTraceHttpReq,
  ComfyTraceHttpRes,
  ComfyTraceHttpErr,
  ComfyTraceWs,
  ComfyTraceWsMeta,
} from "./trace-types.js";
