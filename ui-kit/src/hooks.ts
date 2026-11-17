import { useCallback, useEffect, useRef, type MutableRefObject, type PointerEvent as ReactPointerEvent, type MouseEvent as ReactMouseEvent, type Ref } from "react";

export function cx(...parts: unknown[]): string {
  return parts.filter((p): p is string => typeof p === "string" && p.length > 0).join(" ");
}

/** A ref that always holds the latest value, for handlers that outlive a render. */
export function useLatest<T>(value: T): MutableRefObject<T> {
  const r = useRef(value);
  r.current = value;
  return r;
}

/** One ref callback that feeds several refs. */
export function mergeRefs<T>(...refs: (Ref<T> | undefined)[]): (node: T | null) => void {
  return (node) => {
    for (const r of refs) {
      if (typeof r === "function") r(node);
      else if (r && typeof r === "object") (r as MutableRefObject<T | null>).current = node;
    }
  };
}

const typing = (t: EventTarget | null): boolean => {
  const el = t as HTMLElement | null;
  if (!el || !el.tagName) return false;
  return el.isContentEditable || el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT";
};

export interface HotkeyOptions {
  enabled?: boolean;
  /** Fire while someone's typing in a field too (off: "/" types a slash). */
  allowInInputs?: boolean;
  /** Fire while a sheet is open (off: the page under a sheet doesn't hear keys). */
  inSheets?: boolean;
}

/**
 * A keyboard shortcut for the whole page: "/", "n", "Escape", "mod+k" (Ctrl or ⌘), "shift+?".
 * Ignored while typing in a field and while a sheet is open, unless asked otherwise.
 */
export function useHotkey(combo: string, handler: (e: KeyboardEvent) => void, o: HotkeyOptions = {}): void {
  const h = useLatest(handler);
  const { enabled = true, allowInInputs = false, inSheets = false } = o;
  useEffect(() => {
    if (!enabled) return;
    const parts = combo.toLowerCase().split("+");
    const key = parts.pop()!;
    const mod = parts.includes("mod");
    const shift = parts.includes("shift");
    const alt = parts.includes("alt");
    const on = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.isComposing || e.repeat) return;
      if (!allowInInputs && typing(e.target)) return;
      if (!inSheets && document.body.classList.contains("ui-sheet-open")) return;
      if (e.key.toLowerCase() !== key) return;
      if (mod !== (e.ctrlKey || e.metaKey) || alt !== e.altKey) return;
      if (shift && !e.shiftKey) return;
      e.preventDefault();
      h.current(e);
    };
    window.addEventListener("keydown", on);
    return () => window.removeEventListener("keydown", on);
  }, [combo, enabled, allowInInputs, inSheets, h]);
}

export interface RepeatHandlers {
  onPointerDown: (e: ReactPointerEvent<HTMLElement>) => void;
  onPointerUp: () => void;
  onPointerLeave: () => void;
  onPointerCancel: () => void;
  onClick: (e: ReactMouseEvent<HTMLElement>) => void;
  onContextMenu: (e: ReactMouseEvent<HTMLElement>) => void;
}

/**
 * Press-and-hold that repeats, faster the longer it's held: once on press, again after 400ms,
 * then every 140ms speeding to 40ms. Keyboard activation (Enter, Space) steps once.
 */
export function useRepeat(step: () => void, o: { delay?: number; interval?: number; fastest?: number; disabled?: boolean } = {}): RepeatHandlers {
  const fn = useLatest(step);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pressed = useRef(false);
  const { delay = 400, interval = 140, fastest = 40, disabled = false } = o;
  const stop = useCallback(() => {
    pressed.current = false;
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
  }, []);
  useEffect(() => stop, [stop]);
  return {
    onPointerDown: (e) => {
      if (disabled || (e.pointerType === "mouse" && e.button !== 0)) return;
      pressed.current = true;
      fn.current();
      let wait = interval;
      const again = () => {
        if (!pressed.current) return;
        fn.current();
        wait = Math.max(fastest, wait * 0.85);
        timer.current = setTimeout(again, wait);
      };
      timer.current = setTimeout(again, delay);
    },
    onPointerUp: stop,
    onPointerLeave: stop,
    onPointerCancel: stop,
    // A pointer press already stepped; a click with no pointer (detail 0) is the keyboard.
    onClick: (e) => {
      if (!disabled && e.detail === 0) fn.current();
    },
    // A long press on a phone would open the context menu.
    onContextMenu: (e) => e.preventDefault(),
  };
}

/** Calls back with the element's size whenever it changes. */
export function useResize(ref: { current: Element | null }, onResize: () => void): void {
  const cb = useLatest(onResize);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => cb.current());
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref, cb]);
}
