import { cloneElement, isValidElement, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent, type ReactElement, type ReactNode } from "react";

// The few controls the chat needs, plain enough to fit any app. An app with a
// design system of its own (Benhäus) hands its own in through ClaudeProvider's
// `ui.components`, with the same props.

export interface MenuItem {
  id?: string;
  label?: ReactNode;
  icon?: string;
  checked?: boolean;
  danger?: boolean;
  disabled?: boolean;
  separator?: boolean;
  items?: MenuItem[];
  [k: string]: unknown;
}

export interface ButtonProps {
  variant?: "primary" | "glass" | "quiet";
  size?: "sm" | "md";
  disabled?: boolean;
  onClick?: (e: React.MouseEvent) => void;
  children?: ReactNode;
  className?: string;
  [k: string]: unknown;
}
export interface TooltipProps {
  label?: ReactNode;
  sub?: ReactNode;
  children: ReactNode;
}
export interface MenuProps {
  items: MenuItem[];
  float?: boolean;
  /** Where it opens: its left edge at x (pulled in to fit the window), its top at y (or rising from y when there's no room below). */
  x?: number;
  y?: number;
  width?: number;
  onSelect?: (item: MenuItem, parent?: MenuItem) => void;
  onClose?: (item: MenuItem | null) => void;
}
export interface SegmentedControlProps {
  options: { value: string; label: ReactNode }[];
  value?: string;
  onChange?: (v: string) => void;
  label?: string;
  style?: CSSProperties;
}
export interface SearchFieldProps {
  value?: string;
  placeholder?: string;
  autoFocus?: boolean;
  onChange?: (e: { target: { value: string } }) => void;
  onKeyDown?: (e: ReactKeyboardEvent) => void;
  "aria-label"?: string;
  [k: string]: unknown;
}

export interface Components {
  Button: (p: ButtonProps) => ReactElement | null;
  Tooltip: (p: TooltipProps) => ReactElement | null;
  Menu: (p: MenuProps) => ReactElement | null;
  SegmentedControl: (p: SegmentedControlProps) => ReactElement | null;
  SearchField: (p: SearchFieldProps) => ReactElement | null;
}

export function Button({ variant = "quiet", size = "md", className, children, ...rest }: ButtonProps) {
  return (
    <button type="button" {...rest} className={["ck-btn", `ck-btn--${variant}`, `ck-btn--${size}`, className].filter(Boolean).join(" ")}>
      {children}
    </button>
  );
}

/** The browser's own tooltip: the label (and sub) as the child's title. */
export function Tooltip({ label, sub, children }: TooltipProps) {
  const text = [label, sub].filter((x) => typeof x === "string" && x).join("\n");
  if (!text || !isValidElement(children)) return <>{children}</>;
  return cloneElement(children as ReactElement<{ title?: string }>, { title: text });
}

export function Menu({ items, x = 0, y = 0, width = 240, onSelect, onClose }: MenuProps) {
  const box = useRef<HTMLDivElement>(null);
  const [at, setAt] = useState({ left: x, top: y, ready: false });

  // In the window: pulled in from the right edge, and opening upward when there's no room below.
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    const h = el.offsetHeight;
    const left = Math.max(8, Math.min(x, window.innerWidth - width - 8));
    const top = y + h > window.innerHeight - 8 ? Math.max(8, y - h) : y;
    setAt({ left, top, ready: true });
  }, [x, y, width]);

  useEffect(() => {
    box.current?.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus({ preventScroll: true });
    const key = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      e.stopPropagation();
      onClose?.(null);
    };
    window.addEventListener("keydown", key, true);
    return () => window.removeEventListener("keydown", key, true);
  }, []);

  const pick = (item: MenuItem, parent?: MenuItem) => {
    onSelect?.(item, parent);
    onClose?.(item);
  };
  const row = (item: MenuItem, i: number, parent?: MenuItem): ReactNode => {
    if (item.separator) return <div key={`s${i}`} className="ck-menu__sep" role="separator" />;
    if (item.items)
      return (
        <div key={item.id ?? i} className="ck-menu__group" role="group" aria-label={typeof item.label === "string" ? item.label : undefined}>
          <div className="ck-menu__head">{item.label}</div>
          {item.items.map((sub, j) => row(sub, j, item))}
        </div>
      );
    return (
      <button
        key={item.id ?? i}
        type="button"
        role={item.checked === undefined ? "menuitem" : "menuitemradio"}
        aria-checked={item.checked}
        disabled={item.disabled}
        className={`ck-menu__item${item.danger ? " is-danger" : ""}${parent ? " is-sub" : ""}`}
        onClick={() => pick(item, parent)}
      >
        <span className="ck-menu__check" aria-hidden="true">
          {item.checked ? "✓" : ""}
        </span>
        <span className="ck-menu__label">{item.label}</span>
      </button>
    );
  };
  return (
    <div
      ref={box}
      className="ck-root ck-menu"
      role="menu"
      data-ck-menu=""
      style={{ left: at.left, top: at.top, width, visibility: at.ready ? "visible" : "hidden" }}
      onKeyDown={(e) => {
        if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
        e.preventDefault();
        const all = [...(box.current?.querySelectorAll<HTMLButtonElement>("button:not(:disabled)") ?? [])];
        const i = all.indexOf(document.activeElement as HTMLButtonElement);
        all[(i + (e.key === "ArrowDown" ? 1 : -1) + all.length) % all.length]?.focus();
      }}
    >
      {items.map((it, i) => row(it, i))}
    </div>
  );
}

