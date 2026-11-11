import { useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useUi } from "./context.js";
import type { MenuItem } from "./primitives.js";

/**
 * A button and the menu it opens, which closes on a click outside it, a resize or the window losing focus. The
 * menu hangs under the button, lined up with its right edge, or (`above`) rises from its left: the composer's mode on a phone.
 */
export function MenuButton({
  items,
  onSelect,
  label,
  tip,
  className,
  above,
  children,
}: {
  items: () => MenuItem[];
  onSelect: (item: MenuItem) => void;
  label: string;
  tip?: string;
  className: string;
  above?: boolean;
  children: ReactNode;
}) {
  const ui = useUi();
  const { Menu, Tooltip } = ui.c;
  const [at, setAt] = useState<{ x: number; y: number } | null>(null);
  const btn = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!at) return;
    const down = (e: PointerEvent) => {
      const t = (e.composedPath?.()[0] ?? e.target) as Element;
      if (!t.closest?.("[data-ck-menu], [data-bh-menu]") && !btn.current?.contains(t)) setAt(null);
    };
    const close = () => setAt(null);
    document.addEventListener("pointerdown", down, true);
    window.addEventListener("resize", close);
    window.addEventListener("blur", close);
    return () => {
      document.removeEventListener("pointerdown", down, true);
      window.removeEventListener("resize", close);
      window.removeEventListener("blur", close);
    };
  }, [at]);

  const toggle = () => {
    const r = btn.current?.getBoundingClientRect();
    // Above: the menu is placed at the button's top and, with no room below it there, opens upward from it.
    setAt(at || !r ? null : above ? { x: r.left, y: r.top - 6 } : { x: r.right - 240, y: r.bottom + 6 });
  };
  const button = (
    <button ref={btn} type="button" className={className} aria-label={label} aria-haspopup="menu" aria-expanded={!!at} onClick={toggle}>
      {children}
    </button>
  );

  return (
    <>
      {tip ? <Tooltip label={tip}>{button}</Tooltip> : button}
      {at &&
        createPortal(
          <Menu
            float
            x={at.x}
            y={at.y}
            width={240}
            items={items()}
            onSelect={onSelect}
            onClose={() => {
              setAt(null);
              btn.current?.focus({ preventScroll: true });
            }}
          />,
          ui.portal(),
        )}
    </>
  );
}
