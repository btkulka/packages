// The smallest DevTools-protocol client that does the job: one WebSocket to the browser, commands that resolve
// with their result, events to listen to, and flat sessions (Target.attachToTarget with flatten) so one
// connection drives any number of tabs. Node 22's global WebSocket is used unless one is passed in.

/** A protocol event as it arrives: the method, its params, and the session it belongs to (none for the browser). */
export interface CdpEvent<P = any> {
  method: string;
  params: P;
  sessionId?: string;
}

export type CdpListener = (event: CdpEvent) => void;

/**
 * What the helpers here need from a connection. `connectCdp` returns one; so does a test fake that answers
 * `send` and calls its listeners. `on` with one function hears every event, for every session.
 */
export interface CdpTransport {
  send<T = any>(method: string, params?: object, sessionId?: string): Promise<T>;
  on(listener: CdpListener): (() => void) | void;
}

export interface CdpOnceOptions<P = any> {
  /** Only this session's event. */
  sessionId?: string;
  /** Reject after this long (no timeout when 0 or absent). */
  timeoutMs?: number;
  /** Only an event whose params pass. */
  filter?: (params: P) => boolean;
}

export interface CdpConnection extends CdpTransport {
  readonly url: string;
  /** Resolves when the socket is open; rejects when it could not open. */
  readonly open: Promise<void>;
  /** Resolves when the socket has closed. */
  readonly closed: Promise<void>;
  readonly isClosed: boolean;
  on(listener: CdpListener): () => void;
  on<P = any>(method: string, listener: (params: P, event: CdpEvent<P>) => void, sessionId?: string): () => void;
  once<P = any>(method: string, opts?: CdpOnceOptions<P>): Promise<P>;
  /** A handle on a session already attached (flat mode). */
  session(sessionId: string, targetId?: string): CdpSession;
  close(): void;
}

/** One attached target (a tab, usually): its commands and events, with the sessionId filled in. */
export interface CdpSession {
  readonly sessionId: string;
  readonly targetId?: string;
  readonly transport: CdpTransport;
  send<T = any>(method: string, params?: object): Promise<T>;
  on<P = any>(method: string, listener: (params: P, event: CdpEvent<P>) => void): () => void;
  once<P = any>(method: string, opts?: Omit<CdpOnceOptions<P>, "sessionId">): Promise<P>;
}

/** The members of a WebSocket the client uses: Node 22's global one, the `ws` package and browsers all fit. */
export interface WebSocketLike {
  onopen: ((ev: any) => void) | null;
  onerror: ((ev: any) => void) | null;
  onclose: ((ev: any) => void) | null;
  onmessage: ((ev: { data: any }) => void) | null;
  send(data: string): void;
  close(): void;
}

export type WebSocketCtor = new (url: string) => WebSocketLike;

export interface ConnectCdpOptions {
  /** The WebSocket class. Defaults to the global one (Node 22 and up). */
  WebSocket?: WebSocketCtor;
  /** Reject a command that gets no answer in this long. 0 (the default) waits for ever, or until the socket closes. */
  commandTimeoutMs?: number;
}

/** A command the browser answered with an error. */
export class CdpError extends Error {
  readonly code?: number;
  readonly method: string;
  readonly data?: string;
  constructor(method: string, error: { message?: string; code?: number; data?: string }) {
    super(error.message || `DevTools command ${method} failed.`);
    this.name = "CdpError";
    this.method = method;
    this.code = error.code;
    this.data = error.data;
  }
}

function addListener(t: CdpTransport, fn: CdpListener): () => void {
  let active = true;
  const off = t.on((ev) => {
    if (active) fn(ev);
  });
  return () => {
    active = false;
    if (typeof off === "function") off();
  };
}

/** Listen to one method on any transport (a real connection or a fake), optionally for one session. */
export function onEvent<P = any>(t: CdpTransport, method: string, listener: (params: P, event: CdpEvent<P>) => void, sessionId?: string): () => void {
  return addListener(t, (ev) => {
    if (ev.method !== method) return;
    if (sessionId !== undefined && ev.sessionId !== sessionId) return;
    listener(ev.params as P, ev as CdpEvent<P>);
  });
}

