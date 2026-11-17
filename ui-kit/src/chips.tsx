import { forwardRef, useRef, useState, type ButtonHTMLAttributes, type ReactNode } from "react";
import { cx } from "./hooks.js";
import { haptic } from "./motion.js";

const Tick = () => (
  <svg className="ui-chip__tick" width="15" height="15" viewBox="0 0 24 24" aria-hidden="true">
    <path d="M5 12.5l4.5 4.5L19 7.5" />
  </svg>
);

export interface ChipProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  /** A toggle chip: lit and ticked when pressed (aria-pressed). Leave out for a plain chip. */
  pressed?: boolean;
  icon?: ReactNode;
  count?: ReactNode;
  /** A word that floats up from the tap ("+1"), for chips that add something. */
  pop?: string;
  size?: "sm" | "md";
}

/** A round chip: a filter, a toggle, or a quick add. */
export const Chip = forwardRef<HTMLButtonElement, ChipProps>(function Chip({ pressed, icon, count, pop, size = "md", className, children, onClick, type = "button", ...rest }, ref) {
  const [pops, setPops] = useState<{ id: number; x: number }[]>([]);
  const next = useRef(1);
  const toggle = pressed !== undefined;
  return (
    <button
      ref={ref}
      type={type}
      aria-pressed={toggle ? pressed : undefined}
      className={cx("ui-chip", `ui-chip--${size}`, toggle && "ui-chip--toggle", pressed && "is-on", className)}
      onClick={(e) => {
        if (pop) {
          const r = e.currentTarget.getBoundingClientRect();
          const x = e.clientX ? e.clientX - r.left : r.width / 2;
          const id = next.current++;
          setPops((p) => [...p, { id, x }]);
          setTimeout(() => setPops((p) => p.filter((q) => q.id !== id)), 700);
          haptic(6);
        }
        onClick?.(e);
      }}
      {...rest}
    >
      {toggle && !icon && <Tick />}
      {icon}
      {children}
      {count !== undefined && <span className="ui-chip__count">{count}</span>}
      {pops.map((p) => (
        <span key={p.id} className="ui-chip__pop" style={{ left: p.x }} aria-hidden="true">
          {pop}
        </span>
      ))}
    </button>
  );
});

/** A chip with an × that takes it away (a staple, a tag). */
export function RemovableChip({ children, onRemove, removeLabel, icon, className }: { children: ReactNode; onRemove: () => void; removeLabel: string; icon?: ReactNode; className?: string }) {
  return (
    <span className={cx("ui-chip", "ui-chip--removable", className)}>
      {icon}
      <span className="ui-chip__text">{children}</span>
      <button type="button" className="ui-chip__x" aria-label={removeLabel} title={removeLabel} onClick={onRemove}>
        <svg width="12" height="12" viewBox="0 0 24 24" aria-hidden="true">
          <path d="M6 6l12 12M18 6 6 18" />
        </svg>
      </button>
    </span>
  );
}
