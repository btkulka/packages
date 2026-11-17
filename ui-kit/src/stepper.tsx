import { useEffect, useRef, useState, type ReactNode } from "react";
import { cx, useLatest, useRepeat } from "./hooks.js";
import { clamp, formatAmount, parseAmount, roundTo, stepValue } from "./logic.js";
import { haptic, motion } from "./motion.js";

export interface StepperProps {
  value: number | null;
  onChange: (n: number | null) => void;
  /** Spoken name ("How much"). */
  label: string;
  min?: number;
  max?: number;
  step?: number;
  /** Decimals kept (left out: two). */
  precision?: number;
  /** After the number ("lb", "days", "min"). */
  unit?: ReactNode;
  /** Blank is allowed (null), shown as the placeholder. */
  allowEmpty?: boolean;
  placeholder?: string;
  decrementLabel?: string;
  incrementLabel?: string;
  size?: "sm" | "md";
  disabled?: boolean;
  id?: string;
  className?: string;
}

/**
 * A number without the number keyboard: − and + either side (hold to repeat, faster the longer
 * it's held), arrow keys, and you can still type "1 1/2" in the middle. Steps land on the grid.
 */
export function Stepper({ value, onChange, label, min = 0, max = Number.POSITIVE_INFINITY, step = 1, precision = 2, unit, allowEmpty = false, placeholder = "–", decrementLabel = "Less", incrementLabel = "More", size = "md", disabled, id, className }: StepperProps) {
  const [text, setText] = useState(formatAmount(value, precision));
  const [editing, setEditing] = useState(false);
  const field = useRef<HTMLInputElement>(null);
  const first = useRef(true);
  // Holding a button steps from the newest value even before the parent re-renders.
  const live = useRef(value);
  useEffect(() => {
    live.current = value;
    if (!editing) setText(formatAmount(value, precision));
    if (first.current) first.current = false;
    else if (!editing) motion(field.current, [{ transform: "translateY(-3px)", opacity: 0.55 }, { transform: "none", opacity: 1 }], { duration: 160 });
  }, [value, editing, precision]);

  const o = { step, min, max, precision };
  const bump = useLatest((dir: 1 | -1) => {
    const n = stepValue(live.current, dir, o);
    if (n === live.current) return;
    live.current = n;
    haptic(3);
    onChange(n);
  });
  const dec = useRepeat(() => bump.current(-1), { disabled: disabled || (live.current !== null && live.current <= min) });
  const inc = useRepeat(() => bump.current(1), { disabled: disabled || (live.current !== null && live.current >= max) });

  const commit = () => {
    setEditing(false);
    const n = parseAmount(text);
    if (n === null) {
      if (allowEmpty && !text.trim()) {
        if (value !== null) onChange(null);
      } else setText(formatAmount(value, precision));
      return;
    }
    const c = roundTo(clamp(n, min, max), precision);
    setText(formatAmount(c, precision));
    if (c !== value) onChange(c);
  };

  return (
    <span className={cx("ui-stepper", `ui-stepper--${size}`, disabled && "is-disabled", className)}>
      <button type="button" className="ui-stepper__btn" aria-label={decrementLabel} title={decrementLabel} tabIndex={-1} disabled={disabled || (value !== null && value <= min)} {...dec}>
        <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true">
          <path d="M5 12h14" />
        </svg>
      </button>
      <span className="ui-stepper__value">
        <input
          ref={field}
          id={id}
          className="ui-stepper__input"
          inputMode="decimal"
          autoComplete="off"
          role="spinbutton"
          aria-label={label}
          aria-valuenow={value ?? undefined}
          aria-valuemin={Number.isFinite(min) ? min : undefined}
          aria-valuemax={Number.isFinite(max) ? max : undefined}
          value={text}
          placeholder={placeholder}
          disabled={disabled}
          size={Math.max(2, text.length || placeholder.length)}
          onFocus={(e) => {
            setEditing(true);
            e.currentTarget.select();
          }}
          onChange={(e) => setText(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              e.currentTarget.blur();
            } else if (e.key === "ArrowUp" || e.key === "ArrowDown") {
              e.preventDefault();
              const n = stepValue(parseAmount(text) ?? value, e.key === "ArrowUp" ? 1 : -1, o);
              setText(formatAmount(n, precision));
              live.current = n;
              onChange(n);
            } else if (e.key === "Escape" && editing) {
              setText(formatAmount(value, precision));
            }
          }}
        />
        {unit && <span className="ui-stepper__unit">{unit}</span>}
      </span>
      <button type="button" className="ui-stepper__btn" aria-label={incrementLabel} title={incrementLabel} tabIndex={-1} disabled={disabled || (value !== null && value >= max)} {...inc}>
        <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true">
          <path d="M12 5v14M5 12h14" />
        </svg>
      </button>
    </span>
  );
}
