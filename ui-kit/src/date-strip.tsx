import { useLayoutEffect, useRef, type KeyboardEvent } from "react";
import { cx } from "./hooks.js";
import { addDaysIso, daysBetweenIso, isIso, isoToDate } from "./logic.js";
import { haptic } from "./motion.js";

export interface DateStripProps {
  /** The chosen day (yyyy-mm-dd), or null for none. */
  value: string | null;
  onChange: (iso: string | null) => void;
  /** Today (yyyy-mm-dd), from the app, so every device agrees. */
  today: string;
  /** How many days the strip offers from today. */
  days?: number;
  label: string;
  /** Offer a "none" chip at the start. */
  clearable?: boolean;
  clearLabel?: string;
  pickLabel?: string;
  todayLabel?: string;
  tomorrowLabel?: string;
  locale?: string;
  className?: string;
}

/**
 * Picking a day with one tap: a strip of the next two weeks (scrolls sideways), the chosen day
 * lit, and a calendar chip at the end for anything further out. A chosen day off the strip
 * (past, or later) shows as its own lit chip.
 */
export function DateStrip({ value, onChange, today, days = 14, label, clearable, clearLabel = "None", pickLabel = "Pick a date", todayLabel = "Today", tomorrowLabel = "Tmrw", locale, className }: DateStripProps) {
  const box = useRef<HTMLDivElement>(null);
  const ready = useRef(false);
  const strip = Array.from({ length: days }, (_, i) => addDaysIso(today, i));
  const off = value && isIso(value) && !strip.includes(value) ? value : null;
  const before = off && daysBetweenIso(today, off) < 0;
  const dow = new Intl.DateTimeFormat(locale, { weekday: "short" });
  const mon = new Intl.DateTimeFormat(locale, { month: "short" });
  const choose = (iso: string | null) => {
    if (iso === value) return;
    haptic(4);
    onChange(iso);
  };

  // Keep the chosen day in view (smoothly after the first time).
  useLayoutEffect(() => {
    const el = box.current?.querySelector<HTMLElement>('[aria-checked="true"]');
    const b = box.current;
    if (el && b) {
      const left = el.offsetLeft - b.clientWidth / 2 + el.offsetWidth / 2;
      b.scrollTo({ left: Math.max(0, left), behavior: ready.current ? "smooth" : "auto" });
    }
    ready.current = true;
  }, [value]);

  const chip = (iso: string, key: string) => {
    const d = isoToDate(iso);
    const n = daysBetweenIso(today, iso);
    const top = n === 0 ? todayLabel : n === 1 ? tomorrowLabel : n < 0 || n >= days ? mon.format(d) : dow.format(d);
    const on = iso === value;
    return (
      <button key={key} type="button" role="radio" aria-checked={on} tabIndex={on || (!value && n === 0) ? 0 : -1} data-value={iso} className={cx("ui-day", on && "is-on", n < 0 && "is-past")} onClick={() => choose(iso)} aria-label={d.toLocaleDateString(locale, { weekday: "long", month: "long", day: "numeric" })}>
        <span className="ui-day__top">{top}</span>
        <span className="ui-day__n">{d.getDate()}</span>
      </button>
    );
  };

  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(e.key)) return;
    const all = [...(clearable ? [null] : []), ...(off && before ? [off] : []), ...strip, ...(off && !before ? [off] : [])];
    const at = Math.max(0, all.indexOf(value));
    const next = e.key === "Home" ? 0 : e.key === "End" ? all.length - 1 : Math.min(all.length - 1, Math.max(0, at + (e.key === "ArrowRight" ? 1 : -1)));
    e.preventDefault();
    choose(all[next]);
    requestAnimationFrame(() => box.current?.querySelector<HTMLElement>('[aria-checked="true"]')?.focus());
  };

  return (
    <div ref={box} className={cx("ui-days", className)} role="radiogroup" aria-label={label} onKeyDown={onKey}>
      {clearable && (
        <button type="button" role="radio" aria-checked={value === null} tabIndex={value === null ? 0 : -1} className={cx("ui-day", "ui-day--word", value === null && "is-on")} onClick={() => choose(null)}>
          {clearLabel}
        </button>
      )}
      {off && before && chip(off, "off")}
      {strip.map((iso) => chip(iso, iso))}
      {off && !before && chip(off, "off")}
      <label className="ui-day ui-day--pick" title={pickLabel}>
        <svg width="20" height="20" viewBox="0 0 24 24" aria-hidden="true">
          <path d="M4 6.5a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2V19a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6.5Zm0 4h16M9 2.5v4M15 2.5v4" />
        </svg>
        <span className="ui-sr-only">{pickLabel}</span>
        {/* The native picker, laid over the chip so a tap opens it on every platform. */}
        <input type="date" value={value ?? ""} aria-label={pickLabel} onChange={(e) => choose(e.target.value || (clearable ? null : value))} />
      </label>
    </div>
  );
}
