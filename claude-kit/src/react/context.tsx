import { createContext, useContext, useEffect, useMemo, useState, useSyncExternalStore, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { createClaudeStore, type ClaudeSnapshot, type ClaudeStore } from "../client/index.js";
import type { ChatState, ClaudeMode, ClaudeTransport } from "../types.js";
import { relTime, showPath } from "../words.js";
import { builtIns, type Components, type MenuItem } from "./primitives.js";

// What every screen shares: the transport to the host, the store of chats,
// and the app's say over how things look and what clicks do (`ui`).

/** Where a chat is drawn: the panel or drawer, a page or tab of its own, or that popped out into a window of its own. */
export type Where = "panel" | "tab" | "window";

export interface ClaudeUi {
  /** The app's own Button, Tooltip, Menu, SegmentedControl and SearchField, with the built-ins' props. */
  components: Partial<Components>;
  /** A short message: copied, saved, what went wrong. Default: the provider's own toast. */
  toast(message: string): void;
  /** A link in a reply. Default: a new browser tab. */
  openLink(href: string): void;
  /** A file path in a reply's code (D:\x\y.ts:12): given this, the path is a button that calls it. */
  openPath?(file: string, line?: number): void;
  copy(text: string): Promise<void>;
  /** A touch screen: Enter is a new line, the mode is one chip, nothing grabs focus. */
  phone: boolean;
  /** Claude Code isn't signed in: given this, the chat offers Sign in. */
  signIn?(): Promise<unknown>;
  /** A chat's mode or model was picked. Default: that chat's (configure), which new chats then take. */
  setMode?(chat: ChatState, mode: ClaudeMode, where: Where): void;
  setModel?(chat: ChatState, model: string, where: Where): void;
  /** The ⋯ menu: given the package's items, the ones to show. */
  menu?(items: MenuItem[], chat: ChatState, where: Where): MenuItem[];
  /** One of the app's own menu items was picked. */
  onMenu?(item: MenuItem, chat: ChatState, where: Where): void;
  /** Buttons of the app's in a chat's header, before ⋯. */
  headerActions?(chat: ChatState, where: Where): ReactNode;
  /** A path as the app shows paths. */
  showPath(path: string): string;
  relTime(iso: string): string;
  /** An error as a sentence. */
  errorText(e: unknown): string;
  /** The header's name: "Claude". */
  title: string;
  /** Said under the empty chat's first line, after where it works. */
  emptyNote?: string;
  /** Where Past chats come from, for its caption: "on this machine". */
  machine: string;
  /** Where menus, the lightbox and toasts go: document.body (the element passes its shadow root's). */
  portal(): HTMLElement;
}

interface Ctx {
  transport: ClaudeTransport;
  store: ClaudeStore;
  ui: ClaudeUi & { c: Components };
}

const ClaudeContext = createContext<Ctx | null>(null);

function useCtx(): Ctx {
  const c = useContext(ClaudeContext);
  if (!c) throw new Error("Claude's screens need a <ClaudeProvider> around them.");
  return c;
}

export const useTransport = () => useCtx().transport;
export const useUi = () => useCtx().ui;
export const useStore = () => useCtx().store;

/** Part of the chats, drawn again only when it changes (return something that keeps its identity: a chat, a string). */
export function useClaude<T>(pick: (s: ClaudeSnapshot) => T): T {
  const store = useCtx().store;
  return useSyncExternalStore(store.subscribe, () => pick(store.getState()), () => pick(store.getState()));
}

/* ---------------------------------------------------------------- toasts */

type Toast = { id: number; text: string };
const toastSubs = new Set<(t: Toast[]) => void>();
let toasts: Toast[] = [];
let toastSeq = 0;

/** The provider's own toast, for apps that don't pass `ui.toast`. */
export function claudeToast(text: string) {
  const t = { id: ++toastSeq, text };
  toasts = [...toasts, t].slice(-3);
  toastSubs.forEach((cb) => cb(toasts));
  setTimeout(() => {
    toasts = toasts.filter((x) => x !== t);
    toastSubs.forEach((cb) => cb(toasts));
  }, 3200);
}

function Toasts({ portal }: { portal: () => HTMLElement }) {
  const [list, setList] = useState<Toast[]>(toasts);
  useEffect(() => {
    toastSubs.add(setList);
    return () => void toastSubs.delete(setList);
  }, []);
  if (!list.length) return null;
  return createPortal(
    <div className="ck-root ck-toasts" role="status" aria-live="polite">
      {list.map((t) => (
        <div key={t.id} className="ck-toast">
          {t.text}
        </div>
      ))}
    </div>,
    portal(),
  );
}

/* -------------------------------------------------------------- provider */

const errorText = (e: unknown) => {
  const m = e instanceof Error ? e.message : String(e ?? "Something went wrong.");
  // Electron wraps a main-process error: "Error invoking remote method 'x': Error: the words".
  return m.replace(/^Error invoking remote method '[^']+': (?:\w*Error: )?/, "");
};

const defaults: Omit<ClaudeUi, "components"> = {
  toast: claudeToast,
  openLink: (href) => void window.open(href, "_blank", "noopener,noreferrer"),
  copy: (text) => navigator.clipboard.writeText(text),
  phone: false,
  showPath,
  relTime: (iso) => relTime(iso),
  errorText,
  title: "Claude",
  machine: "on this machine",
  portal: () => document.body,
};

/**
 * Claude's screens, on a transport: the Electron bridge (window.claude from
 * claudeBridge), httpTransport("/claude"), or Benhäus's window.benhaus.chat.
 * `store` is for an app that keeps the chats in its own store already.
 */
export function ClaudeProvider({ transport, store, ui, children }: { transport: ClaudeTransport; store?: ClaudeStore; ui?: Partial<ClaudeUi>; children: ReactNode }) {
  const own = useMemo(() => store ?? createClaudeStore(transport), [transport, store]);
  const merged = useMemo(() => {
    const u = { ...defaults, ...ui, components: ui?.components ?? {} } as ClaudeUi;
    return { ...u, c: { ...builtIns, ...u.components } };
  }, [ui]);
  const value = useMemo(() => ({ transport, store: own, ui: merged }), [transport, own, merged]);
  return (
    <ClaudeContext.Provider value={value}>
      {children}
      {!ui?.toast && <Toasts portal={merged.portal} />}
    </ClaudeContext.Provider>
  );
}