export function SegmentedControl({ options, value, onChange, label, style }: SegmentedControlProps) {
  return (
    <div className="ck-seg" role="radiogroup" aria-label={label} style={style}>
      {options.map((o) => (
        <button key={o.value} type="button" role="radio" aria-checked={o.value === value} className={`ck-seg__opt${o.value === value ? " is-on" : ""}`} onClick={() => onChange?.(o.value)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function SearchField({ value, placeholder, autoFocus, onChange, onKeyDown, ...rest }: SearchFieldProps) {
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => void (autoFocus && input.current?.focus({ preventScroll: true })), []);
  delete (rest as Record<string, unknown>).shortcut;
  return (
    <span className="ck-search">
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
        <circle cx="11" cy="11" r="6.5" />
        <path d="M20 20l-4.2-4.2" />
      </svg>
      <input ref={input} type="search" {...rest} value={value} placeholder={placeholder} onChange={(e) => onChange?.(e)} onKeyDown={onKeyDown} />
    </span>
  );
}

export const builtIns: Components = { Button, Tooltip, Menu, SegmentedControl, SearchField };

/* ----------------------------------------------------------------- icons */

export const XIcon = ({ size = 14 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
    <path d="M6 6l12 12M18 6L6 18" />
  </svg>
);

export const HistoryIcon = ({ size = 16 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
    <path d="M3 3v5h5M12 7v5l4 2" />
  </svg>
);

export const PlusIcon = ({ size = 16 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
    <path d="M12 5v14M5 12h14" />
  </svg>
);

export const MoreIcon = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
    <circle cx="5" cy="12" r="1.9" />
    <circle cx="12" cy="12" r="1.9" />
    <circle cx="19" cy="12" r="1.9" />
  </svg>
);

export const ChevronDown = () => (
  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M6 9.5l6 6 6-6" />
  </svg>
);

/** Claude's mark (its starburst), in its own orange unless given a color. */
export function ClaudeMark({ size = 20, style, className }: { size?: number; style?: CSSProperties; className?: string }) {
  return (
    <svg className={["ck-mark", className].filter(Boolean).join(" ")} width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" style={style}>
      <path
        fill="currentColor"
        d="m4.7144 15.9555 4.7174-2.6471.079-.2307-.079-.1275h-.2307l-.7893-.0486-2.6956-.0729-2.3375-.0971-2.2646-.1214-.5707-.1215-.5343-.7042.0546-.3522.4797-.3218.686.0608 1.5179.1032 2.2767.1578 1.6514.0972 2.4468.255h.3886l.0546-.1579-.1336-.0971-.1032-.0972L6.973 9.8356l-2.55-1.6879-1.3356-.9714-.7225-.4918-.3643-.4614-.1578-1.0078.6557-.7225.8803.0607.2246.0607.8925.686 1.9064 1.4754 2.4893 1.8336.3643.3035.1457-.1032.0182-.0728-.164-.2733-1.3539-2.4467-1.445-2.4893-.6435-1.032-.17-.6194c-.0607-.255-.1032-.4674-.1032-.7285L6.287.1335 6.6997 0l.9957.1336.419.3642.6192 1.4147 1.0018 2.2282 1.5543 3.0296.4553.8985.2429.8318.091.255h.1579v-.1457l.1275-1.706.2368-2.0947.2307-2.6957.0789-.7589.3764-.9107.7468-.4918.5828.2793.4797.686-.0668.4433-.2853 1.8517-.5586 2.9021-.3643 1.9429h.2125l.2429-.2429.9835-1.3053 1.6514-2.0643.7286-.8196.85-.9046.5464-.4311h1.0321l.759 1.1293-.34 1.1657-1.0625 1.3478-.8804 1.1414-1.2628 1.7-.7893 1.36.0729.1093.1882-.0183 2.8535-.607 1.5421-.2794 1.8396-.3157.8318.3886.091.3946-.3278.8075-1.967.4857-2.3072.4614-3.4364.8136-.0425.0304.0486.0607 1.5482.1457.6618.0364h1.621l3.0175.2247.7892.522.4736.6376-.079.4857-1.2142.6193-1.6393-.3886-3.825-.9107-1.3113-.3279h-.1822v.1093l1.0929 1.0686 2.0035 1.8092 2.5075 2.3314.1275.5768-.3218.4554-.34-.0486-2.2039-1.6575-.85-.7468-1.9246-1.621h-.1275v.17l.4432.6496 2.3436 3.5214.1214 1.0807-.17.3521-.6071.2125-.6679-.1214-1.3721-1.9246L14.38 17.959l-1.1414-1.9428-.1397.079-.674 7.2552-.3156.3703-.7286.2793-.6071-.4614-.3218-.7468.3218-1.4753.3886-1.9246.3157-1.53.2853-1.9004.17-.6314-.0121-.0425-.1397.0182-1.4328 1.9672-2.1796 2.9446-1.7243 1.8456-.4128.164-.7164-.3704.0667-.6618.4008-.5889 2.386-3.0357 1.4389-1.882.929-1.0868-.0062-.1579h-.0546l-6.3385 4.1164-1.1293.1457-.4857-.4554.0608-.7467.2307-.2429 1.9064-1.3114Z"
      />
    </svg>
  );
}

export const ImageIcon = ({ size = 16 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <rect x="3.5" y="4.5" width="17" height="15" rx="3" />
    <circle cx="9" cy="10" r="1.6" />
    <path d="M20.5 15.5l-4.5-4.5-8.5 8.5" />
  </svg>
);

export const DownloadIcon = ({ size = 14 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M12 4v11M7 10l5 5 5-5M5 20h14" />
  </svg>
);
