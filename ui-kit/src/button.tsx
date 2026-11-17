import { forwardRef, useEffect, useLayoutEffect, useRef, useState, type ButtonHTMLAttributes, type CSSProperties, type ReactNode } from "react";
import { Spinner } from "./feedback.js";
import { cx, mergeRefs } from "./hooks.js";
import { haptic } from "./motion.js";

export type ButtonVariant = "primary" | "secondary" | "quiet" | "danger" | "good";
export type ButtonSize = "sm" | "md" | "lg";

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** Full width. */
  block?: boolean;
  /** Shown before the label; a spinner takes its place while busy. */
  icon?: ReactNode;
  /** Working: disabled, a spinner in place of the icon, and the button keeps its width. */
  busy?: boolean;
  /** What the label says while busy (left out: the label stays). */
  busyLabel?: ReactNode;
}

/** The kit's button: sinks a little when pressed, and holds its width while it works. */
export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button({ variant = "secondary", size = "md", block, icon, busy, busyLabel, className, children, disabled, type = "button", style, ...rest }, ref) {
  const own = useRef<HTMLButtonElement | null>(null);
  const width = useRef<number | null>(null);
  // Remember the width it had before it got busy, so the spinner doesn't make it jump.
  useLayoutEffect(() => {
    if (!busy && own.current) width.current = own.current.offsetWidth;
  });
  return (
    <button
      ref={mergeRefs(ref, own)}
      type={type}
      className={cx("ui-btn", `ui-btn--${variant}`, `ui-btn--${size}`, block && "ui-btn--block", busy && "is-busy", !children && "ui-btn--icon-only", className)}
      disabled={disabled || busy}
      aria-busy={busy || undefined}
      style={busy && width.current ? { minWidth: width.current, ...style } : style}
      {...rest}
    >
      {busy ? <Spinner size={size === "sm" ? 14 : 16} /> : icon && <span className="ui-btn__icon">{icon}</span>}
      {busy && busyLabel !== undefined ? busyLabel : children}
    </button>
  );
});

export interface IconButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "children"> {
  /** Said by screen readers and shown as a tooltip. */
  label: string;
  icon: ReactNode;
  variant?: "plain" | "soft" | "solid";
  size?: ButtonSize;
  busy?: boolean;
}

/** A round button with only an icon; it still has a name. */
export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton({ label, icon, variant = "plain", size = "md", busy, className, type = "button", disabled, ...rest }, ref) {
  return (
    <button ref={ref} type={type} aria-label={label} title={label} className={cx("ui-icon-btn", `ui-icon-btn--${variant}`, `ui-icon-btn--${size}`, className)} disabled={disabled || busy} aria-busy={busy || undefined} {...rest}>
      {busy ? <Spinner size={16} /> : icon}
    </button>
  );
});

export interface ConfirmButtonProps extends Omit<ButtonProps, "onClick" | "variant"> {
  /** What the button says once armed ("Delete?"). */
  confirmLabel: ReactNode;
  onConfirm: () => void;
  /** How long it stays armed. */
  timeoutMs?: number;
  /** Before arming: quiet (a word) or secondary (a button). */
  variant?: "quiet" | "secondary";
}

/**
 * A destructive button that asks first, without a dialog: the first tap arms it ("Delete?",
 * filled, with a bar draining for three seconds); a second tap does it. Leaving it, or Escape,
 * disarms it.
 */
export function ConfirmButton({ confirmLabel, onConfirm, timeoutMs = 3000, variant = "quiet", children, className, onBlur, onKeyDown, style, ...rest }: ConfirmButtonProps) {
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    if (!armed) return;
    const t = setTimeout(() => setArmed(false), timeoutMs);
    return () => clearTimeout(t);
  }, [armed, timeoutMs]);
  return (
    <Button
      {...rest}
      variant={armed ? "danger" : variant}
      className={cx("ui-confirm", armed && "is-armed", !armed && !children && "ui-btn--icon-only", className)}
      style={{ ...style, "--ui-confirm-ms": `${timeoutMs}ms` } as CSSProperties}
      aria-live="polite"
      onClick={(e) => {
        e.stopPropagation();
        if (armed) {
          setArmed(false);
          haptic([6, 40, 10]);
          onConfirm();
        } else {
          setArmed(true);
          haptic(6);
        }
      }}
      onBlur={(e) => {
        setArmed(false);
        onBlur?.(e);
      }}
      onKeyDown={(e) => {
        if (armed && e.key === "Escape") {
          e.preventDefault();
          e.stopPropagation();
          setArmed(false);
        }
        onKeyDown?.(e);
      }}
    >
      {armed ? confirmLabel : children}
      {armed && <span className="ui-confirm__bar" aria-hidden="true" />}
    </Button>
  );
}
