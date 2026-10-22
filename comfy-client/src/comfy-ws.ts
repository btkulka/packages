// Singleton-per-baseUrl ComfyUI websocket client. Both REST clients route
// completion-waiting through this so we get real progress numbers and full
// Python tracebacks on `execution_error` instead of polling /history.
//
// Falls back gracefully: if the socket drops, callers can still complete via
// /history polling — ws is an optimization, polling is the floor.

import { WebSocket, type RawData } from "ws";
import { comfyTrace } from "./comfy-trace.js";

export interface ComfyExecutionError {
  promptId: string;
  nodeId: string;
  nodeType: string;
  exceptionType: string;
  exceptionMessage: string;
  traceback: string[];
  currentInputs: unknown;
}

export interface ComfyWsHandlers {
  onExecuting?: (nodeId: string | null) => void;
  onProgress?: (value: number, max: number, node: string) => void;
  onExecuted?: (nodeId: string, output: unknown) => void;
  onCached?: (nodes: string[]) => void;
  onError?: (err: ComfyExecutionError) => void;
}

export interface ComfyWsClient {
  readonly clientId: string;
  /** Resolves on the first OPEN. Rejects only if the URL itself is malformed. */
  ready(): Promise<void>;
  /** Returns an unsubscribe fn. Re-entrant for the same promptId. */
  subscribe(promptId: string, h: ComfyWsHandlers): () => void;
  /**
   * Resolves on terminal `executing: { node: null }` for promptId. Rejects with
   * the abort signal's reason. Returns `{ ok: false, error }` on
   * `execution_error`. If the socket drops while waiting, resolves
   * `{ ok: "fallback" }` so the caller can fall back to /history polling.
   */
  awaitCompletion(
    promptId: string,
    signal?: AbortSignal,
  ): Promise<{ ok: true } | { ok: false; error: ComfyExecutionError } | { ok: "fallback" }>;
}

interface ComfyMessage {
  type: string;
  data: Record<string, unknown>;
}

const RECONNECT_BACKOFF_MS = [1000, 2000, 4000, 8000, 16000, 30000] as const;

class ComfyWsImpl implements ComfyWsClient {
  readonly clientId: string;
  private ws: WebSocket | null = null;
  private subs = new Map<string, Set<ComfyWsHandlers>>();
  private readyPromise: Promise<void> | null = null;
  private readyResolve: (() => void) | null = null;
  private reconnectAttempt = 0;
  private closing = false;

