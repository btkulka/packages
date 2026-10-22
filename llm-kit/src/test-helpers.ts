/** Fakes shared by the tests. Not exported from the package. */
import type { FetchLike } from "./http.js";

export interface Sent {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: Record<string, unknown> | undefined;
}

/** A fetch that records each request and answers with whatever `reply` returns for it. */
export function fakeFetch(reply: (req: Sent, n: number) => Response | Promise<Response>): FetchLike & { sent: Sent[] } {
  const sent: Sent[] = [];
  const f = (async (url: string, init?: RequestInit) => {
    const req: Sent = {
      url,
      method: init?.method ?? "GET",
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : undefined,
    };
    sent.push(req);
    return reply(req, sent.length - 1);
  }) as FetchLike & { sent: Sent[] };
  f.sent = sent;
  return f;
}

export const json = (v: unknown, status = 200): Response => new Response(JSON.stringify(v), { status, headers: { "Content-Type": "application/json" } });

/** A body streamed in exactly these chunks (to split lines and UTF-8 characters where we like). */
export function chunked(chunks: (string | Uint8Array)[], status = 200): Response {
  const enc = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      for (const ch of chunks) c.enqueue(typeof ch === "string" ? enc.encode(ch) : ch);
      c.close();
    },
  });
  return new Response(stream, { status });
}

/** A fetch that never answers until its signal aborts, like a real one to a stalled server. */
export const hangingFetch: FetchLike = (_url, init) =>
  new Promise((_resolve, reject) => {
    init?.signal?.addEventListener("abort", () => reject(new DOMException("This operation was aborted", "AbortError")));
  });
