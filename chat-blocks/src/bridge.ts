// The page side of an app block: what a ui:// page an app serves uses to talk
// to the chat it's drawn in. connect() does the MCP Apps handshake, puts the
// chat's theme on the page (its --ck-* variables, which frame.css draws with)
// and keeps the chat told of the page's height; the block's props arrive as
// the tool input. answer(value) answers the block: in a claude-kit chat it
// resolves the await_feedback call Claude is waiting on; in a host without this
// package's extension (Claude Desktop) it sends the words as the person's message.
// file(ref) reads a file the block names (or one beside it) as bytes,
// star(refs, on) stars files it names (the chat keeps the star: Benhäus, in Gallery), and
// displayMode("fullscreen") asks the chat to show the page over the whole window.
// A block put up to look at (shown: await_feedback with wait: false) has nothing to answer.
// No imports at run time: the build bundles this as a script that sets
// window.ChatBlocks, for page.ts to inline. swipe(el, { onSwipe }) rides in it too: a lightbox
// page's ← and → by finger, mouse drag or trackpad.

import { APPS_PROTOCOL, BLOCKS_EXT, M, isRpc, type BlocksCapabilities, type FileResult, type HostContext, type InitializeResult, type JsonRpcId, type RpcMessage, type StarResult } from "./app.js";
import type { BlockOutcome } from "./blocks.js";

// A lightbox page steps through its pages by swiping too (window.ChatBlocks.swipe in a blockPage).
export { swipe, type SwipeOptions } from "./swipe.js";

/** How the block ended, as the chat tells the page: answered (here or in the chat's box), or cut short. */
export type Settled = { outcome: BlockOutcome } | { cancelled: string };

/** Where the chat shows the page: in the conversation, or over the whole window. */
export type DisplayMode = "inline" | "fullscreen";

export interface BlockView {
  /** The block's props: the tool input. */
  props: Record<string, unknown>;
  /** What the chat said about itself: theme, size, the block's title. */
  context: HostContext;
  /** The chat waits on answer() (a claude-kit chat). Without it, answer() sends the words as a message. */
  awaited: boolean;
  /** Answers the block with its value; `words` is how the chat says it ("Picked the red one"). */
  answer(value: unknown, words?: string): Promise<void>;
  /** Sends words as the person's message (or, while the block waits, as its answer). */
  message(text: string): Promise<void>;
  /** A chat image (a path, an address, a kept image's id) as an address an <img> draws. */
  image(ref: string): Promise<string>;
  /** A file the block's props name, or one in that file's folder (a model's textures, its .mtl, a set's parts), as bytes. Rejects when the chat can't read files. */
  file(ref: string): Promise<FileResult>;
  /** The chat keeps stars on files (Benhäus's panel: Gallery's star). Without it, star() rejects. */
  canStar: boolean;
  /** Stars (`on` true) or unstars files the block's props name; `on` left out only asks. Resolves with whether each is starred now. */
  star(refs: string[], on?: boolean): Promise<boolean[]>;
  /** Asks the chat to show the page inline or over the whole window; resolves with where it is now ("inline" when the chat can't). */
  displayMode(mode: DisplayMode): Promise<DisplayMode>;
  openLink(url: string): Promise<void>;
  /** The block ended: answered (here or in the chat's box) or cut short. */
  onSettled(cb: (s: Settled) => void): () => void;
  /** The chat's theme or size changed. */
  onContext(cb: (c: HostContext) => void): () => void;
}

export interface ConnectOptions {
  /** The page's name and version, for the chat's logs. */
  name?: string;
  version?: string;
  /** Put the chat's style variables and theme on the page. Default true. */
  theme?: boolean;
  /** Tell the chat the page's height as it changes. Default true. */
  autoResize?: boolean;
  /** Where the page can be shown, told to the chat at the handshake. Default ["inline"]; add "fullscreen" for an expand button. */
  displayModes?: DisplayMode[];
  /** How long to wait for the tool input after the handshake before going on with no props. Default 3 s. */
  inputWaitMs?: number;
}

type Waiting = { resolve: (v: unknown) => void; reject: (e: Error) => void };

