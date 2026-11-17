import { useLayoutEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent, type ReactNode, type SyntheticEvent } from "react";
import { createPortal } from "react-dom";
import { IconButton } from "./button.js";
import { cx, useLatest } from "./hooks.js";
import { EASE, EASE_IN, haptic, motion, settled } from "./motion.js";

export interface MenuAction {
  label: string;
  icon?: ReactNode;
  onSelect: () => void;
  tone?: "danger" | "good" | "accent";
  disabled?: boolean;
  /** Dim text at the end ("3d", "⌘D"). */
  hint?: ReactNode;
  /** A tick at the end: this is the current one. */
  checked?: boolean;
}
export type MenuEntry = MenuAction | { separator: true } | { heading: string };

export interface MenuSpec {
  /** What the menu is about: shown at the top of the phone's action sheet. */
  title?: ReactNode;
  subtitle?: ReactNode;
  icon?: ReactNode;
  /** Falsy entries are skipped, so `cond && {...}` works. */
  items: (MenuEntry | false | null | undefined)[];
}

export type MenuMode = "popover" | "sheet";

const isAction = (e: MenuEntry): e is MenuAction => "onSelect" in e;

export interface MenuProps {
  spec: MenuSpec;
  /** Where it opens: the pointer, or an element's box. */
  at: { x: number; y: number } | DOMRect;
  mode: MenuMode;
  onClose: () => void;
  /** Focus goes back here when the menu closes (keyboard openings). */
  returnFocus?: HTMLElement | null;
  cancelLabel?: string;
}

/** Stops a portal's events from climbing the React tree into the row that opened it. */
const stop = (e: SyntheticEvent) => e.stopPropagation();

/**
 * A menu of actions: a small popover at the pointer with a mouse, an action sheet from the
 * bottom on a phone. Arrow keys, Home, End and the first letter move through it; Escape,
 * a tap outside or scrolling closes it.
 */
