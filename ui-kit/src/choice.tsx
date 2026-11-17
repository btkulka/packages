import { useCallback, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { cx, useResize } from "./hooks.js";
import { haptic } from "./motion.js";

export interface ChoiceOption<T extends string | number> {
  value: T;
  label: ReactNode;
  /** A number after the label ("Fridge 7"), dimmer. */
  count?: ReactNode;
  icon?: ReactNode;
  disabled?: boolean;
  /** Spoken name when the label is only an icon. */
  ariaLabel?: string;
}

/** Arrow keys, Home and End move the choice along a group of radios (or tabs). */
function moveWithKeys<T extends string | number>(e: KeyboardEvent<HTMLElement>, options: ChoiceOption<T>[], value: T, pick: (v: T) => void, vertical = false): void {
  const keys = vertical ? ["ArrowUp", "ArrowDown"] : ["ArrowLeft", "ArrowRight"];
  const enabled = options.filter((o) => !o.disabled);
  if (!enabled.length) return;
  const at = Math.max(0, enabled.findIndex((o) => o.value === value));
  let next: number | null = null;
  if (e.key === keys[1] || (!vertical && e.key === "ArrowDown") || (vertical && e.key === "ArrowRight")) next = (at + 1) % enabled.length;
  else if (e.key === keys[0] || (!vertical && e.key === "ArrowUp") || (vertical && e.key === "ArrowLeft")) next = (at - 1 + enabled.length) % enabled.length;
  else if (e.key === "Home") next = 0;
  else if (e.key === "End") next = enabled.length - 1;
  if (next === null) return;
  e.preventDefault();
  pick(enabled[next].value);
  const btn = (e.currentTarget as HTMLElement).querySelector<HTMLElement>(`[data-value="${CSS.escape(String(enabled[next].value))}"]`);
  btn?.focus();
}

export interface SegmentedProps<T extends string | number> {
  value: T;
  options: ChoiceOption<T>[];
  onChange: (v: T) => void;
  /** The group's name for screen readers. */
  label: string;
  size?: "sm" | "md";
  /** Segments share the width (on) or sit at their own width (off). */
  stretch?: boolean;
  /** radio: a choice; tab: switches what's shown below. */
  role?: "radio" | "tab";
  className?: string;
}

/** A row of choices with a thumb that slides to the one picked. Scrolls sideways when it doesn't fit. */
export function Segmented<T extends string | number>({ value, options, onChange, label, size = "md", stretch = true, role = "radio", className }: SegmentedProps<T>) {
  const wrap = useRef<HTMLDivElement>(null);
  const [thumb, setThumb] = useState<{ x: number; w: number } | null>(null);
  const [ready, setReady] = useState(false);
  const measure = useCallback(() => {
    const el = wrap.current?.querySelector<HTMLElement>('[data-on="true"]');
    if (!el) return setThumb(null);
    setThumb((t) => (t && t.x === el.offsetLeft && t.w === el.offsetWidth ? t : { x: el.offsetLeft, w: el.offsetWidth }));
    // Keep the picked one in view when the row scrolls.
    const box = wrap.current!;
    if (box.scrollWidth > box.clientWidth) {
      const left = el.offsetLeft - 8;
      const right = el.offsetLeft + el.offsetWidth + 8 - box.clientWidth;
      if (box.scrollLeft > left) box.scrollTo({ left, behavior: ready ? "smooth" : "auto" });
      else if (box.scrollLeft < right) box.scrollTo({ left: right, behavior: ready ? "smooth" : "auto" });
    }
  }, [ready]);
  const labels = options.map((o) => `${o.value}:${typeof o.label === "string" ? o.label : ""}:${o.count ?? ""}`).join("|");
  useLayoutEffect(measure, [value, labels, measure]);
  useResize(wrap, measure);
  useLayoutEffect(() => {
    // Slide only after the first placement, so it doesn't fly in from the left on load.
    const id = requestAnimationFrame(() => setReady(true));
    return () => cancelAnimationFrame(id);
  }, []);
  const pick = (v: T) => {
    if (v === value) return;
    haptic(4);
    onChange(v);
  };
  const isTab = role === "tab";
  return (
    <div
      ref={wrap}
      className={cx("ui-seg", `ui-seg--${size}`, stretch && "ui-seg--stretch", ready && "is-ready", className)}
      role={isTab ? "tablist" : "radiogroup"}
      aria-label={label}
      onKeyDown={(e) => moveWithKeys(e, options, value, pick)}
    >
      {thumb && <span className="ui-seg__thumb" aria-hidden="true" style={{ transform: `translateX(${thumb.x}px)`, width: thumb.w }} />}
      {options.map((o) => {
        const on = o.value === value;
        return (
          <button
            key={String(o.value)}
            type="button"
            role={isTab ? "tab" : "radio"}
            aria-checked={isTab ? undefined : on}
            aria-selected={isTab ? on : undefined}
            aria-label={o.ariaLabel}
            tabIndex={on ? 0 : -1}
            disabled={o.disabled}
            data-on={on}
            data-value={String(o.value)}
            className={cx("ui-seg__opt", on && "is-on")}
            onClick={() => pick(o.value)}
          >
            {o.icon}
            {o.label}
            {o.count !== undefined && <span className="ui-seg__count">{o.count}</span>}
          </button>
        );
      })}
    </div>
  );
}

export interface TileGroupProps<T extends string | number> {
  value: T | null;
  options: (ChoiceOption<T> & { icon: ReactNode })[];
  onChange: (v: T) => void;
  label: string;
  columns?: number;
  className?: string;
}

/** Big drawn choices in a grid (fridge, freezer, pantry, counter): one lit at a time. */
export function TileGroup<T extends string | number>({ value, options, onChange, label, columns, className }: TileGroupProps<T>) {
  const pick = (v: T) => {
    if (v === value) return;
    haptic(4);
    onChange(v);
  };
  const current = value ?? options[0]?.value;
  return (
    <div className={cx("ui-tiles", className)} role="radiogroup" aria-label={label} style={{ gridTemplateColumns: `repeat(${columns ?? options.length}, minmax(0, 1fr))` }} onKeyDown={(e) => current !== undefined && moveWithKeys(e, options, current, pick)}>
      {options.map((o) => {
        const on = o.value === value;
        return (
          <button key={String(o.value)} type="button" role="radio" aria-checked={on} tabIndex={on || (value === null && o.value === current) ? 0 : -1} disabled={o.disabled} data-value={String(o.value)} className={cx("ui-tile", on && "is-on")} onClick={() => pick(o.value)}>
            <span className="ui-tile__icon">{o.icon}</span>
            <span className="ui-tile__label">{o.label}</span>
          </button>
        );
      })}
    </div>
  );
}
