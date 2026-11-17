import { createElement, useLayoutEffect, useReducer, useRef, type ReactNode } from "react";
import { mergePresence, reordered } from "./logic.js";
import { EASE, fold, reducedMotion, unfold } from "./motion.js";

export interface AnimatedListProps<T> {
  items: readonly T[];
  getKey: (item: T) => string | number;
  /** One item's content; the list wraps it in its own <li> (or <div>). */
  children: (item: T, index: number) => ReactNode;
  as?: "ul" | "ol" | "div";
  itemAs?: "li" | "div";
  className?: string;
  itemClassName?: string | ((item: T) => string | undefined);
  /** More changes than this at once (a filter switched) just swap, without animating. */
  maxChanges?: number;
  "aria-label"?: string;
}

interface Committed {
  order: string[];
  current: string[];
  nodes: Map<string, ReactNode>;
  classes: Map<string, string | undefined>;
  tops: Map<string, number>;
}

/**
 * A list whose rows arrive and leave smoothly: new rows unfold, removed rows fold their height
 * away while the rest close up, and when the order changes (a re-sort) rows glide to their new
 * places. A row that's leaving can't be tapped. Reduced motion: rows just appear and go.
 */
export function AnimatedList<T>({ items, getKey, children, as = "ul", itemAs, className, itemClassName, maxChanges = 12, ...aria }: AnimatedListProps<T>) {
  const ref = useRef<HTMLElement>(null);
  const committed = useRef<Committed>({ order: [], current: [], nodes: new Map(), classes: new Map(), tops: new Map() });
  const gone = useRef(new Set<string>());
  const leaving = useRef(new Map<string, Animation>());
  const mounted = useRef(false);
  const [, force] = useReducer((x: number) => x + 1, 0);
  const tag = itemAs ?? (as === "div" ? "div" : "li");

  const current = items.map((it, i) => ({
    key: String(getKey(it)),
    node: children(it, i),
    cls: typeof itemClassName === "function" ? itemClassName(it) : itemClassName,
  }));
  const currentKeys = current.map((c) => c.key);
  const currentSet = new Set(currentKeys);
  const byKey = new Map(current.map((c) => [c.key, c]));
  for (const k of currentKeys) gone.current.delete(k);
  const order = mergePresence(committed.current.order, currentKeys, gone.current);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const prev = committed.current;
    const kids = Array.from(el.children) as HTMLElement[];
    const nodeOf = new Map(kids.map((k) => [k.dataset.uiKey!, k]));
    const tops = new Map(kids.map((k) => [k.dataset.uiKey!, k.offsetTop]));
    const prevCurrent = new Set(prev.current);
    const entering = mounted.current ? currentKeys.filter((k) => !prevCurrent.has(k)) : [];
    const exits = order.filter((k) => !currentSet.has(k) && !leaving.current.has(k));
    const moved = mounted.current && reordered(prev.current, currentKeys);
    const quiet = reducedMotion() || entering.length + exits.length > maxChanges;

    // A row that came back while leaving just stops leaving.
    for (const k of currentKeys) {
      const a = leaving.current.get(k);
      if (a) {
        a.cancel();
        leaving.current.delete(k);
        const n = nodeOf.get(k);
        if (n) n.inert = false;
      }
    }
    if (moved && !quiet) {
      for (const k of currentKeys) {
        if (!prevCurrent.has(k)) continue;
        const was = prev.tops.get(k);
        const now = tops.get(k);
        if (was === undefined || now === undefined || was === now) continue;
        nodeOf.get(k)?.animate([{ transform: `translateY(${was - now}px)` }, { transform: "none" }], { duration: 300, easing: EASE });
      }
      for (const k of entering) nodeOf.get(k)?.animate([{ opacity: 0, transform: "scale(0.98)" }, { opacity: 1, transform: "none" }], { duration: 220, easing: EASE });
    } else if (!quiet) {
      for (const k of entering) {
        const n = nodeOf.get(k);
        if (n) unfold(n);
      }
    }
    for (const k of exits) {
      const n = nodeOf.get(k);
      const a = n && !quiet ? fold(n) : null;
      if (!n || !a) {
        gone.current.add(k);
        continue;
      }
      n.inert = true;
      leaving.current.set(k, a);
      a.finished.then(
        () => {
          leaving.current.delete(k);
          gone.current.add(k);
          force();
        },
        () => undefined,
      );
    }
    const nodes = new Map<string, ReactNode>();
    const classes = new Map<string, string | undefined>();
    for (const k of order) {
      nodes.set(k, byKey.get(k)?.node ?? prev.nodes.get(k));
      classes.set(k, byKey.has(k) ? byKey.get(k)!.cls : prev.classes.get(k));
    }
    committed.current = { order, current: currentKeys, nodes, classes, tops };
    mounted.current = true;
    if (exits.some((k) => gone.current.has(k))) force();
  });

  return createElement(
    as,
    { ref, className, ...aria },
    order.map((k) => {
      const live = byKey.get(k);
      const out = !live;
      return createElement(
        tag,
        { key: k, "data-ui-key": k, className: live ? live.cls : committed.current.classes.get(k), "data-leaving": out || undefined, "aria-hidden": out || undefined },
        live ? live.node : committed.current.nodes.get(k),
      );
    }),
  );
}