export function Menu({ spec, at, mode, onClose, returnFocus, cancelLabel = "Cancel" }: MenuProps) {
  const root = useRef<HTMLDivElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const closing = useRef(false);
  const done = useLatest(onClose);
  const entries = spec.items.filter((e): e is MenuEntry => !!e);
  const [pos, setPos] = useState<{ left: number; top: number; origin: string } | null>(null);

  const finish = async (then?: () => void) => {
    if (closing.current) return;
    closing.current = true;
    then?.();
    const p = panel.current;
    const a = mode === "sheet" ? motion(p, [{ transform: "none" }, { transform: "translateY(100%)" }], { duration: 200, easing: EASE_IN, fill: "forwards" }) : motion(p, [{ opacity: 1, transform: "none" }, { opacity: 0, transform: "scale(0.96)" }], { duration: 120, easing: EASE_IN, fill: "forwards" });
    if (mode === "sheet") motion(root.current, [{ opacity: 1 }, { opacity: 0 }], { duration: 200, fill: "forwards" });
    await settled(a);
    done.current();
    if (returnFocus?.isConnected) returnFocus.focus({ preventScroll: true });
  };
  const close = useLatest(finish);

  // Place the popover inside the window, opening away from the nearer edges.
  useLayoutEffect(() => {
    const p = panel.current;
    if (!p) return;
    if (mode === "popover") {
      const w = p.offsetWidth;
      const h = p.offsetHeight;
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      const r = "width" in at ? at : null;
      let x = r ? r.right - w : at.x;
      let y = r ? r.bottom + 6 : at.y;
      let ox = r ? "right" : "left";
      let oy = "top";
      if (x + w > vw - 8) {
        x = Math.max(8, (r ? r.right : at.x) - w);
        ox = "right";
      }
      if (x < 8) x = 8;
      if (y + h > vh - 8) {
        y = Math.max(8, (r ? r.top - 6 : at.y) - h);
        oy = "bottom";
      }
      setPos({ left: x, top: y, origin: `${ox} ${oy}` });
    }
    const first = p.querySelector<HTMLElement>('[role="menuitem"]:not([disabled])');
    first?.focus({ preventScroll: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useLayoutEffect(() => {
    if (mode === "popover" && pos) motion(panel.current, [{ opacity: 0, transform: "scale(0.94)" }, { opacity: 1, transform: "none" }], { duration: 150 });
    if (mode === "sheet") {
      motion(panel.current, [{ transform: "translateY(100%)" }, { transform: "none" }], { duration: 260, easing: EASE });
      motion(root.current, [{ opacity: 0 }, { opacity: 1 }], { duration: 200 });
    }
  }, [mode, pos]);

  // A popover closes when the page scrolls or resizes under it, or a tap lands elsewhere.
  useLayoutEffect(() => {
    if (mode !== "popover") return;
    const away = (e: Event) => {
      if (panel.current && e.target instanceof Node && panel.current.contains(e.target)) return;
      close.current();
    };
    const t = setTimeout(() => {
      window.addEventListener("pointerdown", away, true);
      window.addEventListener("scroll", away, true);
      window.addEventListener("resize", away);
    });
    return () => {
      clearTimeout(t);
      window.removeEventListener("pointerdown", away, true);
      window.removeEventListener("scroll", away, true);
      window.removeEventListener("resize", away);
    };
  }, [mode, close]);

  const onKey = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    e.stopPropagation();
    const items = Array.from(panel.current?.querySelectorAll<HTMLElement>('[role="menuitem"]:not([disabled])') ?? []);
    const at2 = items.indexOf(document.activeElement as HTMLElement);
    const go = (i: number) => items[(i + items.length) % items.length]?.focus();
    if (e.key === "Escape" || e.key === "Tab") {
      e.preventDefault();
      void finish();
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      go(at2 + 1);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      go(at2 - 1);
    } else if (e.key === "Home") {
      e.preventDefault();
      go(0);
    } else if (e.key === "End") {
      e.preventDefault();
      go(items.length - 1);
    } else if (e.key.length === 1 && /\S/.test(e.key)) {
      const k = e.key.toLowerCase();
      const from = items.slice(at2 + 1).concat(items.slice(0, at2 + 1));
      from.find((el) => el.textContent?.trim().toLowerCase().startsWith(k))?.focus();
    }
  };

  const list = (
    <div className="ui-menu__items" role="menu" aria-label={typeof spec.title === "string" ? spec.title : "Actions"}>
      {entries.map((e, i) => {
        if ("separator" in e) return <div key={i} className="ui-menu__sep" role="separator" />;
        if ("heading" in e) return <div key={i} className="ui-menu__heading">{e.heading}</div>;
        if (!isAction(e)) return null;
        return (
          <button
            key={i}
            type="button"
            role="menuitem"
            disabled={e.disabled}
            className={cx("ui-menu__item", e.tone && `ui-tone-${e.tone}`, e.checked && "is-checked")}
            onClick={() => {
              haptic(6);
              void finish(e.onSelect);
            }}
          >
            <span className="ui-menu__icon" aria-hidden="true">
              {e.icon}
            </span>
            <span className="ui-menu__label">{e.label}</span>
            {e.hint && <span className="ui-menu__hint">{e.hint}</span>}
            {e.checked && (
              <svg className="ui-menu__check" width="16" height="16" viewBox="0 0 24 24" aria-hidden="true">
                <path d="M5 12.5l4.5 4.5L19 7.5" />
              </svg>
            )}
          </button>
        );
      })}
    </div>
  );

  const shield = { onClick: stop, onPointerDown: stop, onPointerUp: stop, onContextMenu: (e: ReactMouseEvent) => (e.preventDefault(), e.stopPropagation()), onKeyDown: onKey };

  return createPortal(
    mode === "sheet" ? (
      <div ref={root} className="ui-menu-backdrop" {...shield} onClick={(e) => (e.stopPropagation(), e.target === e.currentTarget && void finish())}>
        <div ref={panel} className="ui-menu ui-menu--sheet">
          {(spec.title || spec.icon) && (
            <div className="ui-menu__head">
              {spec.icon && <span className="ui-menu__head-icon">{spec.icon}</span>}
              <span>
                <strong>{spec.title}</strong>
                {spec.subtitle && <span>{spec.subtitle}</span>}
              </span>
            </div>
          )}
          {list}
          <button type="button" className="ui-menu__cancel" onClick={() => void finish()}>
            {cancelLabel}
          </button>
        </div>
      </div>
    ) : (
      <div ref={root} className="ui-menu-layer" {...shield}>
        <div ref={panel} className="ui-menu ui-menu--popover" style={pos ? { left: pos.left, top: pos.top, transformOrigin: pos.origin } : { left: -9999, top: 0 }}>
          {list}
        </div>
      </div>
    ),
    document.body,
  );
}

export interface LongPressInfo {
  x: number;
  y: number;
  /** How it was asked for: a finger (long press), a mouse (right-click), or the keyboard. */
  via: "touch" | "mouse" | "keyboard";
  target: HTMLElement;
}

export interface LongPressHandlers {
  onPointerDown: (e: ReactPointerEvent<HTMLElement>) => void;
  onPointerMove: (e: ReactPointerEvent<HTMLElement>) => void;
  onPointerUp: () => void;
  onPointerCancel: () => void;
  onPointerLeave: () => void;
  onClickCapture: (e: ReactMouseEvent<HTMLElement>) => void;
  onContextMenu: (e: ReactMouseEvent<HTMLElement>) => void;
  "data-pressable": true;
}

/**
 * Press and hold (a finger or pen, 450ms, staying put), right-click, or the keyboard's menu key
 * and Shift+F10: one callback for all three. The element sinks a little while held
 * (`is-pressing`), and the click that ends a long press is swallowed.
 */
export function useLongPress(onLongPress: (info: LongPressInfo) => void, o: { delay?: number; tolerance?: number; disabled?: boolean } = {}): LongPressHandlers {
  const { delay = 450, tolerance = 10, disabled = false } = o;
  const cb = useLatest(onLongPress);
  const st = useRef<{ x: number; y: number; el: HTMLElement; timer: ReturnType<typeof setTimeout>; sink: ReturnType<typeof setTimeout> } | null>(null);
  const firedAt = useRef(0);
  const cancel = () => {
    const s = st.current;
    if (!s) return;
    clearTimeout(s.timer);
    clearTimeout(s.sink);
    s.el.classList.remove("is-pressing");
    st.current = null;
  };
  return {
    "data-pressable": true,
    onPointerDown: (e) => {
      if (disabled || e.pointerType === "mouse" || e.button > 0) return;
      cancel();
      const el = e.currentTarget;
      const x = e.clientX;
      const y = e.clientY;
      st.current = {
        x,
        y,
        el,
        sink: setTimeout(() => el.classList.add("is-pressing"), 140),
        timer: setTimeout(() => {
          el.classList.remove("is-pressing");
          st.current = null;
          firedAt.current = Date.now();
          haptic(12);
          cb.current({ x, y, via: "touch", target: el });
        }, delay),
      };
    },
    onPointerMove: (e) => {
      const s = st.current;
      if (s && Math.hypot(e.clientX - s.x, e.clientY - s.y) > tolerance) cancel();
    },
    onPointerUp: cancel,
    onPointerCancel: cancel,
    onPointerLeave: cancel,
    onClickCapture: (e) => {
      if (Date.now() - firedAt.current < 700) {
        e.preventDefault();
        e.stopPropagation();
      }
    },
    onContextMenu: (e) => {
      if (disabled) return;
      e.preventDefault();
      e.stopPropagation();
      // Android fires its own contextmenu after a long press that already opened the menu.
      if (Date.now() - firedAt.current < 900) return;
      cancel();
      const el = e.currentTarget;
      const native = e.nativeEvent as MouseEvent & { pointerType?: string };
      const keyboard = native.button === -1 || (e.clientX === 0 && e.clientY === 0) || native.detail === 0 && native.pointerType === "";
      const touch = native.pointerType === "touch" || native.pointerType === "pen";
      if (keyboard) {
        const r = el.getBoundingClientRect();
        cb.current({ x: r.left + Math.min(48, r.width / 2), y: r.top + r.height / 2, via: "keyboard", target: el });
      } else cb.current({ x: e.clientX, y: e.clientY, via: touch ? "touch" : "mouse", target: el });
    },
  };
}

export interface ContextMenuHandle {
  /** Spread on the element that has the menu. */
  bind: LongPressHandlers;
  /** Render this somewhere in the component (it portals out). */
  menu: ReactNode;
  /** Opens the menu from a button ("⋯"), anchored to it. */
  openFrom: (el: HTMLElement) => void;
  isOpen: boolean;
}

/**
 * A context menu for anything: long press, right-click or the menu key opens it with the actions
 * from `spec` (asked for at the moment it opens, so they're current).
 */
export function useContextMenu(spec: () => MenuSpec | null, o: { disabled?: boolean } = {}): ContextMenuHandle {
  const [open, setOpen] = useState<{ spec: MenuSpec; at: { x: number; y: number } | DOMRect; mode: MenuMode; returnFocus: HTMLElement | null } | null>(null);
  const get = useLatest(spec);
  const bind = useLongPress(
    (info) => {
      const s = get.current();
      if (!s) return;
      setOpen({ spec: s, at: { x: info.x, y: info.y }, mode: info.via === "touch" ? "sheet" : "popover", returnFocus: info.via === "keyboard" ? info.target : null });
    },
    { disabled: o.disabled },
  );
  const openFrom = (el: HTMLElement) => {
    const s = get.current();
    if (!s) return;
    const fine = typeof matchMedia === "function" && matchMedia("(hover: hover) and (pointer: fine)").matches;
    setOpen({ spec: s, at: el.getBoundingClientRect(), mode: fine ? "popover" : "sheet", returnFocus: el });
  };
  return {
    bind,
    openFrom,
    isOpen: !!open,
    menu: open ? <Menu spec={open.spec} at={open.at} mode={open.mode} returnFocus={open.returnFocus} onClose={() => setOpen(null)} /> : null,
  };
}

/** A "⋯" button that opens a menu, for where a long press wouldn't be found. */
export function MenuButton({ menu, label = "More", icon, size = "md", variant = "plain", className }: { menu: () => MenuSpec | null; label?: string; icon?: ReactNode; size?: "sm" | "md"; variant?: "plain" | "soft"; className?: string }) {
  const cm = useContextMenu(menu);
  return (
    <>
      <IconButton
        label={label}
        size={size}
        variant={variant}
        className={cx("ui-menu-btn", className)}
        aria-haspopup="menu"
        aria-expanded={cm.isOpen}
        icon={
          icon ?? (
            <svg width="20" height="20" viewBox="0 0 24 24" aria-hidden="true">
              <circle cx="5" cy="12" r="1.6" className="ui-fill" />
              <circle cx="12" cy="12" r="1.6" className="ui-fill" />
              <circle cx="19" cy="12" r="1.6" className="ui-fill" />
            </svg>
          )
        }
        onClick={(e) => {
          e.stopPropagation();
          cm.openFrom(e.currentTarget);
        }}
        onPointerDown={(e) => e.stopPropagation()}
      />
      {cm.menu}
    </>
  );
}
