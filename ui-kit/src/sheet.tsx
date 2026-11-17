import { useEffect, useLayoutEffect, useRef, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";
import { cx, useLatest } from "./hooks.js";
import { DURATION, EASE, EASE_IN, haptic, motion, reducedMotion, wideLayout } from "./motion.js";

/** Pointer capture, when the browser has that pointer (a synthetic or stale one throws; the drag still works). */
function capture(el: Element, id: number): void {
  try {
    el.setPointerCapture(id);
  } catch {
    /* no such pointer: follow it without capture */
  }
}

// Sheets stack (an item's sheet, then its shelf-life sheet over it): Escape and Tab belong to the
// top one, and the page under them stays still until the last one closes.
const stack: number[] = [];
let nextId = 1;
let locks = 0;

function lockScroll(): void {
  if (locks++ > 0) return;
  const gap = window.innerWidth - document.documentElement.clientWidth;
  document.body.classList.add("ui-sheet-open");
  if (gap > 0) document.body.style.setProperty("--ui-scrollbar-gap", `${gap}px`);
}
function unlockScroll(): void {
  if (--locks > 0) return;
  locks = 0;
  document.body.classList.remove("ui-sheet-open");
  document.body.style.removeProperty("--ui-scrollbar-gap");
}

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
const isField = (el: Element | null): el is HTMLElement => !!el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT" || (el as HTMLElement).isContentEditable);

/** Fine pointer and hover: a desktop, where focusing a field on open costs nothing. */
export function finePointer(): boolean {
  return typeof matchMedia === "function" && matchMedia("(hover: hover) and (pointer: fine)").matches;
}

/**
 * Plays a closing sheet's exit on a copy of it: whatever unmounts the sheet (its close button, a
 * save that finishes, the parent changing its mind), it sinks away instead of vanishing.
 */
function ghostOut(node: HTMLElement, scrollTop: number, transform: string): void {
  if (reducedMotion() || typeof node.animate !== "function") return;
  const clone = node.cloneNode(true) as HTMLElement;
  clone.setAttribute("aria-hidden", "true");
  clone.classList.add("is-ghost");
  clone.style.pointerEvents = "none";
  document.body.appendChild(clone);
  const body = clone.querySelector<HTMLElement>(".ui-sheet__body");
  if (body) body.scrollTop = scrollTop;
  const panel = clone.querySelector<HTMLElement>(".ui-sheet");
  const wide = wideLayout();
  const fade = clone.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 220, easing: "ease", fill: "forwards" });
  panel?.animate([{ transform: transform || "none" }, { transform: wide ? "translateY(14px) scale(0.98)" : "translateY(105%)" }], { duration: wide ? 200 : 260, easing: EASE_IN, fill: "forwards" });
  const done = () => clone.remove();
  fade.finished.then(done, done);
  setTimeout(done, 600);
}

export interface SheetProps {
  title: ReactNode;
  sub?: ReactNode;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  /** md: 560px; lg: 680px on wide screens. */
  size?: "md" | "lg";
  /** Closes on Escape, the backdrop and a drag down (on by default). */
  dismissible?: boolean;
  closeLabel?: string;
  /**
   * What gets focus on open. Left out: the sheet itself (no keyboard pops up). A ref to a field:
   * that field, after the sheet has risen; `autoFocus` decides where.
   */
  initialFocus?: RefObject<HTMLElement | null>;
  /** Where initialFocus applies: everywhere, or only with a mouse (a phone keeps its keyboard down). */
  autoFocus?: "always" | "desktop";
  /** Something beside the title (a star, a menu). */
  actions?: ReactNode;
  /** A picture across the top of the sheet, above the title. */
  hero?: ReactNode;
  className?: string;
}

/**
 * A bottom sheet on phones, a centred panel on wide screens. It rises in, follows a drag down
 * from its handle or title (past 120px or a flick closes it), and sinks out however it closes.
 * Focus stays inside; Escape closes the top sheet only; a field you're typing in stays above
 * the phone's keyboard, and the footer rides on top of it. Enter in a single-line field moves
 * to the next field when that field asks for it (enterKeyHint="next").
 */
