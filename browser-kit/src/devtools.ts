// Finding a Chrome that is listening for DevTools: its HTTP endpoint answers /json/version with the browser's
// WebSocket URL. Everything goes through a fetch the caller can replace, so a test never reaches a browser.

export interface FetchLikeResponse {
  ok: boolean;
  status: number;
  text(): Promise<string>;
}

export type FetchLike = (url: string, init?: { signal?: AbortSignal }) => Promise<FetchLikeResponse>;

export interface DevToolsInfo {
  /** The endpoint asked, without a trailing slash: http://127.0.0.1:9222. */
  endpoint: string;
  /** The browser's WebSocket URL, for connectCdp. */
  wsUrl: string;
  /** "Chrome/142.0.7444.60" and the like. */
  browser: string;
  userAgent: string;
  protocolVersion: string;
}

export const DEFAULT_DEVTOOLS_PORT = 9222;

/** `9333` → `http://127.0.0.1:9333`; a URL is returned without its trailing slashes. */
export function devToolsEndpoint(portOrUrl: number | string = DEFAULT_DEVTOOLS_PORT, host = "127.0.0.1"): string {
  if (typeof portOrUrl === "number" || /^\d+$/.test(String(portOrUrl))) return `http://${host}:${Number(portOrUrl)}`;
  return String(portOrUrl).replace(/\/+$/, "");
}

export interface DiscoverOptions {
  fetch?: FetchLike;
  /** How long to wait for the answer. Default 2000. */
  timeoutMs?: number;
}

/** Is a DevTools endpoint answering there? Its browser WebSocket URL and version, or null. Never throws. */
export async function discoverDevTools(endpoint: string | number, opts: DiscoverOptions = {}): Promise<DevToolsInfo | null> {
  const base = devToolsEndpoint(endpoint);
  const fetchImpl = opts.fetch ?? (globalThis.fetch as unknown as FetchLike | undefined);
  if (!fetchImpl) return null;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), opts.timeoutMs ?? 2000);
  try {
    const res = await fetchImpl(`${base}/json/version`, { signal: ac.signal });
    if (!res.ok) return null;
    const j = JSON.parse(await res.text()) as Record<string, unknown> | null;
    if (!j || typeof j.webSocketDebuggerUrl !== "string") return null;
    return {
      endpoint: base,
      wsUrl: j.webSocketDebuggerUrl,
      browser: String(j.Browser ?? ""),
      userAgent: String(j["User-Agent"] ?? ""),
      protocolVersion: String(j["Protocol-Version"] ?? ""),
    };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export interface WaitForDevToolsOptions extends DiscoverOptions {
  /** Give up after this long. Default 15000. */
  waitMs?: number;
  /** Between looks. Default 250. */
  intervalMs?: number;
  signal?: AbortSignal;
}

/** Poll until the endpoint answers; its info, or null once `waitMs` has passed. */
export async function waitForDevTools(endpoint: string | number, opts: WaitForDevToolsOptions = {}): Promise<DevToolsInfo | null> {
  const deadline = Date.now() + (opts.waitMs ?? 15_000);
  const interval = opts.intervalMs ?? 250;
  for (;;) {
    if (opts.signal?.aborted) return null;
    const found = await discoverDevTools(endpoint, { fetch: opts.fetch, timeoutMs: Math.min(opts.timeoutMs ?? 2000, Math.max(250, deadline - Date.now())) });
    if (found) return found;
    if (Date.now() + interval > deadline) return null;
    await new Promise((r) => setTimeout(r, interval));
  }
}