/** Connects to the chat the page is drawn in. Resolves once it has the block's props. */
export function connect(o: ConnectOptions = {}): Promise<BlockView> {
  const parent = window.parent;
  if (!parent || parent === window) return Promise.reject(new Error("This page isn't in a chat."));
  let seq = 0;
  const waiting = new Map<JsonRpcId, Waiting>();
  const settledCbs = new Set<(s: Settled) => void>();
  const contextCbs = new Set<(c: HostContext) => void>();
  let context: HostContext = {};
  let props: Record<string, unknown> | undefined;
  let gotInput: (() => void) | undefined;
  let lastSettled: Settled | undefined;

  const post = (m: RpcMessage) => parent.postMessage(m, "*");
  const request = (method: string, params?: unknown) =>
    new Promise<unknown>((resolve, reject) => {
      const id = ++seq;
      waiting.set(id, { resolve, reject });
      post({ jsonrpc: "2.0", id, method, params });
    });
  const notify = (method: string, params?: unknown) => post({ jsonrpc: "2.0", method, params });

  const applyTheme = (c: HostContext) => {
    if (o.theme === false) return;
    const root = document.documentElement;
    for (const [k, v] of Object.entries(c.styles?.variables ?? {})) if (v) root.style.setProperty(k, v);
    if (c.theme) {
      root.dataset.theme = c.theme;
      root.style.colorScheme = c.theme;
    }
    if (c.styles?.css?.fonts && !document.getElementById("cb-fonts")) {
      const s = document.createElement("style");
      s.id = "cb-fonts";
      s.textContent = c.styles.css.fonts;
      document.head.appendChild(s);
    }
  };

  const settle = (s: Settled) => {
    lastSettled = s;
    document.documentElement.dataset.settled = "outcome" in s ? ("answered" in s.outcome ? "answered" : "expired") : "cancelled";
    settledCbs.forEach((cb) => cb(s));
  };

  window.addEventListener("message", (e) => {
    if (e.source !== parent || !isRpc(e.data)) return;
    const m = e.data;
    if ("result" in m || "error" in m) {
      const w = waiting.get(m.id);
      if (!w) return;
      waiting.delete(m.id);
      if ("error" in m) w.reject(new Error(m.error.message));
      else w.resolve(m.result);
      return;
    }
    const params = (m.params ?? {}) as Record<string, unknown>;
    if (m.method === M.toolInput) {
      props = (params.arguments as Record<string, unknown> | undefined) ?? {};
      gotInput?.();
    } else if (m.method === M.toolResult) {
      const structured = params.structuredContent as BlockOutcome | undefined;
      const text = (params.content as { type: string; text?: string }[] | undefined)?.find((b) => b.type === "text")?.text;
      let outcome = structured;
      if (!outcome && text) {
        try {
          outcome = JSON.parse(text) as BlockOutcome;
        } catch {
          outcome = { answered: true, said: text };
        }
      }
      if (outcome) settle({ outcome });
    } else if (m.method === M.toolCancelled) settle({ cancelled: typeof params.reason === "string" ? params.reason : "Cancelled." });
    else if (m.method === M.contextChanged) {
      context = { ...context, ...(params as HostContext) };
      applyTheme(context);
      contextCbs.forEach((cb) => cb(context));
    } else if (m.method === M.teardown && "id" in m) post({ jsonrpc: "2.0", id: m.id, result: {} });
    else if (m.method === M.ping && "id" in m) post({ jsonrpc: "2.0", id: m.id, result: {} });
  });

  const resize = () => {
    const el = document.documentElement;
    notify(M.sizeChanged, { width: Math.ceil(el.scrollWidth), height: Math.ceil(document.body?.scrollHeight ?? el.scrollHeight) });
  };

  return (async () => {
    const init = (await request(M.initialize, {
      protocolVersion: APPS_PROTOCOL,
      appInfo: { name: o.name ?? document.title ?? "block", version: o.version ?? "1.0.0" },
      appCapabilities: { availableDisplayModes: o.displayModes?.length ? o.displayModes : ["inline"] },
    })) as InitializeResult;
    context = init.hostContext ?? {};
    applyTheme(context);
    const caps = (init.hostCapabilities?.experimental as Record<string, BlocksCapabilities> | undefined)?.[BLOCKS_EXT];
    const awaited = Boolean(caps?.answer);
    const canRead = Boolean(caps?.file);
    const canStar = Boolean(caps?.star);
    const input = new Promise<void>((r) => {
      gotInput = r;
      setTimeout(r, o.inputWaitMs ?? 3000);
    });
    notify(M.initialized, {});
    await input;
    if (o.autoResize !== false) {
      const ro = new ResizeObserver(resize);
      ro.observe(document.documentElement);
      if (document.body) ro.observe(document.body);
      resize();
    }
    const say = (text: string) => request(M.message, { role: "user", content: { type: "text", text } }).then(() => undefined);
    const view: BlockView = {
      props: props ?? {},
      get context() {
        return context;
      },
      awaited,
      answer: async (value, words) => {
        if (awaited) await request(M.answer, { value, ...(words ? { text: words } : {}) });
        else await say(words ?? (typeof value === "string" ? value : JSON.stringify(value)));
      },
      message: say,
      image: async (ref) => {
        if (!awaited) return ref;
        const r = (await request(M.image, { ref })) as { url?: string };
        if (!r?.url) throw new Error(`No image ${ref}.`);
        return r.url;
      },
      file: async (ref) => {
        if (!canRead) throw new Error("This chat can't read files.");
        const r = (await request(M.file, { ref })) as FileResult;
        if (!r?.bytes) throw new Error(`No file ${ref}.`);
        return r;
      },
      canStar,
      star: async (refs, on) => {
        if (!canStar) throw new Error("This chat can't keep stars.");
        const r = (await request(M.star, { refs, ...(on === undefined ? {} : { on }) })) as StarResult;
        return refs.map((_, i) => Boolean(r?.starred?.[i]));
      },
      displayMode: async (mode) => {
        try {
          const r = (await request(M.displayMode, { mode })) as { mode?: DisplayMode };
          return r?.mode === "fullscreen" ? "fullscreen" : "inline";
        } catch {
          return "inline";
        }
      },
      openLink: (url) => request(M.openLink, { url }).then(() => undefined),
      onSettled: (cb) => {
        settledCbs.add(cb);
        if (lastSettled) cb(lastSettled);
        return () => void settledCbs.delete(cb);
      },
      onContext: (cb) => {
        contextCbs.add(cb);
        return () => void contextCbs.delete(cb);
      },
    };
    return view;
  })();
}
