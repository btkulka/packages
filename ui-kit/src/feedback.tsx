import type { CSSProperties, ElementType, HTMLAttributes, KeyboardEvent as ReactKeyboardEvent, ReactNode } from "react";
import { cx } from "./hooks.js";
import { hueFor, initials } from "./logic.js";

export type Tone = "neutral" | "accent" | "good" | "warn" | "danger";

/** The little turning ring: in a button while it works, or beside a word. */
export function Spinner({ size = 16, label, className }: { size?: number; label?: ReactNode; className?: string }) {
  return (
    <span className={cx("ui-spinner", className)} role="status" aria-live="polite">
      <span className="ui-spinner__ring" style={{ width: size, height: size }} aria-hidden="true" />
      {label && <span className="ui-spinner__label">{label}</span>}
      {!label && <span className="ui-sr-only">Working…</span>}
    </span>
  );
}

/** Warm placeholder rows that hold a list's place while it loads. */
export function Skeleton({ rows = 4, className, label = "Loading" }: { rows?: number; className?: string; label?: string }) {
  return (
    <div className={cx("ui-skeleton", className)} role="status" aria-label={label}>
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="ui-skeleton__row" style={{ animationDelay: `${i * 90}ms` }}>
          <span className="ui-skeleton__dot" />
          <span className="ui-skeleton__lines">
            <span style={{ width: `${62 - ((i * 17) % 30)}%` }} />
            <span style={{ width: `${34 + ((i * 11) % 20)}%` }} />
          </span>
          <span className="ui-skeleton__pill" />
        </div>
      ))}
    </div>
  );
}

/** A line of news across a screen, optionally tappable ("Review", "Plan one"). */
export function Banner({ tone = "good", icon, children, action, onClick, className }: { tone?: Tone; icon?: ReactNode; children: ReactNode; action?: ReactNode; onClick?: () => void; className?: string }) {
  const body = (
    <>
      {icon && <span className="ui-banner__icon">{icon}</span>}
      <span className="ui-banner__text">{children}</span>
      {action && <span className="ui-banner__action">{action}</span>}
    </>
  );
  return onClick ? (
    <button type="button" className={cx("ui-banner", `ui-tone-${tone}`, "is-button", className)} onClick={onClick}>
      {body}
    </button>
  ) : (
    <div className={cx("ui-banner", `ui-tone-${tone}`, className)}>{body}</div>
  );
}

/** A small rounded label: "AI", "uses spinach", "no meal planned". */
export function Tag({ tone = "neutral", icon, children, className, title }: { tone?: Tone; icon?: ReactNode; children: ReactNode; className?: string; title?: string }) {
  return (
    <span className={cx("ui-tag", `ui-tone-${tone}`, className)} title={title}>
      {icon}
      {children}
    </span>
  );
}

/** What a screen shows when there's nothing in it yet, with a drawing and a next step. */
export function EmptyState({ icon, title, children, action, className }: { icon?: ReactNode; title: ReactNode; children?: ReactNode; action?: ReactNode; className?: string }) {
  return (
    <div className={cx("ui-empty", className)}>
      {icon && <span className="ui-empty__icon">{icon}</span>}
      <strong className="ui-empty__title">{title}</strong>
      {children && <p className="ui-empty__text">{children}</p>}
      {action}
    </div>
  );
}

/** A person: their picture, or their initials on a colour that's always theirs. */
export function Avatar({ name, src, size = 28, className, title }: { name: string; src?: string | null; size?: number; className?: string; title?: string }) {
  const style = { width: size, height: size, fontSize: Math.max(10, Math.round(size * 0.4)), "--ui-avatar-hue": String(hueFor(name)) } as CSSProperties;
  return (
    <span className={cx("ui-avatar", className)} style={style} title={title ?? name} role="img" aria-label={name}>
      {src ? <img src={src} alt="" width={size} height={size} loading="lazy" referrerPolicy="no-referrer" /> : initials(name)}
    </span>
  );
}

/** A row in a list: something at its start, a title over a line of detail, something at its end. */
export function Row({
  as: As = "div",
  leading,
  title,
  subtitle,
  trailing,
  onClick,
  className,
  ...rest
}: { as?: ElementType; leading?: ReactNode; title: ReactNode; subtitle?: ReactNode; trailing?: ReactNode; onClick?: () => void; className?: string } & Omit<HTMLAttributes<HTMLElement>, "title" | "onClick">) {
  const interactive = !!onClick;
  return (
    <As
      className={cx("ui-row", interactive && "is-interactive", className)}
      onClick={onClick}
      role={interactive && As !== "button" ? "button" : undefined}
      tabIndex={interactive && As !== "button" ? 0 : undefined}
      onKeyDown={
        interactive
          ? (e: ReactKeyboardEvent) => {
              if ((e.key === "Enter" || e.key === " ") && e.target === e.currentTarget) {
                e.preventDefault();
                onClick?.();
              }
            }
          : undefined
      }
      {...rest}
    >
      {leading && <span className="ui-row__leading">{leading}</span>}
      <span className="ui-row__main">
        <span className="ui-row__title">{title}</span>
        {subtitle && <span className="ui-row__sub">{subtitle}</span>}
      </span>
      {trailing && <span className="ui-row__trailing">{trailing}</span>}
    </As>
  );
}
