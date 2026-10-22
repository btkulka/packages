// In-memory ring buffer of every Comfy HTTP + websocket frame, plus a
// tracedFetch() wrapper that both REST clients route through.
//
// Always-on, capped at 500 entries (~150 KB max). Consumers can subscribe()
// to stream entries (e.g. to a dev panel over IPC) — that wiring lives in the
// consuming app, not here.

import { performance } from "node:perf_hooks";
import type { ComfyTag, ComfyTraceEntry } from "./trace-types.js";

export type { ComfyTag, ComfyTraceEntry };

const RING_CAP = 500;
const BODY_PREVIEW_BYTES = 500;

type ComfyTraceInput = DistributiveOmit<ComfyTraceEntry, "id" | "ts">;
type DistributiveOmit<T, K extends keyof never> = T extends unknown ? Omit<T, K> : never;

class RingBuffer {
  private entries: ComfyTraceEntry[] = [];
  private nextId = 1;
  private nextReqId = 1;
  private listeners = new Set<(e: ComfyTraceEntry) => void>();

  push(e: ComfyTraceInput): ComfyTraceEntry {
    const full = { ...e, id: this.nextId++, ts: Date.now() } as ComfyTraceEntry;
    this.entries.push(full);
    if (this.entries.length > RING_CAP) {
      this.entries.splice(0, this.entries.length - RING_CAP);
    }
    for (const fn of this.listeners) {
      try {
        fn(full);
      } catch {
        // Listener errors must not break the producer.
      }
    }
    return full;
  }

  reserveReqId(): number {
    return this.nextReqId++;
  }

  snapshot(): ComfyTraceEntry[] {
    return this.entries.slice();
  }

  subscribe(fn: (e: ComfyTraceEntry) => void): () => void {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  }

  clear(): void {
    this.entries = [];
  }
}

export const comfyTrace = new RingBuffer();

function previewText(s: string): string {
  if (s.length <= BODY_PREVIEW_BYTES) return s;
  return s.slice(0, BODY_PREVIEW_BYTES) + `… (+${s.length - BODY_PREVIEW_BYTES}B)`;
}

function bodyToPreview(body: BodyInit | null | undefined): string | undefined {
  if (body == null) return undefined;
  if (typeof body === "string") return previewText(body);
  // FormData / Blob / streams: don't try to read; record presence instead.
  if (body instanceof FormData) return "[FormData]";
  if (typeof Blob !== "undefined" && body instanceof Blob) return `[Blob ${body.size}B]`;
  return "[binary]";
}

export interface TracedFetchInit extends Omit<RequestInit, "signal"> {
  tag: ComfyTag;
  /** Defaults to 10_000 ms. Pass Infinity to disable. */
  timeoutMs?: number;
  /** Caller's abort signal — composed with the timeout. */
  signal?: AbortSignal | null;
}

/**
 * Wraps `fetch` so every request, response, and error lands in the trace ring
 * buffer. The returned Response is the live one — body streaming is unaffected.
 */
export async function tracedFetch(url: string, init: TracedFetchInit): Promise<Response> {
  const reqId = comfyTrace.reserveReqId();
  const method = (init.method ?? "GET").toUpperCase();
  const skipBodyPreview = init.tag === "view";
  const bodyPreview = skipBodyPreview ? undefined : bodyToPreview(init.body);

  comfyTrace.push({ kind: "http-req", reqId, tag: init.tag, method, url, bodyPreview });

  const timeoutMs = init.timeoutMs ?? 10_000;
  const ctrl = new AbortController();
  const timer =
    timeoutMs === Infinity
      ? null
      : setTimeout(() => ctrl.abort(new Error(`timeout after ${timeoutMs}ms`)), timeoutMs);

  // Compose caller's signal with our own.
  const callerSignal = init.signal ?? undefined;
  const onCallerAbort = (): void => ctrl.abort(callerSignal?.reason);
  if (callerSignal) {
    if (callerSignal.aborted) ctrl.abort(callerSignal.reason);
    else callerSignal.addEventListener("abort", onCallerAbort, { once: true });
  }

  const start = performance.now();
  try {
    const res = await fetch(url, { ...init, signal: ctrl.signal });
    const durationMs = Math.round(performance.now() - start);
    const lenHeader = res.headers.get("content-length");
    const bytes = lenHeader != null ? Number.parseInt(lenHeader, 10) : undefined;
    let resBodyPreview: string | undefined;
    if (!skipBodyPreview) {
      // Tee a clone so we don't consume the caller's body.
      try {
        const clone = res.clone();
        const text = await clone.text();
        resBodyPreview = previewText(text);
      } catch {
        // Some bodies (already-consumed, locked) can't be cloned/read; skip.
      }
    }
    comfyTrace.push({
      kind: "http-res",
      reqId,
      status: res.status,
      ok: res.ok,
      durationMs,
      bytes: Number.isFinite(bytes) ? bytes : undefined,
      bodyPreview: resBodyPreview,
    });
    return res;
  } catch (err) {
    const durationMs = Math.round(performance.now() - start);
    comfyTrace.push({
      kind: "http-err",
      reqId,
      error: (err as Error).message ?? String(err),
      durationMs,
    });
    throw err;
  } finally {
    if (timer) clearTimeout(timer);
    if (callerSignal) callerSignal.removeEventListener("abort", onCallerAbort);
  }
}
