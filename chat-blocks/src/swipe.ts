// A lightbox's ← and → by swiping: a finger on a phone, a mouse drag or a trackpad's two-finger swipe on a
// desktop. Pointer events, so one set of listeners serves touch, pen and mouse. A drag that turns out to be
// a swipe swallows the click it ends in (a picture that zooms on a click doesn't zoom), a vertical drag is
// left to scroll the page, and a `follow` element slides with the pointer and springs back. No imports, so
// it rides in the bridge's script (window.ChatBlocks.swipe) as well as in a bundle.

export interface SwipeOptions {
  /** 1 for a swipe to the left (the next one), -1 to the right (the previous one). */
  onSwipe(dir: 1 | -1): void;
  /** Pointers that start where this says true are left alone (a 3D view that turns on a drag, a video's controls). */
  ignore?: (e: PointerEvent) => boolean;
  /** Whether there's anywhere to go right now (one page, or a picture zoomed to 1:1 that pans): false lets drags and wheels be. */
  enabled?: () => boolean;
  /** Slides with the drag and springs back. */
  follow?: HTMLElement | null;
  /** How far a slow drag has to go, in px. Default 56; a quick flick needs less. */
  distance?: number;
  /** A trackpad's sideways swipe (horizontal wheel) steps too. Default true. */
  wheel?: boolean;
}

/** Listens for swipes on `el`; gives back the call that stops listening. */
export function swipe(el: HTMLElement, o: SwipeOptions): () => void {
  const min = o.distance ?? 56;
  const can = () => !o.enabled || o.enabled();
  let s: { id: number; x: number; y: number; t: number; on: boolean; mouse: boolean } | undefined;
  const touchAction = el.style.touchAction;
  if (!touchAction) el.style.touchAction = "pan-y pinch-zoom";

  const slide = (dx: number) => {
    const f = o.follow;
    if (!f) return;
    f.style.transition = dx ? "none" : "transform 180ms cubic-bezier(0.2, 0, 0, 1)";
    f.style.transform = dx ? `translateX(${dx}px)` : "";
  };
  // The click a swiping drag ends in (the browser sends one after a mouse's pointerup) isn't a click.
  const eatClick = () => {
    const eat = (c: MouseEvent) => {
      c.stopPropagation();
      c.preventDefault();
    };
    window.addEventListener("click", eat, { capture: true, once: true });
    setTimeout(() => window.removeEventListener("click", eat, true), 320);
  };

  const down = (e: PointerEvent) => {
    if (s || !e.isPrimary || !can()) return;
    if (e.pointerType === "mouse" && (e.button !== 0 || e.ctrlKey || e.metaKey || e.shiftKey || e.altKey)) return;
    if (o.ignore?.(e)) return;
    s = { id: e.pointerId, x: e.clientX, y: e.clientY, t: e.timeStamp, on: false, mouse: e.pointerType === "mouse" };
  };
  const move = (e: PointerEvent) => {
    if (!s || e.pointerId !== s.id) return;
    const dx = e.clientX - s.x;
    const dy = e.clientY - s.y;
    if (!s.on) {
      // Up or down first: a scroll, not a swipe.
      if (Math.abs(dy) > 12 && Math.abs(dy) >= Math.abs(dx)) return void (s = undefined);
      if (Math.abs(dx) < 10 || Math.abs(dx) < Math.abs(dy) * 1.5) return;
      s.on = true;
      try {
        el.setPointerCapture(e.pointerId);
      } catch {}
    }
    if (s.mouse) e.preventDefault();
    slide(dx);
  };
  const up = (e: PointerEvent) => {
    if (!s || e.pointerId !== s.id) return;
    const was = s;
    s = undefined;
    if (!was.on) return;
    slide(0);
    eatClick();
    const dx = e.clientX - was.x;
    const speed = Math.abs(dx) / Math.max(1, e.timeStamp - was.t);
    if (Math.abs(dx) >= min || (Math.abs(dx) >= 24 && speed > 0.45)) o.onSwipe(dx < 0 ? 1 : -1);
  };
  const cancel = (e: PointerEvent) => {
    if (!s || e.pointerId !== s.id) return;
    s = undefined;
    slide(0);
  };
  // A picture's own drag (its ghost image) would take the pointer away mid-swipe.
  const noDrag = (e: DragEvent) => e.preventDefault();

  // A trackpad swipe is a run of sideways wheel events with momentum: one step per run, the next run after a
  // pause, so a long flick doesn't skip three pictures.
  let acc = 0;
  let fired = false;
  let quiet: ReturnType<typeof setTimeout> | undefined;
  const wheel = (e: WheelEvent) => {
    if (Math.abs(e.deltaX) <= Math.abs(e.deltaY) || !can()) return;
    e.preventDefault();
    clearTimeout(quiet);
    quiet = setTimeout(() => ((acc = 0), (fired = false)), 220);
    if (fired) return;
    acc += e.deltaMode === 1 ? e.deltaX * 16 : e.deltaX;
    if (Math.abs(acc) < 80) return;
    fired = true;
    o.onSwipe(acc > 0 ? 1 : -1);
  };

  el.addEventListener("pointerdown", down);
  el.addEventListener("pointermove", move);
  el.addEventListener("pointerup", up);
  el.addEventListener("pointercancel", cancel);
  el.addEventListener("dragstart", noDrag);
  if (o.wheel !== false) el.addEventListener("wheel", wheel, { passive: false });
  return () => {
    el.removeEventListener("pointerdown", down);
    el.removeEventListener("pointermove", move);
    el.removeEventListener("pointerup", up);
    el.removeEventListener("pointercancel", cancel);
    el.removeEventListener("dragstart", noDrag);
    el.removeEventListener("wheel", wheel);
    clearTimeout(quiet);
    el.style.touchAction = touchAction;
    slide(0);
  };
}
