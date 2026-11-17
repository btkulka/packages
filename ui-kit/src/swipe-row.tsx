import { useEffect, useRef, useState, type HTMLAttributes, type KeyboardEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { cx } from "./hooks.js";
import { swipeOutcome } from "./logic.js";
import { useContextMenu, type MenuSpec } from "./menu.js";
import { EASE, haptic, motion } from "./motion.js";

/** Pointer capture, when the browser has that pointer (a synthetic or stale one throws; the drag still works). */
function capture(el: Element, id: number): void {
  try {
    el.setPointerCapture(id);
  } catch {
    /* no such pointer: follow it without capture */
  }
}

export interface SwipeAction {
  label: string;
  icon?: ReactNode;
  tone?: "good" | "danger" | "accent" | "warn";
  onAction: () => void;
}

export interface SwipeRowProps extends Omit<HTMLAttributes<HTMLDivElement>, "onClick" | "children"> {
  /** Revealed by swiping right (it sits at the row's start): "done". */
  start?: SwipeAction;
  /** Revealed by swiping left (at the row's end): "gone". */
  end?: SwipeAction;
  /** A tap on the row (it's also Enter and Space when the row has focus). */
  onClick?: () => void;
  /** The row's context menu: long press, right-click, or the menu key. */
  menu?: () => MenuSpec | null;
  children: ReactNode;
  disabled?: boolean;
  /** Share of the width past which letting go commits. */
  threshold?: number;
  /** Spoken name of the row's tap. */
  "aria-label"?: string;
}

/**
 * A list row you can swipe: right for one action (sage, "used up"), left for another (berry,
 * "tossed"). It follows the finger, buzzes once it's far enough to count, flies off and lets the
 * list fold it away, or springs back. Vertical scrolling is left alone, and a long press opens
 * the row's menu instead.
 */
export function SwipeRow({ start, end, onClick, menu, children, disabled, threshold = 0.33, className, ...rest }: SwipeRowProps) {
  const root = useRef<HTMLDivElement>(null);
  const face = useRef<HTMLDivElement>(null);
  const drag = useRef<{ id: number; x0: number; y0: number; dx: number; locked: "x" | "y" | null; samples: { x: number; t: number }[]; armed: boolean } | null>(null);
  const swallow = useRef(0);
  const reset = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [dir, setDir] = useState<"start" | "end" | null>(null);
  const [armed, setArmed] = useState(false);
  const cm = useContextMenu(menu ?? (() => null), { disabled: !menu });
  useEffect(() => () => void (reset.current && clearTimeout(reset.current)), []);
  const can = !disabled && (start || end);

  const settle = (to = 0) => {
    const f = face.current;
    if (!f) return;
    const from = f.style.transform;
    f.style.transform = to ? `translateX(${to}px)` : "";
    motion(f, [{ transform: from || "none" }, { transform: to ? `translateX(${to}px)` : "none" }], { duration: to ? 180 : 260, easing: EASE });
    if (!to) {
      setDir(null);
      setArmed(false);
    }
  };

  const down = (e: ReactPointerEvent<HTMLDivElement>) => {
    cm.bind.onPointerDown(e);
    if (!can || (e.pointerType === "mouse" && e.button !== 0)) return;
    if ((e.target as HTMLElement).closest("button, a, input, select, textarea, [data-no-swipe]")) return;
    drag.current = { id: e.pointerId, x0: e.clientX, y0: e.clientY, dx: 0, locked: null, samples: [{ x: e.clientX, t: e.timeStamp }], armed: false };
  };
  const move = (e: ReactPointerEvent<HTMLDivElement>) => {
    cm.bind.onPointerMove(e);
    const d = drag.current;
    if (!d || d.id !== e.pointerId) return;
    const dx = e.clientX - d.x0;
    const dy = e.clientY - d.y0;
    if (!d.locked) {
      if (Math.abs(dx) > 8 && Math.abs(dx) > Math.abs(dy) * 1.2) {
        d.locked = "x";
        capture(e.currentTarget, e.pointerId);
      } else if (Math.abs(dy) > 8) {
        drag.current = null;
        return;
      } else return;
    }
    // No action that way: it gives a little and stops.
    const free = (dx > 0 && start) || (dx < 0 && end);
    d.dx = free ? dx : dx / 6;
    d.samples.push({ x: e.clientX, t: e.timeStamp });
    if (d.samples.length > 5) d.samples.shift();
    face.current!.style.transform = `translateX(${d.dx}px)`;
    const nowDir = d.dx > 0 ? "start" : d.dx < 0 ? "end" : null;
    setDir(nowDir);
    const w = root.current!.offsetWidth;
    const isArmed = !!free && Math.abs(d.dx) >= w * threshold;
    if (isArmed !== d.armed) {
      d.armed = isArmed;
      setArmed(isArmed);
      if (isArmed) haptic(8);
    }
  };
  const up = (e: ReactPointerEvent<HTMLDivElement>) => {
    cm.bind.onPointerUp();
    const d = drag.current;
    drag.current = null;
    if (!d || d.locked !== "x") return;
    swallow.current = Date.now();
    const s = d.samples;
    const v = s.length > 1 ? (s[s.length - 1].x - s[0].x) / Math.max(1, s[s.length - 1].t - s[0].t) : 0;
    const w = root.current!.offsetWidth;
    const out = e.type === "pointercancel" ? null : swipeOutcome(d.dx, v, w, { threshold });
    const action = out === "start" ? start : out === "end" ? end : undefined;
    if (!action) return settle(0);
    haptic(12);
    settle(out === "start" ? w : -w);
    action.onAction();
    // If the row is still here a moment later (the action didn't remove it), bring it back.
    reset.current = setTimeout(() => settle(0), 700);
  };

  const keys = (e: KeyboardEvent<HTMLDivElement>) => {
    if (onClick && (e.key === "Enter" || e.key === " ") && e.target === e.currentTarget) {
      e.preventDefault();
      onClick();
    }
  };

  return (
    <div ref={root} className={cx("ui-swipe", dir && `is-${dir}`, armed && "is-armed")}>
      {start && (
        <div className={cx("ui-swipe__under", "ui-swipe__under--start", `ui-tone-${start.tone ?? "good"}`)} aria-hidden="true">
          {start.icon}
          <span>{start.label}</span>
        </div>
      )}
      {end && (
        <div className={cx("ui-swipe__under", "ui-swipe__under--end", `ui-tone-${end.tone ?? "danger"}`)} aria-hidden="true">
          <span>{end.label}</span>
          {end.icon}
        </div>
      )}
      <div
        ref={face}
        className={cx("ui-swipe__face", onClick && "is-tappable", className)}
        role={onClick ? "button" : undefined}
        tabIndex={onClick ? 0 : undefined}
        {...rest}
        data-pressable={menu ? true : undefined}
        onPointerDown={down}
        onPointerMove={move}
        onPointerUp={up}
        onPointerCancel={up}
        onPointerLeave={cm.bind.onPointerLeave}
        onContextMenu={menu ? cm.bind.onContextMenu : undefined}
        onClickCapture={(e) => {
          cm.bind.onClickCapture(e);
          if (Date.now() - swallow.current < 350) {
            e.preventDefault();
            e.stopPropagation();
          }
        }}
        onClick={onClick}
        onKeyDown={keys}
      >
        {children}
      </div>
      {cm.menu}
    </div>
  );
}
