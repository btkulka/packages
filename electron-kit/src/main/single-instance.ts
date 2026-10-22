import type { EmitterLike, RevealTarget } from "./types.js";

/** Bring a window forward: un-minimize, show (it may be hidden in the tray) and focus. */
export function revealWindow(win: RevealTarget | null | undefined): void {
  if (!win || win.isDestroyed()) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

export interface SingleInstanceApp extends EmitterLike {
  requestSingleInstanceLock(): boolean;
  quit(): void;
}

export interface SingleInstanceOptions {
  /** The window a second launch brings forward (revealWindow). Read at the time of the launch. */
  window?: () => RevealTarget | null | undefined;
  /**
   * Handle a second launch yourself, with its command line and working
   * directory (a notification's deep link, a --paste flag…). When given, the
   * window is not revealed for you: call revealWindow when you want it.
   */
  onSecondInstance?: (argv: string[], workingDirectory: string) => void;
}

/**
 * One copy of the app at a time. Returns true in the first copy, which then
 * hears about later launches. A later copy gets false and is already quitting:
 * it must do nothing else (no windows, servers or files).
 *
 *   if (requestSingleInstance(app, { window: () => mainWindow })) {
 *     startApp(app, BrowserWindow, { ready })
 *   }
 */
export function requestSingleInstance(app: SingleInstanceApp, opts: SingleInstanceOptions = {}): boolean {
  if (!app.requestSingleInstanceLock()) {
    app.quit();
    return false;
  }
  app.on("second-instance", (_event: unknown, argv: string[], workingDirectory: string) => {
    if (opts.onSecondInstance) opts.onSecondInstance(argv ?? [], workingDirectory ?? "");
    else revealWindow(opts.window?.());
  });
  return true;
}
