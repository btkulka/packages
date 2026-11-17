import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type Context, type ReactNode } from "react";
import { cx, useLatest } from "./hooks.js";
import { haptic, motion } from "./motion.js";

/** Pointer capture, when the browser has that pointer (a synthetic or stale one throws; the drag still works). */
function capture(el: Element, id: number): void {
  try {
    el.setPointerCapture(id);
  } catch {
    /* no such pointer: follow it without capture */
  }
}

export interface ToastAction {
  label: string;
  onAction: () => void;
}
export interface ToastOptions {
  action?: ToastAction;
  tone?: "default" | "error" | "good";
  /** How long it stays (left out: 7s with an action, 6s for an error, else 4s). */
  duration?: number;
  icon?: ReactNode;
}
interface ToastItem extends ToastOptions {
  key: number;
  text: ReactNode;
  leaving: boolean;
}
export interface ToastApi {
  show: (text: ReactNode, o?: ToastOptions) => number;
  dismiss: (key: number) => void;
}

const KEY = Symbol.for("@btkulka/ui-kit/toasts");
const Ctx: Context<ToastApi | null> = ((globalThis as Record<symbol, unknown>)[KEY] as Context<ToastApi | null> | undefined) ?? ((globalThis as Record<symbol, unknown>)[KEY] = createContext<ToastApi | null>(null)) as Context<ToastApi | null>;

/** The toasts for everything under it: `useToasts().show("Spinach used up", { action: { label: "Undo", onAction } })`. */
export function ToastProvider({ children, max = 3, label = "Notifications", className }: { children: ReactNode; max?: number; label?: string; className?: string }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const next = useRef(1);
  const dismiss = useCallback((key: number) => {
    setItems((ts) => ts.map((t) => (t.key === key ? { ...t, leaving: true } : t)));
    setTimeout(() => setItems((ts) => ts.filter((t) => t.key !== key)), 260);
  }, []);
  const show = useCallback(
    (text: ReactNode, o: ToastOptions = {}) => {
      const key = next.current++;
      setItems((ts) => {
        const live = ts.filter((t) => !t.leaving);
        const extra = live.length + 1 - max;
        const drop = new Set(live.slice(0, Math.max(0, extra)).map((t) => t.key));
        if (drop.size) setTimeout(() => setItems((xs) => xs.filter((t) => !drop.has(t.key))), 260);
        return [...ts.map((t) => (drop.has(t.key) ? { ...t, leaving: true } : t)), { ...o, key, text, leaving: false }];
      });
      if (o.tone === "error") haptic([10, 60, 10]);
      return key;
    },
    [max],
  );
  const api = useMemo(() => ({ show, dismiss }), [show, dismiss]);
  return (
    <Ctx.Provider value={api}>
      {children}
      <section className={cx("ui-toasts", className)} aria-label={label} aria-live="polite">
        {items.map((t) => (
          <ToastView key={t.key} item={t} onDismiss={() => dismiss(t.key)} />
        ))}
      </section>
    </Ctx.Provider>
  );
}

export function useToasts(): ToastApi {
  const c = useContext(Ctx);
  if (!c) throw new Error("useToasts needs a <ToastProvider> above it.");
  return c;
}

function ToastView({ item, onDismiss }: { item: ToastItem; onDismiss: () => void }) {
  const duration = item.duration ?? (item.action ? 7000 : item.tone === "error" ? 6000 : 4000);
  const [paused, setPaused] = useState(false);
  const el = useRef<HTMLDivElement>(null);
  const left = useRef(duration);
  const since = useRef(Date.now());
  const bye = useLatest(onDismiss);
  const drag = useRef<{ x0: number; dx: number; id: number; t0: number } | null>(null);

  // The clock runs only while nobody's touching, hovering or focused on the toast.
  useEffect(() => {
    if (paused || item.leaving) return;
    since.current = Date.now();
    const t = setTimeout(() => bye.current(), left.current);
    return () => {
      clearTimeout(t);
      left.current = Math.max(400, left.current - (Date.now() - since.current));
    };
  }, [paused, item.leaving, bye]);

  return (
    <div className={cx("ui-toast-slot", item.leaving && "is-leaving")}>
      <div
        ref={el}
        role={item.tone === "error" ? "alert" : "status"}
        className={cx("ui-toast", item.tone && `ui-toast--${item.tone}`, paused && "is-paused")}
        onPointerEnter={(e) => e.pointerType === "mouse" && setPaused(true)}
        onPointerLeave={(e) => e.pointerType === "mouse" && setPaused(false)}
        onFocus={() => setPaused(true)}
        onBlur={() => setPaused(false)}
        onPointerDown={(e) => {
          if ((e.target as HTMLElement).closest("button")) return;
          setPaused(true);
          drag.current = { x0: e.clientX, dx: 0, id: e.pointerId, t0: e.timeStamp };
          capture(e.currentTarget, e.pointerId);
        }}
        onPointerMove={(e) => {
          const d = drag.current;
          if (!d || d.id !== e.pointerId) return;
          d.dx = e.clientX - d.x0;
          e.currentTarget.style.transform = `translateX(${d.dx}px)`;
          e.currentTarget.style.opacity = String(Math.max(0.2, 1 - Math.abs(d.dx) / 260));
        }}
        onPointerUp={(e) => {
          const d = drag.current;
          drag.current = null;
          if (!d) return;
          const node = e.currentTarget;
          const v = d.dx / Math.max(1, e.timeStamp - d.t0);
          if (Math.abs(d.dx) > 90 || (Math.abs(v) > 0.6 && Math.abs(d.dx) > 24)) {
            const a = motion(node, [{ transform: node.style.transform, opacity: node.style.opacity }, { transform: `translateX(${Math.sign(d.dx) * 420}px)`, opacity: 0 }], { duration: 180, fill: "forwards" });
            if (a) a.finished.then(() => bye.current(), () => bye.current());
            else bye.current();
            return;
          }
          const from = node.style.transform;
          node.style.transform = "";
          node.style.opacity = "";
          motion(node, [{ transform: from || "none" }, { transform: "none" }], { duration: 220 });
          if (e.pointerType !== "mouse") setPaused(false);
        }}
        onPointerCancel={(e) => {
          drag.current = null;
          e.currentTarget.style.transform = "";
          e.currentTarget.style.opacity = "";
          setPaused(false);
        }}
      >
        {item.icon && <span className="ui-toast__icon">{item.icon}</span>}
        <span className="ui-toast__text">{item.text}</span>
        {item.action && (
          <button
            type="button"
            className="ui-toast__action"
            onClick={() => {
              haptic(6);
              bye.current();
              item.action!.onAction();
            }}
          >
            {item.action.label}
          </button>
        )}
        {item.action && <span className="ui-toast__timer" style={{ animationDuration: `${duration}ms` }} aria-hidden="true" />}
      </div>
    </div>
  );
}
