import { useCallback, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { cx, useResize } from "./hooks.js";
import { haptic } from "./motion.js";

export interface TabItem<T extends string> {
  id: T;
  label: string;
  icon?: ReactNode;
  /** A count on the tab ("3 to use soon"). */
  badge?: ReactNode;
  badgeLabel?: string;
  /** Extra class on the tab (one shown only on phones). */
  className?: string;
}

export interface TabBarProps<T extends string> {
  items: TabItem<T>[];
  value: T;
  onChange: (id: T) => void;
  label: string;
  /** At the top of the desktop rail (the app's name and icon). */
  brand?: ReactNode;
  /** At the bottom of the desktop rail. */
  footer?: ReactNode;
  className?: string;
}

/**
 * The app's sections: a floating bar at the bottom of a phone, a rail down the side of a wide
 * screen (900px and up), with a lit pill that glides to the section you're in. Tapping the
 * section you're already in asks it to go back to its top (`onChange` fires again).
 */
export function TabBar<T extends string>({ items, value, onChange, label, brand, footer, className }: TabBarProps<T>) {
  const nav = useRef<HTMLElement>(null);
  const [pill, setPill] = useState<{ x: number; y: number; w: number; h: number } | null>(null);
  const [ready, setReady] = useState(false);
  const measure = useCallback(() => {
    const el = nav.current?.querySelector<HTMLElement>('[aria-current="page"]');
    if (!el) return setPill(null);
    setPill((p) => (p && p.x === el.offsetLeft && p.y === el.offsetTop && p.w === el.offsetWidth && p.h === el.offsetHeight ? p : { x: el.offsetLeft, y: el.offsetTop, w: el.offsetWidth, h: el.offsetHeight }));
  }, []);
  useLayoutEffect(measure, [value, items.length, measure]);
  useResize(nav, measure);
  useLayoutEffect(() => {
    const id = requestAnimationFrame(() => setReady(true));
    return () => cancelAnimationFrame(id);
  }, []);
  return (
    <nav ref={nav} className={cx("ui-tabbar", ready && "is-ready", className)} aria-label={label}>
      {brand && <span className="ui-tabbar__brand">{brand}</span>}
      {pill && <span className="ui-tabbar__pill" aria-hidden="true" style={{ transform: `translate(${pill.x}px, ${pill.y}px)`, width: pill.w, height: pill.h }} />}
      {items.map((t) => {
        const on = t.id === value;
        return (
          <button
            key={t.id}
            type="button"
            className={cx("ui-tab", on && "is-on", t.className)}
            aria-current={on ? "page" : undefined}
            onClick={() => {
              if (!on) haptic(4);
              onChange(t.id);
            }}
          >
            {t.icon && <span className="ui-tab__icon">{t.icon}</span>}
            <span className="ui-tab__label">{t.label}</span>
            {t.badge !== undefined && t.badge !== null && t.badge !== 0 && (
              <span className="ui-tab__badge" aria-label={t.badgeLabel}>
                {t.badge}
              </span>
            )}
          </button>
        );
      })}
      {footer && <div className="ui-tabbar__footer">{footer}</div>}
    </nav>
  );
}