/** The next event of one method on any transport. */
export function onceEvent<P = any>(t: CdpTransport, method: string, opts: CdpOnceOptions<P> = {}): Promise<P> {
  return new Promise<P>((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const off = onEvent<P>(
      t,
      method,
      (params) => {
        if (opts.filter && !opts.filter(params)) return;
        off();
        if (timer) clearTimeout(timer);
        resolve(params);
      },
      opts.sessionId,
    );
    if (opts.timeoutMs && opts.timeoutMs > 0) {
      timer = setTimeout(() => {
        off();
        reject(new Error(`No ${method} within ${opts.timeoutMs}ms.`));
      }, opts.timeoutMs);
    }
  });
}

/** A session handle over any transport: commands carry the sessionId, events are filtered to it. */
export function sessionOf(t: CdpTransport, sessionId: string, targetId?: string): CdpSession {
  return {
    sessionId,
    targetId,
    transport: t,
    send: (method, params = {}) => t.send(method, params, sessionId),
    on: (method, listener) => onEvent(t, method, listener, sessionId),
    once: (method, opts = {}) => onceEvent(t, method, { ...opts, sessionId }),
  };
}

/** Open a DevTools connection to a browser (or page) WebSocket URL, as `/json/version` reports it. */
export function connectCdp(wsUrl: string, opts: ConnectCdpOptions = {}): CdpConnection {
  const WS = opts.WebSocket ?? ((globalThis as { WebSocket?: WebSocketCtor }).WebSocket as WebSocketCtor | undefined);
  if (!WS) throw new Error("This Node has no built-in WebSocket; Node 22 or newer is needed, or pass a WebSocket class.");
  const ws = new WS(wsUrl);
  let seq = 0;
  let isClosed = false;
  const pending = new Map<number, { method: string; resolve: (v: any) => void; reject: (e: Error) => void; timer?: ReturnType<typeof setTimeout> }>();
  const listeners = new Set<CdpListener>();
  let markClosed!: () => void;
  const closed = new Promise<void>((r) => (markClosed = r));

  const open = new Promise<void>((resolve, reject) => {
    ws.onopen = () => resolve();
    ws.onerror = () => reject(new Error(`Could not open the DevTools connection at ${wsUrl}.`));
  });
  // A caller that never awaits `open` must not see an unhandled rejection; one that does still gets it.
  open.catch(() => {});

  ws.onmessage = (ev) => {
    let m: { id?: number; method?: string; params?: unknown; sessionId?: string; result?: unknown; error?: { message?: string; code?: number; data?: string } };
    try {
      m = JSON.parse(typeof ev.data === "string" ? ev.data : String(ev.data));
    } catch {
      return;
    }
    if (m.id !== undefined && pending.has(m.id)) {
      const p = pending.get(m.id)!;
      pending.delete(m.id);
      if (p.timer) clearTimeout(p.timer);
      if (m.error) p.reject(new CdpError(p.method, m.error));
      else p.resolve(m.result ?? {});
    } else if (m.method) {
      const event: CdpEvent = { method: m.method, params: m.params ?? {}, sessionId: m.sessionId };
      for (const l of [...listeners]) {
        try {
          l(event);
        } catch {
          /* one listener's error is its own */
        }
      }
    }
  };
  ws.onclose = () => {
    isClosed = true;
    for (const p of pending.values()) {
      if (p.timer) clearTimeout(p.timer);
      p.reject(new Error("The DevTools connection closed."));
    }
    pending.clear();
    markClosed();
  };

  const conn: CdpConnection = {
    url: wsUrl,
    open,
    closed,
    get isClosed() {
      return isClosed;
    },
    send<T = any>(method: string, params: object = {}, sessionId?: string): Promise<T> {
      if (isClosed) return Promise.reject(new Error("The DevTools connection is closed."));
      const id = ++seq;
      return new Promise<T>((resolve, reject) => {
        const entry: { method: string; resolve: (v: any) => void; reject: (e: Error) => void; timer?: ReturnType<typeof setTimeout> } = { method, resolve, reject };
        if (opts.commandTimeoutMs && opts.commandTimeoutMs > 0) {
          entry.timer = setTimeout(() => {
            pending.delete(id);
            reject(new Error(`DevTools command ${method} got no answer within ${opts.commandTimeoutMs}ms.`));
          }, opts.commandTimeoutMs);
        }
        pending.set(id, entry);
        try {
          ws.send(JSON.stringify(sessionId ? { id, method, params, sessionId } : { id, method, params }));
        } catch (e) {
          pending.delete(id);
          if (entry.timer) clearTimeout(entry.timer);
          reject(e instanceof Error ? e : new Error(String(e)));
        }
      });
    },
    on(a: CdpListener | string, b?: (params: any, event: CdpEvent) => void, sessionId?: string): () => void {
      if (typeof a === "function") {
        listeners.add(a);
        return () => listeners.delete(a);
      }
      return onEvent(conn, a, b!, sessionId);
    },
    once: (method, o) => onceEvent(conn, method, o),
    session: (sessionId, targetId) => sessionOf(conn, sessionId, targetId),
    close() {
      try {
        ws.close();
      } catch {
        /* already closed */
      }
    },
  } as CdpConnection;
  return conn;
}

