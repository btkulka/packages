export interface LifecycleApp {
  whenReady(): Promise<unknown>;
  on(event: string, listener: (...args: any[]) => void): unknown;
  quit(): void;
}

export interface StartAppOptions {
  /** Everything that needs Electron ready: IPC, protocols, the window. */
  ready: () => unknown;
  /** Opens the main window when the app is activated with none open (the macOS dock). */
  createWindow?: () => unknown;
  /**
   * When the last window closes:
   * - "quit-unless-mac" (default): quit, except on macOS where apps stay in the dock.
   * - "quit": quit on every platform.
   * - "stay": keep running (tray apps).
   * - a function: your own handler (async clean-up first, say).
   */
  allClosed?: "quit-unless-mac" | "quit" | "stay" | (() => unknown);
  /** Where a throwing or rejecting ready() is reported. Default console.error. The app quits after. */
  onError?: (error: unknown) => void;
}

/**
 * The ready / activate / window-all-closed boilerplate every app had. A
 * ready() that throws is reported and the app quits, instead of running on
 * with no window. Resolves once ready() has finished (never rejects).
 */
export function startApp(app: LifecycleApp, windows: { getAllWindows(): unknown[] }, opts: StartAppOptions): Promise<void> {
  const allClosed = opts.allClosed ?? "quit-unless-mac";
  app.on("window-all-closed", () => {
    if (typeof allClosed === "function") void allClosed();
    else if (allClosed === "quit" || (allClosed === "quit-unless-mac" && process.platform !== "darwin")) app.quit();
  });
  if (opts.createWindow) {
    const create = opts.createWindow;
    app.on("activate", () => {
      if (windows.getAllWindows().length === 0) create();
    });
  }
  return app
    .whenReady()
    .then(() => opts.ready())
    .then(
      () => undefined,
      (error: unknown) => {
        (opts.onError ?? ((e: unknown) => console.error("[electron-kit] app failed to start:", e)))(error);
        app.quit();
      },
    );
}
