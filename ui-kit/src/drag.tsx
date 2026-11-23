import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useLatest } from "./hooks.js";
import { haptic } from "./motion.js";

export interface DragToOptions {
  /** The drop target under the pointer, from the element there (`el.closest(".tabs [data-value]")`), or null. */
  find: (el: Element) => HTMLElement | null;
  /** Let go over a target. */
  onDrop: (target: HTMLElement) => void;
  /** What follows the pointer while dragging (the thing's name). */
  ghost: ReactNode;
  onStart?: () => void;
  /** The drag ended, dropped or not. */
  onEnd?: () => void;
  disabled?: boolean;
}

export interface DragToHandle {
  /** Spread on the grip: dragging starts from it (touch, pen or mouse), never from the rest of the row. */
  handle: {
    onPointerDown: (e: ReactPointerEvent<HTMLElement>) => void;
    style: { touchAction: "none" };
    "data-drag-handle": true;
  };
  dragging: boolean;
  /** Render once: the floating ghost while dragging. */
  layer: ReactNode;
}

/** Pointer travel before a press becomes a drag. */
const SLOP = 6;

/**
 * Drag something by its grip onto a target elsewhere on the page (a row onto a tab): the ghost follows the pointer,
 * the target under it gets `is-drop-over`, and letting go there calls `onDrop`. Escape, or letting go anywhere
 * else, cancels. Works by touch as well as mouse, since it runs on pointer events (HTML drag and drop doesn't on
 * phones). Give the same action another way too (a menu): dragging isn't for everyone.
 */
export function useDragTo(o: DragToOptions): DragToHandle {
  const opts = useLatest(o);
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
  const state = useRef<{ id: number; x0: number; y0: number; live: boolean; over: HTMLElement | null } | null>(null);
  const cleanup = useRef<(() => void) | null>(null);

  const setOver = (el: HTMLElement | null) => {
    const s = state.current;
    if (!s || s.over === el) return;
    s.over?.classList.remove("is-drop-over");
    el?.classList.add("is-drop-over");
    if (el) haptic(6);
    s.over = el;
  };
  const finish = (drop: boolean) => {
    const s = state.current;
    cleanup.current?.();
    cleanup.current = null;
    state.current = null;
    setPos(null);
    if (!s) return;
    s.over?.classList.remove("is-drop-over");
    if (s.live) {
      if (drop && s.over) opts.current.onDrop(s.over);
      opts.current.onEnd?.();
    }
  };
  useEffect(() => () => finish(false), []);

  const onPointerDown = (e: ReactPointerEvent<HTMLElement>) => {
    if (opts.current.disabled || (e.pointerType === "mouse" && e.button !== 0)) return;
    // The row under the grip mustn't take this as a swipe, a long press or a click.
    e.stopPropagation();
    e.preventDefault();
    state.current = { id: e.pointerId, x0: e.clientX, y0: e.clientY, live: false, over: null };
    const move = (ev: PointerEvent) => {
      const s = state.current;
      if (!s || ev.pointerId !== s.id) return;
      if (!s.live) {
        if (Math.hypot(ev.clientX - s.x0, ev.clientY - s.y0) < SLOP) return;
        s.live = true;
        haptic(8);
        opts.current.onStart?.();
      }
      ev.preventDefault();
      setPos({ x: ev.clientX, y: ev.clientY });
      const under = document.elementFromPoint(ev.clientX, ev.clientY);
      setOver(under ? opts.current.find(under) : null);
    };
    const up = (ev: PointerEvent) => {
      if (state.current && ev.pointerId === state.current.id) finish(true);
    };
    const cancel = (ev: PointerEvent) => {
      if (state.current && ev.pointerId === state.current.id) finish(false);
    };
    const key = (ev: KeyboardEvent) => {
      if (ev.key === "Escape") finish(false);
    };
    window.addEventListener("pointermove", move, { passive: false });
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", cancel);
    window.addEventListener("keydown", key);
    cleanup.current = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", cancel);
      window.removeEventListener("keydown", key);
    };
  };

  const layer =
    pos && typeof document !== "undefined"
      ? createPortal(
          <div className="ui-drag-ghost" style={{ transform: `translate(${pos.x}px, ${pos.y}px)` }} aria-hidden="true">
            {o.ghost}
          </div>,
          document.body,
        )
      : null;

  return { handle: { onPointerDown, style: { touchAction: "none" }, "data-drag-handle": true }, dragging: pos !== null, layer };
}