/** Attach to a target in flat mode and return its session. */
export async function attachToTarget(t: CdpTransport, targetId: string): Promise<CdpSession> {
  const { sessionId } = await t.send<{ sessionId: string }>("Target.attachToTarget", { targetId, flatten: true });
  return sessionOf(t, sessionId, targetId);
}

export interface OpenTabOptions {
  /** What the tab opens on. Default about:blank, so recording can start before the real page's first request. */
  url?: string;
  /** Open it without bringing it forward (the page then gets no animation frames, which some apps need). */
  background?: boolean;
  /** In a new window rather than a tab. */
  newWindow?: boolean;
}

export interface CdpTab {
  readonly targetId: string;
  readonly session: CdpSession;
  /** Close the tab. Never throws. */
  close(): Promise<void>;
}

/** Open a new tab and attach to it. `close()` closes the tab (the connection stays open). */
export async function openTab(t: CdpTransport, opts: OpenTabOptions = {}): Promise<CdpTab> {
  const params: Record<string, unknown> = { url: opts.url ?? "about:blank" };
  if (opts.background) params.background = true;
  if (opts.newWindow) params.newWindow = true;
  const { targetId } = await t.send<{ targetId: string }>("Target.createTarget", params);
  let session: CdpSession;
  try {
    session = await attachToTarget(t, targetId);
  } catch (e) {
    await t.send("Target.closeTarget", { targetId }).catch(() => {});
    throw e;
  }
  let closed = false;
  return {
    targetId,
    session,
    async close() {
      if (closed) return;
      closed = true;
      await t.send("Target.closeTarget", { targetId }).catch(() => {});
    },
  };
}

export interface TargetInfo {
  targetId: string;
  type: string;
  title: string;
  url: string;
  attached?: boolean;
  browserContextId?: string;
}

/** Every target the browser has (tabs, workers, extensions); filter on `type === "page"` for tabs. */
export async function listTargets(t: CdpTransport): Promise<TargetInfo[]> {
  const { targetInfos } = await t.send<{ targetInfos: TargetInfo[] }>("Target.getTargets");
  return targetInfos ?? [];
}

/** Run an expression in a page and return its value; what the page throws comes back as an Error. */
export async function evaluate<T = unknown>(s: Pick<CdpSession, "send">, expression: string, opts: { awaitPromise?: boolean; returnByValue?: boolean } = {}): Promise<T> {
  const r = await s.send<{ result?: { value?: unknown }; exceptionDetails?: { text?: string; exception?: { description?: string } } }>("Runtime.evaluate", {
    expression,
    returnByValue: opts.returnByValue ?? true,
    awaitPromise: opts.awaitPromise ?? true,
  });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text || "The page threw.");
  return r.result?.value as T;
}
