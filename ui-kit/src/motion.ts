// Motion that settles and never bounces: one easing for things arriving, one for things leaving,
// and nothing at all when the person asked for reduced motion.

/** Things arriving or settling: quick start, long soft landing, no overshoot. */
export const EASE = "cubic-bezier(0.2, 0.8, 0.2, 1)";
/** Things leaving: slow start, quick finish. */
export const EASE_IN = "cubic-bezier(0.4, 0, 1, 1)";

export const DURATION = { press: 120, quick: 160, settle: 240, sheet: 280 } as const;

export function reducedMotion(): boolean {
  return typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/** A light tap where the device can (Android vibrates; iOS ignores it). */
export function haptic(pattern: number | number[] = 8): void {
  try {
    if (typeof navigator !== "undefined" && typeof navigator.vibrate === "function") navigator.vibrate(pattern);
  } catch {
    /* not allowed here (an iframe without permission): fine */
  }
}

/** `el.animate` when motion is welcome; null when it isn't, or the browser can't. */
export function motion(el: Element | null | undefined, keyframes: Keyframe[], options: KeyframeAnimationOptions): Animation | null {
  if (!el || reducedMotion() || typeof (el as HTMLElement).animate !== "function") return null;
  return el.animate(keyframes, { easing: EASE, ...options });
}

/** Resolves when the animation ends either way, or right away when there wasn't one. */
export function settled(a: Animation | null): Promise<void> {
  if (!a) return Promise.resolve();
  return a.finished.then(
    () => undefined,
    () => undefined,
  );
}

/** Whether the wide (desktop) layout is showing: sheets are centred panels there, not bottom sheets. */
export function wideLayout(): boolean {
  return typeof matchMedia === "function" && matchMedia("(min-width: 900px)").matches;
}

/** The box-model properties an expand or collapse animates, read from the element as it stands. */
function boxOf(el: HTMLElement): Keyframe {
  const cs = getComputedStyle(el);
  return {
    height: `${el.offsetHeight}px`,
    minHeight: cs.minHeight,
    paddingTop: cs.paddingTop,
    paddingBottom: cs.paddingBottom,
    marginTop: cs.marginTop,
    marginBottom: cs.marginBottom,
    borderTopWidth: cs.borderTopWidth,
    borderBottomWidth: cs.borderBottomWidth,
    opacity: 1,
  };
}

const FOLDED: Keyframe = { height: "0px", minHeight: "0px", paddingTop: "0px", paddingBottom: "0px", marginTop: "0px", marginBottom: "0px", borderTopWidth: "0px", borderBottomWidth: "0px", opacity: 0 };

/** Unfolds an element from nothing to its height. */
export function unfold(el: HTMLElement, duration: number = DURATION.settle): Animation | null {
  const full = boxOf(el);
  return motion(el, [{ ...FOLDED, overflow: "hidden" }, { ...full, overflow: "hidden" }], { duration });
}

/** Folds an element's height away, and holds it folded until it's removed. */
export function fold(el: HTMLElement, duration = 220): Animation | null {
  const full = boxOf(el);
  return motion(el, [{ ...full, overflow: "hidden" }, { ...FOLDED, overflow: "hidden" }], { duration, easing: EASE_IN, fill: "forwards" });
}
