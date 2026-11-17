import { useId, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { cx } from "./hooks.js";
import { EASE_IN, motion } from "./motion.js";

export interface DisclosureProps {
  summary: ReactNode;
  children: ReactNode;
  defaultOpen?: boolean;
  /** Controlled: pass with onOpenChange. */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  /** link: a quiet underlined line; row: a full-width row with a chevron. */
  variant?: "link" | "row";
  icon?: ReactNode;
  className?: string;
}

/** A section that opens by height instead of jumping, and folds away again. */
export function Disclosure({ summary, children, defaultOpen = false, open: openProp, onOpenChange, variant = "link", icon, className }: DisclosureProps) {
  const [inner, setInner] = useState(defaultOpen);
  const open = openProp ?? inner;
  const [mounted, setMounted] = useState(open);
  const body = useRef<HTMLDivElement>(null);
  const first = useRef(true);
  const opening = useRef(false);
  const id = useId();

  useLayoutEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    if (open) {
      opening.current = true;
      setMounted(true);
      return;
    }
    const el = body.current;
    if (!el) return setMounted(false);
    const a = motion(el, [{ height: `${el.offsetHeight}px`, opacity: 1 }, { height: "0px", opacity: 0 }], { duration: 200, easing: EASE_IN, fill: "forwards" });
    if (!a) return setMounted(false);
    let live = true;
    a.finished.then(
      () => live && setMounted(false),
      () => {},
    );
    return () => {
      live = false;
      a.cancel();
    };
  }, [open]);

  useLayoutEffect(() => {
    const el = body.current;
    if (!opening.current || !mounted || !el) return;
    opening.current = false;
    motion(el, [{ height: "0px", opacity: 0 }, { height: `${el.scrollHeight}px`, opacity: 1 }], { duration: 240 });
  }, [mounted, open]);

  const toggle = () => {
    const next = !open;
    if (openProp === undefined) setInner(next);
    onOpenChange?.(next);
  };

  return (
    <div className={cx("ui-disclosure", `ui-disclosure--${variant}`, open && "is-open", className)}>
      <button type="button" className="ui-disclosure__summary" aria-expanded={open} aria-controls={id} onClick={toggle}>
        {icon}
        <span className="ui-disclosure__label">{summary}</span>
        <svg className="ui-disclosure__chevron" width="18" height="18" viewBox="0 0 24 24" aria-hidden="true">
          <path d="M6 9l6 6 6-6" />
        </svg>
      </button>
      {mounted && (
        <div ref={body} id={id} className="ui-disclosure__body">
          <div className="ui-disclosure__inner">{children}</div>
        </div>
      )}
    </div>
  );
}
