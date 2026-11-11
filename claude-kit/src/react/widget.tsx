import { useEffect, useRef, useState } from "react";
import type { NewChatOptions } from "../types.js";
import { chatsSignal, chatsWord } from "../words.js";
import { useClaude, useStore, useTransport, useUi } from "./context.js";
import { ClaudePanel } from "./panel.js";
import { ClaudeMark } from "./primitives.js";

// Plug and play: a floating button in the corner and the panel it opens, as a
// drawer from the window's edge or a card above the button. askClaude() opens
// it from anywhere in the app, on a new chat that already knows what it's about.

const OPEN_EVENT = "claude-kit:open";

/**
 * Opens the widget. With options it starts a new chat: `text` its first
 * message, `context` what Claude is told ahead of it without it being shown
 * (the record on screen, say), `about` what it's about ("Ask about …").
 */
export function askClaude(o?: NewChatOptions | false) {
  window.dispatchEvent(new CustomEvent(OPEN_EVENT, { detail: o }));
}

/** The corner button: Claude's mark, with a dot while a chat works or waits for an answer. */
export function ClaudeFab({ open, onClick, label }: { open?: boolean; onClick: () => void; label?: string }) {
  const ui = useUi();
  const list = useClaude((s) => s.chats);
  const signal = chatsSignal(list);
  const word = label ?? chatsWord(list, `${ui.title}: ask anything, or ask for code`);
  return (
    <button type="button" className={`ck-root ck-fab${open ? " is-open" : ""}${signal ? ` is-${signal}` : ""}`} aria-label={word} title={word} aria-expanded={open} data-ck-fab="" onClick={onClick}>
      <ClaudeMark size={26} />
      {signal && <span className={`ck-fab__dot is-${signal}`} />}
    </button>
  );
}

/**
 * The panel in a drawer from the window's right edge (`variant` "drawer") or
 * a card above the corner button ("float"). A click anywhere else, or Esc in
 * an idle chat, closes it; menus, the lightbox and the button don't.
 */
export function ClaudeDrawer({ open, onClose, variant = "drawer", width }: { open: boolean; onClose: () => void; variant?: "drawer" | "float"; width?: number }) {
  const box = useRef<HTMLDivElement>(null);
  const done = useRef(onClose);
  done.current = onClose;

  useEffect(() => {
    if (!open) return;
    const away = (e: PointerEvent) => {
      const t = (e.composedPath?.()[0] ?? e.target) as Element | null;
      if (!t?.closest) return;
      if (box.current?.contains(t) || t.closest("[data-ck-menu], [data-bh-menu], [data-ck-fab], .ck-lightbox, .ck-toasts")) return;
      done.current();
    };
    // An image dropped just outside the panel would load in place of the app; it's ignored instead.
    const missed = (e: DragEvent) => e.dataTransfer?.types.includes("Files") && e.preventDefault();
    document.addEventListener("pointerdown", away, true);
    document.addEventListener("dragover", missed);
    document.addEventListener("drop", missed);
    return () => {
      document.removeEventListener("pointerdown", away, true);
      document.removeEventListener("dragover", missed);
      document.removeEventListener("drop", missed);
    };
  }, [open]);

  if (!open) return null;
  return (
    <div ref={box} className={`ck-root ck-drawer ck-drawer--${variant}`} style={width ? { width } : undefined}>
      <ClaudePanel onHide={onClose} />
    </div>
  );
}

/**
 * The corner button and its drawer, in one: what most apps want. It
 * remembers whether it was open, opens with `hotkey` ("ctrl+shift+k"), and
 * with askClaude() from anywhere.
 */
export function ClaudeWidget({ variant = "drawer", hotkey, width, defaultOpen = false, fab = true }: { variant?: "drawer" | "float"; hotkey?: string; width?: number; defaultOpen?: boolean; fab?: boolean }) {
  const t = useTransport();
  const ui = useUi();
  const store = useStore();
  const [open, setOpenState] = useState(() => {
    try {
      const v = localStorage.getItem("claude-kit:open");
      return v === null ? defaultOpen : v === "1";
    } catch {
      return defaultOpen;
    }
  });
  const setOpen = (on: boolean) => {
    setOpenState(on);
    try {
      localStorage.setItem("claude-kit:open", on ? "1" : "0");
    } catch {
      // Private mode: it just won't be remembered.
    }
  };
  const openRef = useRef(open);
  openRef.current = open;

  useEffect(() => {
    const ask = (e: Event) => {
      const o = (e as CustomEvent<NewChatOptions | false | undefined>).detail;
      if (o === false) return setOpen(false);
      setOpen(true);
      if (o && Object.values(o).some((v) => v)) {
        store.setPast(false);
        void t.newChat(o).catch((err) => ui.toast(ui.errorText(err)));
      }
    };
    window.addEventListener(OPEN_EVENT, ask);
    return () => window.removeEventListener(OPEN_EVENT, ask);
  }, [t, store, ui]);

  useEffect(() => {
    if (!hotkey) return;
    const parts = hotkey.toLowerCase().split("+");
    const key = parts.at(-1);
    const want = { ctrl: parts.includes("ctrl"), shift: parts.includes("shift"), alt: parts.includes("alt"), meta: parts.includes("meta") || parts.includes("cmd") };
    const down = (e: KeyboardEvent) => {
      if (e.key.toLowerCase() !== key || e.ctrlKey !== want.ctrl || e.shiftKey !== want.shift || e.altKey !== want.alt || e.metaKey !== want.meta) return;
      e.preventDefault();
      setOpen(!openRef.current);
    };
    window.addEventListener("keydown", down);
    return () => window.removeEventListener("keydown", down);
  }, [hotkey]);

  return (
    <>
      <ClaudeDrawer open={open} onClose={() => setOpen(false)} variant={variant} width={width} />
      {fab && <ClaudeFab open={open} onClick={() => setOpen(!open)} />}
    </>
  );
}
