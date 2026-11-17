import { useEffect, useRef, useState, type ReactNode } from "react";
import { cx } from "./hooks.js";
import { reducedMotion } from "./motion.js";

export interface PageHeaderProps {
  title: ReactNode;
  /** The small line over the title ("Monday evening · 3 to use soon"). */
  eyebrow?: ReactNode;
  /** A drawing at the header's end. */
  art?: ReactNode;
  /** Buttons at the header's end (week arrows). */
  actions?: ReactNode;
  /** What the slim bar shows once the big header has scrolled away (left out: the title and actions). */
  compactTitle?: ReactNode;
  compactActions?: ReactNode;
  /** Tapping the slim bar's title scrolls back to the top (on by default). */
  tapToTop?: boolean;
  className?: string;
}

/**
 * A screen's big header, and a slim sticky bar that slides down with the title (and the key
 * actions) once the big one has scrolled out of sight, so you always know where you are.
 * Tapping the bar's title takes you back to the top.
 */
export function PageHeader({ title, eyebrow, art, actions, compactTitle, compactActions, tapToTop = true, className }: PageHeaderProps) {
  const big = useRef<HTMLElement>(null);
  const [stuck, setStuck] = useState(false);
  useEffect(() => {
    const el = big.current;
    if (!el || typeof IntersectionObserver === "undefined") return;
    // Shown once the title has gone up under where the slim bar sits (its 56px).
    const io = new IntersectionObserver(([e]) => setStuck(!e.isIntersecting && e.boundingClientRect.top < 0), { threshold: 0, rootMargin: "-56px 0px 0px 0px" });
    // Watch only the title line, not the whole header with its art.
    io.observe(el.querySelector(".ui-page-head__title") ?? el);
    return () => io.disconnect();
  }, []);
  return (
    <>
      <header ref={big} className={cx("ui-page-head", className)}>
        <div className="ui-page-head__text">
          {eyebrow && <p className="ui-page-head__eyebrow">{eyebrow}</p>}
          <h1 className="ui-page-head__title">{title}</h1>
        </div>
        {actions && <div className="ui-page-head__actions">{actions}</div>}
        {art && <span className="ui-page-head__art">{art}</span>}
      </header>
      <div className={cx("ui-compact-head", stuck && "is-shown")} aria-hidden={!stuck} inert={!stuck || undefined}>
        <button type="button" className="ui-compact-head__title" tabIndex={stuck && tapToTop ? 0 : -1} onClick={() => tapToTop && window.scrollTo({ top: 0, behavior: reducedMotion() ? "auto" : "smooth" })} disabled={!tapToTop}>
          {compactTitle ?? title}
        </button>
        {(compactActions ?? actions) && <div className="ui-compact-head__actions">{compactActions ?? actions}</div>}
      </div>
    </>
  );
}
