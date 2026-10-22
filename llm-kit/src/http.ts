/** fetch with a timeout, the caller's AbortSignal, and every failure turned into an LlmError. Internal. */
import { LlmError } from "./errors.js";

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface RequestOptions {
  method?: "GET" | "POST";
  body?: unknown;
  headers?: Record<string, string>;
  timeoutMs?: number;
  signal?: AbortSignal;
  /** Names the server in error messages ("local LLM 500: …"). */
  label: string;
  fetch?: FetchLike;
}

export interface Call {
  res: Response;
  /** Turns an error thrown while reading the body (a timeout mid-stream) into an LlmError. */
  fail(e: unknown): LlmError;
  /** Clears the timeout and detaches from the caller's signal. Call when the body is read. */
  done(): void;
}

/** Sends the request and returns the 2xx response with its body unread. Non-2xx throws an `http` LlmError. */
export async function request(url: string, o: RequestOptions): Promise<Call> {
  if (o.signal?.aborted) throw new LlmError("aborted", `${o.label} request aborted`);
  const ctrl = new AbortController();
  let timedOut = false;
  const timer =
    o.timeoutMs !== undefined && o.timeoutMs > 0
      ? setTimeout(() => {
          timedOut = true;
          ctrl.abort();
        }, o.timeoutMs)
      : undefined;
  const onAbort = () => ctrl.abort();
  o.signal?.addEventListener("abort", onAbort, { once: true });
  const done = () => {
    if (timer) clearTimeout(timer);
    o.signal?.removeEventListener("abort", onAbort);
  };
  const fail = (e: unknown): LlmError => {
    done();
    if (e instanceof LlmError) return e;
    if (timedOut) return new LlmError("timeout", `${o.label} timed out after ${o.timeoutMs}ms`, { cause: e });
    if (o.signal?.aborted) return new LlmError("aborted", `${o.label} request aborted`, { cause: e });
    return new LlmError("unreachable", `${o.label} unreachable: ${String(e)}`, { cause: e });
  };
  let res: Response;
  try {
    const headers: Record<string, string> = { ...o.headers };
    if (o.body !== undefined) headers["Content-Type"] = "application/json";
    res = await (o.fetch ?? fetch)(url, {
      method: o.method ?? (o.body === undefined ? "GET" : "POST"),
      headers,
      body: o.body === undefined ? undefined : JSON.stringify(o.body),
      signal: ctrl.signal,
    });
  } catch (e) {
    throw fail(e);
  }
  if (!res.ok) {
    let body = "";
    try {
      body = await res.text();
    } catch {
      /* the status says enough */
    }
    done();
    throw new LlmError("http", `${o.label} ${res.status}: ${body.slice(0, 200)}`, { status: res.status, body: body.slice(0, 2000) });
  }
  return { res, fail, done };
}

/** request() and read the body as JSON. */
export async function requestJson<T>(url: string, o: RequestOptions): Promise<T> {
  const call = await request(url, o);
  try {
    const text = await call.res.text();
    call.done();
    try {
      return JSON.parse(text) as T;
    } catch (e) {
      throw new LlmError("bad-response", `${o.label} sent a reply that isn't JSON: ${text.slice(0, 200)}`, { cause: e, body: text.slice(0, 2000) });
    }
  } catch (e) {
    throw call.fail(e);
  }
}

/** Reads a newline-delimited body (Ollama's NDJSON), calling `onLine` with each complete, non-blank line. */
export async function readLines(call: Call, onLine: (line: string) => void): Promise<void> {
  const body = call.res.body;
  if (!body) {
    call.done();
    throw new LlmError("bad-response", "the server sent no body to stream");
  }
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let nl: number;
      while ((nl = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (line) onLine(line);
      }
    }
    buffer += decoder.decode();
    if (buffer.trim()) onLine(buffer.trim());
    call.done();
  } catch (e) {
    reader.cancel().catch(() => undefined);
    throw call.fail(e);
  }
}