export function Sheet({ title, sub, onClose, children, footer, size = "md", dismissible = true, closeLabel = "Close", initialFocus, autoFocus = "desktop", actions, hero, className }: SheetProps) {
  const backdrop = useRef<HTMLDivElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const id = useRef(0);
  if (!id.current) id.current = nextId++;
  const close = useLatest(onClose);
  const canDismiss = useLatest(dismissible);
  const downOnBackdrop = useRef(false);
  const drag = useRef<{ y0: number; dy: number; active: boolean; samples: { y: number; t: number }[]; pointer: number } | null>(null);

  useLayoutEffect(() => {
    const me = id.current;
    const node = backdrop.current!;
    const p = panel.current!;
    stack.push(me);
    lockScroll();
    const opener = document.activeElement as HTMLElement | null;
    p.focus({ preventScroll: true });
    const wide = wideLayout();
    motion(node, [{ opacity: 0 }, { opacity: 1 }], { duration: 200, easing: "ease" });
    const rise = motion(p, [{ transform: wide ? "translateY(12px) scale(0.98)" : "translateY(40px)", opacity: wide ? 0 : 0.6 }, { transform: "none", opacity: 1 }], { duration: DURATION.sheet });
    // Focus the asked-for field once the sheet has settled, so the page doesn't jump mid-rise.
    let focusTimer: ReturnType<typeof setTimeout> | null = null;
    if (initialFocus && (autoFocus === "always" || finePointer())) {
      focusTimer = setTimeout(() => initialFocus.current?.focus({ preventScroll: true }), rise ? DURATION.sheet - 60 : 0);
    }
    return () => {
      if (focusTimer) clearTimeout(focusTimer);
      const at = stack.lastIndexOf(me);
      if (at >= 0) stack.splice(at, 1);
      unlockScroll();
      const scrollTop = bodyRef.current?.scrollTop ?? 0;
      const transform = p.style.transform;
      // A StrictMode rehearsal unmounts and remounts without touching the DOM: only a real
      // close takes the node out, so only then is there anything to ghost.
      queueMicrotask(() => {
        if (!node.isConnected) ghostOut(node, scrollTop, transform);
      });
      // Back to whatever opened it (a row, a button in the sheet underneath), without scrolling.
      if (opener?.isConnected) opener.focus({ preventScroll: true });
    };
    // Once, on open: later prop changes don't re-run the entrance.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (stack[stack.length - 1] !== id.current || e.defaultPrevented) return;
      if (e.key === "Escape" && canDismiss.current) {
        e.preventDefault();
        close.current();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [close, canDismiss]);

  // The phone's keyboard: size the sheet to what's left of the screen, lift it above the
  // keyboard, and keep the field being typed in where it can be seen.
  useEffect(() => {
    const vv = window.visualViewport;
    const node = backdrop.current;
    if (!vv || !node) return;
    let last = vv.height;
    const fit = () => {
      const bottom = Math.max(0, window.innerHeight - vv.height - vv.offsetTop);
      node.style.setProperty("--ui-vv-bottom", `${bottom}px`);
      node.style.setProperty("--ui-vv-height", `${vv.height}px`);
      const shrank = vv.height < last - 80;
      last = vv.height;
      const active = document.activeElement;
      if (shrank && isField(active) && panel.current?.contains(active)) {
        requestAnimationFrame(() => active.scrollIntoView({ block: "center", behavior: reducedMotion() ? "auto" : "smooth" }));
      }
    };
    fit();
    vv.addEventListener("resize", fit);
    vv.addEventListener("scroll", fit);
    return () => {
      vv.removeEventListener("resize", fit);
      vv.removeEventListener("scroll", fit);
    };
  }, []);

  const onPanelKey = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (stack[stack.length - 1] !== id.current) return;
    const p = panel.current!;
    if (e.key === "Tab") {
      const els = Array.from(p.querySelectorAll<HTMLElement>(FOCUSABLE)).filter((el) => el.offsetParent !== null || el === document.activeElement);
      if (!els.length) return;
      const firstEl = els[0];
      const lastEl = els[els.length - 1];
      if (e.shiftKey && (document.activeElement === firstEl || document.activeElement === p)) {
        e.preventDefault();
        lastEl.focus();
      } else if (!e.shiftKey && document.activeElement === lastEl) {
        e.preventDefault();
        firstEl.focus();
      }
    } else if (e.key === "Enter" && !e.nativeEvent.isComposing) {
      // Enter on a field that says "next" goes to the next field instead of submitting.
      const t = e.target as HTMLInputElement;
      if (t.tagName === "INPUT" && t.enterKeyHint === "next") {
        const fields = Array.from(p.querySelectorAll<HTMLElement>("input:not([disabled]):not([type=hidden]):not([type=date]), textarea:not([disabled])")).filter((el) => el.offsetParent !== null);
        const nextField = fields[fields.indexOf(t) + 1];
        if (nextField) {
          e.preventDefault();
          nextField.focus();
        }
      }
    }
  };

  /* ---- drag down to close, from the handle and the title */
  const onDragStart = (e: ReactPointerEvent<HTMLElement>) => {
    if (!dismissible || (e.pointerType === "mouse" && e.button !== 0)) return;
    if ((e.target as HTMLElement).closest("button, a, input, textarea, select, [data-no-drag]")) return;
    drag.current = { y0: e.clientY, dy: 0, active: false, samples: [{ y: e.clientY, t: e.timeStamp }], pointer: e.pointerId };
  };
  const onDragMove = (e: ReactPointerEvent<HTMLElement>) => {
    const d = drag.current;
    if (!d || e.pointerId !== d.pointer) return;
    d.dy = e.clientY - d.y0;
    if (!d.active) {
      if (Math.abs(d.dy) < 6) return;
      d.active = true;
      capture(e.currentTarget, e.pointerId);
    }
    d.samples.push({ y: e.clientY, t: e.timeStamp });
    if (d.samples.length > 5) d.samples.shift();
    const y = d.dy > 0 ? d.dy : d.dy / 5;
    panel.current!.style.transform = `translateY(${y}px)`;
    backdrop.current!.style.setProperty("--ui-drag", String(Math.max(0, Math.min(1, d.dy / 400))));
  };
  const onDragEnd = (e: ReactPointerEvent<HTMLElement>) => {
    const d = drag.current;
    drag.current = null;
    if (!d || !d.active) return;
    const s = d.samples;
    const v = s.length > 1 ? (s[s.length - 1].y - s[0].y) / Math.max(1, s[s.length - 1].t - s[0].t) : 0;
    const p = panel.current!;
    backdrop.current!.style.removeProperty("--ui-drag");
    if (e.type !== "pointercancel" && (d.dy > 120 || (v > 0.6 && d.dy > 24))) {
      haptic(6);
      close.current();
      return;
    }
    const from = p.style.transform;
    p.style.transform = "";
    motion(p, [{ transform: from || "none" }, { transform: "none" }], { duration: 260, easing: EASE });
  };
  const dragProps = { onPointerDown: onDragStart, onPointerMove: onDragMove, onPointerUp: onDragEnd, onPointerCancel: onDragEnd };

  const titleText = typeof title === "string" ? title : undefined;
  return createPortal(
    <div
      ref={backdrop}
      className="ui-backdrop"
      onPointerDown={(e) => {
        downOnBackdrop.current = e.target === e.currentTarget;
      }}
      onClick={(e) => {
        if (downOnBackdrop.current && e.target === e.currentTarget && dismissible) close.current();
        downOnBackdrop.current = false;
      }}
    >
      <div ref={panel} className={cx("ui-sheet", `ui-sheet--${size}`, className)} role="dialog" aria-modal="true" aria-label={titleText} tabIndex={-1} onKeyDown={onPanelKey}>
        {dismissible && <div className="ui-sheet__grab" aria-hidden="true" {...dragProps} />}
        {hero && (
          <div className="ui-sheet__hero sheet-hero" {...dragProps}>
            {hero}
          </div>
        )}
        <header className="ui-sheet__head" {...dragProps}>
          <div className="ui-sheet__titles">
            <h2 className="ui-sheet__title">{title}</h2>
            {sub && <p className="ui-sheet__sub">{sub}</p>}
          </div>
          {actions}
          <button type="button" className="ui-icon-btn ui-icon-btn--soft ui-icon-btn--md ui-sheet__close" aria-label={closeLabel} title={closeLabel} onClick={() => close.current()}>
            <svg width="20" height="20" viewBox="0 0 24 24" aria-hidden="true">
              <path d="M6 6l12 12M18 6 6 18" />
            </svg>
          </button>
        </header>
        <div ref={bodyRef} className="ui-sheet__body">
          {children}
        </div>
        {footer && <footer className="ui-sheet__foot">{footer}</footer>}
      </div>
    </div>,
    document.body,
  );
}

/**
 * Notes when the phone's keyboard is up (the visual viewport shrinks by a quarter or more) and
 * marks the page with `ui-keyboard-open`, so a fixed tab bar or a floating button can step aside.
 */
export function useKeyboardAware(): void {
  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;
    const check = () => {
      const open = vv.height < window.innerHeight * 0.78 && isField(document.activeElement);
      document.body.classList.toggle("ui-keyboard-open", open);
    };
    let t: ReturnType<typeof setTimeout> | null = null;
    // Focus moving from one field to the next blurs first: wait a beat before deciding.
    const later = () => {
      if (t) clearTimeout(t);
      t = setTimeout(check, 60);
    };
    vv.addEventListener("resize", check);
    document.addEventListener("focusin", check);
    document.addEventListener("focusout", later);
    check();
    return () => {
      if (t) clearTimeout(t);
      vv.removeEventListener("resize", check);
      document.removeEventListener("focusin", check);
      document.removeEventListener("focusout", later);
      document.body.classList.remove("ui-keyboard-open");
    };
  }, []);
}