  constructor(private readonly baseUrl: string) {
    this.clientId = `${clientIdPrefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  }

  ready(): Promise<void> {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) return Promise.resolve();
    if (!this.readyPromise) {
      this.readyPromise = new Promise<void>((resolve) => {
        this.readyResolve = resolve;
      });
      this.connect();
    }
    return this.readyPromise;
  }

  subscribe(promptId: string, h: ComfyWsHandlers): () => void {
    let set = this.subs.get(promptId);
    if (!set) {
      set = new Set();
      this.subs.set(promptId, set);
    }
    set.add(h);
    // Lazy connect if not already.
    if (!this.ws) this.connect();
    return () => {
      const s = this.subs.get(promptId);
      if (!s) return;
      s.delete(h);
      if (s.size === 0) this.subs.delete(promptId);
    };
  }

  async awaitCompletion(
    promptId: string,
    signal?: AbortSignal,
  ): Promise<{ ok: true } | { ok: false; error: ComfyExecutionError } | { ok: "fallback" }> {
    return new Promise((resolve, reject) => {
      let unsub: (() => void) | null = null;
      const onAbort = (): void => {
        unsub?.();
        signal?.removeEventListener("abort", onAbort);
        reject(signal?.reason ?? new Error("aborted"));
      };
      if (signal) {
        if (signal.aborted) {
          reject(signal.reason ?? new Error("aborted"));
          return;
        }
        signal.addEventListener("abort", onAbort, { once: true });
      }

      const handlers: ComfyWsHandlers = {
        onExecuting: (nodeId) => {
          if (nodeId === null) {
            unsub?.();
            signal?.removeEventListener("abort", onAbort);
            resolve({ ok: true });
          }
        },
        onError: (error) => {
          unsub?.();
          signal?.removeEventListener("abort", onAbort);
          resolve({ ok: false, error });
        },
      };
      // Mark this subscriber so onSocketClose can fall it back instead of
      // hanging forever.
      const fallback = (): void => {
        unsub?.();
        signal?.removeEventListener("abort", onAbort);
        resolve({ ok: "fallback" });
      };
      (handlers as ComfyWsHandlers & { __onSocketClose?: () => void }).__onSocketClose = fallback;
      unsub = this.subscribe(promptId, handlers);
    });
  }

  private connect(): void {
    if (this.closing) return;
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) {
      return;
    }
    const wsUrl = httpToWs(this.baseUrl) + `/ws?clientId=${encodeURIComponent(this.clientId)}`;
    let socket: WebSocket;
    try {
      socket = new WebSocket(wsUrl);
    } catch (err) {
      comfyTrace.push({ kind: "ws-meta", event: "fatal", detail: (err as Error).message });
      this.scheduleReconnect();
      return;
    }
    this.ws = socket;
    socket.on("open", () => {
      comfyTrace.push({ kind: "ws-meta", event: "open", detail: wsUrl });
      this.reconnectAttempt = 0;
      if (this.readyResolve) {
        this.readyResolve();
        this.readyResolve = null;
        this.readyPromise = Promise.resolve();
      }
    });
    socket.on("message", (data) => this.onMessage(data));
    socket.on("close", (code, reason) => {
      const detail = `code=${code} reason=${reason.toString().slice(0, 100)}`;
      comfyTrace.push({ kind: "ws-meta", event: "close", detail });
      this.ws = null;
      this.notifySocketClosed();
      if (!this.closing) this.scheduleReconnect();
    });
    socket.on("error", (err) => {
      comfyTrace.push({ kind: "ws-meta", event: "fatal", detail: err.message });
      // close event will follow.
    });
  }

  private scheduleReconnect(): void {
    if (this.closing) return;
    const delay = RECONNECT_BACKOFF_MS[Math.min(this.reconnectAttempt, RECONNECT_BACKOFF_MS.length - 1)];
    this.reconnectAttempt++;
    comfyTrace.push({
      kind: "ws-meta",
      event: "reconnecting",
      detail: `attempt=${this.reconnectAttempt} delayMs=${delay}`,
    });
    setTimeout(() => this.connect(), delay);
  }

  private onMessage(raw: RawData): void {
    let parsed: ComfyMessage;
    try {
      parsed = JSON.parse(raw.toString("utf8")) as ComfyMessage;
    } catch {
      return;
    }
    if (!parsed || typeof parsed.type !== "string") return;

    const data = parsed.data ?? {};
    const promptId = typeof data["prompt_id"] === "string" ? (data["prompt_id"] as string) : undefined;
    comfyTrace.push({
      kind: "ws",
      direction: "in",
      messageType: parsed.type,
      promptId,
      payloadPreview: previewPayload(parsed),
    });

    if (!promptId) return; // status frames are global; ignore for subscriber dispatch.
    const subs = this.subs.get(promptId);
    if (!subs) return;
    for (const h of subs) {
      try {
        dispatch(parsed.type, data, h);
      } catch {
        // Subscriber errors must not break the producer.
      }
    }
  }

  private notifySocketClosed(): void {
    // Resolve every awaitCompletion to "fallback" so the caller can switch to
    // /history polling without hanging.
    for (const set of this.subs.values()) {
      for (const h of set) {
        const ext = h as ComfyWsHandlers & { __onSocketClose?: () => void };
        ext.__onSocketClose?.();
      }
    }
    this.subs.clear();
    // ready() will re-arm if a new subscriber arrives during reconnect.
    this.readyPromise = null;
    this.readyResolve = null;
  }
}

function dispatch(type: string, data: Record<string, unknown>, h: ComfyWsHandlers): void {
  switch (type) {
    case "executing": {
      const node = data["node"];
      if (node === null) h.onExecuting?.(null);
      else if (typeof node === "string") h.onExecuting?.(node);
      return;
    }
    case "executed": {
      const node = typeof data["node"] === "string" ? (data["node"] as string) : "";
      h.onExecuted?.(node, data["output"]);
      return;
    }
    case "progress": {
      const value = Number(data["value"] ?? 0);
      const max = Number(data["max"] ?? 0);
      const node = typeof data["node"] === "string" ? (data["node"] as string) : "";
      h.onProgress?.(value, max, node);
      return;
    }
    case "execution_cached": {
      const nodes = Array.isArray(data["nodes"]) ? (data["nodes"] as string[]) : [];
      h.onCached?.(nodes);
      return;
    }
    case "execution_error": {
      const err: ComfyExecutionError = {
        promptId: String(data["prompt_id"] ?? ""),
        nodeId: String(data["node_id"] ?? ""),
        nodeType: String(data["node_type"] ?? ""),
        exceptionType: String(data["exception_type"] ?? ""),
        exceptionMessage: String(data["exception_message"] ?? ""),
        traceback: Array.isArray(data["traceback"]) ? (data["traceback"] as string[]) : [],
        currentInputs: data["current_inputs"],
      };
      h.onError?.(err);
      return;
    }
  }
}

function previewPayload(msg: ComfyMessage): string {
  const json = JSON.stringify(msg.data ?? {});
  return json.length > 300 ? json.slice(0, 300) + "…" : json;
}

function httpToWs(url: string): string {
  return url.replace(/^http:\/\//, "ws://").replace(/^https:\/\//, "wss://").replace(/\/+$/, "");
}

const cache = new Map<string, ComfyWsClient>();

// Prefix for generated ComfyUI client IDs. Consumers may brand it (e.g.
// "orson", "starfall"); defaults to "comfy". Set this BEFORE the first
// getComfyWs() call for a given baseUrl, since the id is fixed at construction.
let clientIdPrefix = "comfy";

export function setComfyClientIdPrefix(prefix: string): void {
  clientIdPrefix = prefix;
}

export function getComfyWs(baseUrl: string): ComfyWsClient {
  const key = baseUrl.replace(/\/+$/, "");
  let client = cache.get(key);
  if (!client) {
    client = new ComfyWsImpl(key);
    cache.set(key, client);
  }
  return client;
}
