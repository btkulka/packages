import { applyChat, applyChats, applyStream } from "../patch.js";
import type { ChatPatch, ChatsPatch, ChatsState, ChatStreamDelta, ClaudeTransport } from "../types.js";

// @btkulka/claude-kit/client: the browser side without React. httpTransport
// talks to ../http; createClaudeStore keeps the chats as the host's changes
// come in (any transport), for the React screens or a page of its own.

/** A transport over ../http's routes, under `base` ("/claude", or a full address). */
export function httpTransport(base = "/claude"): ClaudeTransport {
  const root = base.replace(/\/+$/, "");
  const rpc = async (method: string, ...args: unknown[]) => {
    const res = await fetch(`${root}/rpc`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ method, args }) });
    const body = (await res.json().catch(() => ({ ok: false, error: `${res.status} ${res.statusText}` }))) as { ok: boolean; value?: unknown; error?: string };
    if (!body.ok) throw new Error(body.error ?? "Claude didn't answer.");
    return body.value as never;
  };

  // One event stream for every listener, opened with the first and closed with the last.
  type Kind = "chats" | "chat" | "stream" | "reconnect";
  const listeners: Record<Kind, Set<(p: never) => void>> = { chats: new Set(), chat: new Set(), stream: new Set(), reconnect: new Set() };
  let source: EventSource | undefined;
  let dropped = false;
  const total = () => listeners.chats.size + listeners.chat.size + listeners.stream.size + listeners.reconnect.size;
  const open = () => {
    if (source) return;
    source = new EventSource(`${root}/events`);
    for (const kind of ["chats", "chat", "stream"] as const)
      source.addEventListener(kind, (e) => {
        const payload = JSON.parse((e as MessageEvent<string>).data) as never;
        for (const cb of listeners[kind]) cb(payload);
      });
    source.addEventListener("error", () => void (dropped = true));
    source.addEventListener("open", () => {
      // Back after a drop: changes may have gone by, so the screens read everything again.
      if (!dropped) return;
      dropped = false;
      for (const cb of listeners.reconnect) (cb as () => void)();
    });
  };
  const on =
    <T>(kind: Kind) =>
    (cb: (p: T) => void) => {
      listeners[kind].add(cb as (p: never) => void);
      open();
      return () => {
        listeners[kind].delete(cb as (p: never) => void);
        if (!total()) {
          source?.close();
          source = undefined;
        }
      };
    };

  return {
    state: () => rpc("state"),
    start: (chat) => rpc("start", chat),
    seen: (chats) => rpc("seen", chats),
    send: (text, chat, images) => rpc("send", text, chat, images),
    image: async (ref, folder, thumb) => {
      const q = new URLSearchParams({ ref, ...(folder ? { folder } : {}), ...(thumb ? { thumb } : {}) });
      const res = await fetch(`${root}/image?${q}`);
      if (!res.ok) {
        const body = (await res.json().catch(() => undefined)) as { error?: string } | undefined;
        throw new Error(body?.error ?? `That image didn't load (${res.status}).`);
      }
      const name = decodeURIComponent(/filename="([^"]*)"/.exec(res.headers.get("content-disposition") ?? "")?.[1] ?? "image");
      return { bytes: new Uint8Array(await res.arrayBuffer()), type: res.headers.get("content-type") ?? "image/png", name };
    },
    stop: (chat) => rpc("stop", chat),
    newChat: (o) => rpc("newChat", o),
    select: (chat) => rpc("select", chat),
    close: (chat) => rpc("close", chat),
    answer: (id, decision) => rpc("answer", id, decision),
    terminal: (chat) => rpc("terminal", chat),
    configure: (chat, o) => rpc("configure", chat, o),
    past: (query, limit) => rpc("past", query, limit),
    load: (sessionId) => rpc("load", sessionId),
    onList: on<ChatsPatch>("chats"),
    onChange: on<ChatPatch>("chat"),
    onStream: on<ChatStreamDelta>("stream"),
    onReconnect: on<void>("reconnect") as (cb: () => void) => () => void,
  };
}

/** What the screens draw from. */
export interface ClaudeSnapshot {
  /** Every chat, once the host has answered. */
  chats?: ChatsState;
  /** The replies being written, by chat id. */
  streams: Record<string, string>;
  /** Past chats is showing in place of the chat. */
  past: boolean;
}

/** The chats as the screens see them. An app that keeps them in its own store (Benhäus) hands the screens an adapter of this shape instead. */
export interface ClaudeStore {
  getState(): ClaudeSnapshot;
  subscribe(cb: () => void): () => void;
  setPast(on: boolean): void;
}

/**
 * A store fed by a transport: while anything listens it reads every chat, then
 * applies the host's changes as they come (../patch.ts). It lets go of the
 * transport when the last listener does, and reads everything again when one
 * comes back, so React's mount, unmount and mount again in development is fine.
 */
export function createClaudeStore(transport: ClaudeTransport): ClaudeStore {
  let snap: ClaudeSnapshot = { streams: {}, past: false };
  const subs = new Set<() => void>();
  let offs: (() => void)[] = [];
  const set = (patch: Partial<ClaudeSnapshot>) => {
    snap = { ...snap, ...patch };
    subs.forEach((cb) => cb());
  };
  const setChats = ({ streams, ...chats }: ChatsState) => set(streams ? { chats, streams } : { chats });
  const reread = () => void transport.state().then(setChats, () => undefined);

  const listen = () => [
    // A change naming a chat this screen never had reads them all again.
    transport.onList((p) => {
      const chats = applyChats(snap.chats, p);
      if (chats) set({ chats });
      else reread();
    }),
    // A chat that's gone by the time its change arrives stays gone.
    transport.onChange((p) => snap.chats && set({ chats: { ...snap.chats, chats: snap.chats.chats.map((c) => (c.id === p.id ? applyChat(c, p) : c)) } })),
    // A delta past what this screen has (it missed one) waits for the reply to land, or for the next full read.
    transport.onStream((d) => {
      const text = applyStream(snap.streams[d.id], d);
      if (text !== undefined) set({ streams: { ...snap.streams, [d.id]: text } });
    }),
    ...(transport.onReconnect ? [transport.onReconnect(reread)] : []),
  ];

  return {
    getState: () => snap,
    subscribe: (cb) => {
      subs.add(cb);
      if (subs.size === 1) {
        offs = listen();
        reread();
      }
      return () => {
        if (!subs.delete(cb) || subs.size) return;
        offs.forEach((off) => off());
        offs = [];
      };
    },
    setPast: (on) => void (snap.past !== on && set({ past: on })),
  };
}

export type { ClaudeTransport } from "../types.js";
