import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { cx } from "./hooks.js";
import { haptic } from "./motion.js";

export interface CheckProps {
  checked: boolean;
  onChange: (next: boolean) => void;
  /** What checking it means, for screen readers ("Used up spinach"). */
  label: string;
  size?: number;
  tone?: "good" | "accent";
  disabled?: boolean;
  /** Keep the click from reaching a tappable row underneath (on by default). */
  isolate?: boolean;
  className?: string;
}

/** The round checkbox: the tick draws itself and the circle fills; a 44px target around a 30px circle. */
export function Check({ checked, onChange, label, size = 30, tone = "good", disabled, isolate = true, className }: CheckProps) {
  const [pop, setPop] = useState(false);
  useEffect(() => {
    if (!pop) return;
    const t = setTimeout(() => setPop(false), 320);
    return () => clearTimeout(t);
  }, [pop]);
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      className={cx("ui-check", `ui-tone-${tone}`, checked && "is-on", pop && "is-popping", className)}
      style={{ "--ui-check-size": `${size}px` } as CSSProperties}
      onClick={(e) => {
        if (isolate) e.stopPropagation();
        if (!checked) {
          setPop(true);
          haptic(8);
        }
        onChange(!checked);
      }}
      onPointerDown={isolate ? (e) => e.stopPropagation() : undefined}
    >
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="M5 12.5l4.5 4.5L19 7.5" pathLength={1} />
      </svg>
    </button>
  );
}

export interface SwitchProps {
  checked: boolean;
  onChange: (next: boolean) => void;
  label: string;
  disabled?: boolean;
  className?: string;
}

/** An on/off switch whose thumb slides and squishes while pressed. */
export function Switch({ checked, onChange, label, disabled, className }: SwitchProps) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      className={cx("ui-switch", checked && "is-on", className)}
      onClick={(e) => {
        e.stopPropagation();
        haptic(6);
        onChange(!checked);
      }}
    >
      <span className="ui-switch__thumb" aria-hidden="true" />
    </button>
  );
}

export interface SwitchRowProps {
  checked: boolean;
  onChange: (next: boolean) => void;
  title: ReactNode;
  description?: ReactNode;
  icon?: ReactNode;
  disabled?: boolean;
  /** good: a tinted card (a choice in a sheet); plain: a bare row (a setting in a card). */
  variant?: "good" | "plain";
  className?: string;
}

/** A setting as one big target: the whole row flips the switch at its end. */
export function SwitchRow({ checked, onChange, title, description, icon, disabled, variant = "good", className }: SwitchRowProps) {
  const ref = useRef<HTMLButtonElement>(null);
  return (
    <button
      ref={ref}
      type="button"
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      className={cx("ui-switch-row", `ui-switch-row--${variant}`, checked && "is-on", className)}
      onClick={() => {
        haptic(6);
        onChange(!checked);
      }}
    >
      {icon && <span className="ui-switch-row__icon">{icon}</span>}
      <span className="ui-switch-row__text">
        <strong>{title}</strong>
        {description && <span>{description}</span>}
      </span>
      <span className={cx("ui-switch", checked && "is-on")} aria-hidden="true">
        <span className="ui-switch__thumb" />
      </span>
    </button>
  );
}
