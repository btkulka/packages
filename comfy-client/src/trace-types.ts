// Plain-TS shapes for the trace ring buffer. These are intentionally framework-
// free (no zod, no IPC) so this package stays pure backend. Consumers that need
// to validate trace entries across a boundary (e.g. Electron IPC) keep their own
// zod schema, structurally matched to these types.

export type ComfyTag =
  | "queue"
  | "history"
  | "view"
  | "upload"
  | "object_info"
  | "system_stats"
  | "queue-status";

export interface ComfyTraceHttpReq {
  id: number;
  ts: number;
  kind: "http-req";
  reqId: number;
  tag: ComfyTag;
  method: string;
  url: string;
  bodyPreview?: string;
}

export interface ComfyTraceHttpRes {
  id: number;
  ts: number;
  kind: "http-res";
  reqId: number;
  status: number;
  ok: boolean;
  durationMs: number;
  bytes?: number;
  bodyPreview?: string;
}

export interface ComfyTraceHttpErr {
  id: number;
  ts: number;
  kind: "http-err";
  reqId: number;
  error: string;
  durationMs: number;
}

export interface ComfyTraceWs {
  id: number;
  ts: number;
  kind: "ws";
  direction: "in";
  messageType: string;
  promptId?: string;
  payloadPreview: string;
}

export interface ComfyTraceWsMeta {
  id: number;
  ts: number;
  kind: "ws-meta";
  event: "open" | "close" | "reconnecting" | "fatal";
  detail: string;
}

export type ComfyTraceEntry =
  | ComfyTraceHttpReq
  | ComfyTraceHttpRes
  | ComfyTraceHttpErr
  | ComfyTraceWs
  | ComfyTraceWsMeta;
