import type { EmitterLike } from "./types.js";

/** What to do when a window is asked to close and the app isn't quitting. */
export type CloseDecision =
  /** Let it close. */
  | "close"
  /** Keep it running in the tray: hide it instead. */
  | "hide"
  /** Keep it open: you are asking first (a dialog, an overlay, the renderer). Call win.close() again to close. */
  | "keep";

export interface ClosableWindow {
  on(event: "close", listener: (event: { preventDefault(): void }) => void): unknown;
  hide(): void;
}

const quitting = new WeakMap<object, { value: boolean }>();

function quitState(app: EmitterLike): { value: boolean } {
  let state = quitting.get(app);
  if (!state) {
    const s = { value: false };
    // A quit (app.quit, the tray's Quit, Windows logging off or shutting down)
    // closes every window and must never be vetoed or turned into a hide.
    const mark = () => {
      s.value = true;
    };
    app.on("before-quit", mark);
    app.on("session-end", mark);
    quitting.set(app, s);
    state = s;
  }
  return state;
}

/**
 * Whether the app has begun quitting (before-quit, or Windows ending the
 * session). Set even when a before-quit handler delays the quit to clean up.
 */
export function isQuitting(app: EmitterLike): boolean {
  return quitState(app).value;
}

/**
 * Decide what the window's X (and Alt+F4, the taskbar's Close) does, without
 * ever getting in the way of quitting: while the app quits, the window just
 * closes and `decide` isn't asked.
 *
 *   // Tray app: the X hides.
 *   interceptClose(app, win, () => "hide");
 *   // Ask first: veto, show your dialog, and close for real later.
 *   interceptClose(app, win, () => (dirty ? (askToSave(), "keep") : "close"));
 */
export function interceptClose(app: EmitterLike, win: ClosableWindow, decide: () => CloseDecision): void {
  const state = quitState(app);
  win.on("close", (event) => {
    if (state.value) return;
    const decision = decide();
    if (decision === "close") return;
    event.preventDefault();
    if (decision === "hide") win.hide();
  });
}
