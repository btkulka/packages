import { isWindowAction, windowChannels, type WindowAction } from "../window-actions.js";
import type { IpcMainLike } from "./ipc.js";
import { sendTo } from "./ipc.js";
import type { SendTarget } from "./types.js";

export type DevToolsMode = "left" | "right" | "bottom" | "undocked" | "detach";

export interface ActionWebContents {
  reload(): void;
  reloadIgnoringCache(): void;
  isDevToolsOpened(): boolean;
  openDevTools(options?: { mode: DevToolsMode }): void;
  closeDevTools(): void;
  toggleDevTools(): void;
  getZoomLevel(): number;
  setZoomLevel(level: number): void;
}

export interface ActionWindow {
  minimize(): void;
  maximize(): void;
  unmaximize(): void;
  isMaximized(): boolean;
  close(): void;
  isFullScreen(): boolean;
  setFullScreen(flag: boolean): void;
  readonly webContents: ActionWebContents;
}

export interface WindowActionOptions {
  /** Where DevTools and zoom act: a webview's contents when the key was pressed in one. Default: the window's own page. */
  contents?: ActionWebContents;
  /** Open DevTools in this mode (Orson uses "detach"). Default: Electron's toggle, which remembers the last mode. */
  devToolsMode?: DevToolsMode;
  /** What "quit" does. Without it, "quit" is ignored: quitting is the app's decision. */
  quit?: () => void;
}

/** Zoom moves this many levels per step (Chromium's 20% steps are 1.0). */
const ZOOM_STEP = 0.5;

/**
 * What a native menu's Window and View items did, for windows that draw their
 * own title bar. Reload and fullscreen act on the window; DevTools and zoom
 * on `contents` when given. Returns false for an action it didn't do.
 */
export function windowAction(win: ActionWindow, action: WindowAction, opts: WindowActionOptions = {}): boolean {
  const wc = opts.contents ?? win.webContents;
  switch (action) {
    case "minimize":
      win.minimize();
      return true;
    case "maximize":
      if (win.isMaximized()) win.unmaximize();
      else win.maximize();
      return true;
    case "close":
      win.close();
      return true;
    case "quit":
      if (!opts.quit) return false;
      opts.quit();
      return true;
    case "reload_window":
      win.webContents.reload();
      return true;
    case "force_reload":
      win.webContents.reloadIgnoringCache();
      return true;
    case "toggle_devtools":
      if (!opts.devToolsMode) wc.toggleDevTools();
      else if (wc.isDevToolsOpened()) wc.closeDevTools();
      else wc.openDevTools({ mode: opts.devToolsMode });
      return true;
    case "zoom_in":
      wc.setZoomLevel(wc.getZoomLevel() + ZOOM_STEP);
      return true;
    case "zoom_out":
      wc.setZoomLevel(wc.getZoomLevel() - ZOOM_STEP);
      return true;
    case "reset_zoom":
      wc.setZoomLevel(0);
      return true;
    case "toggle_fullscreen":
      win.setFullScreen(!win.isFullScreen());
      return true;
    default:
      return false;
  }
}

export interface WindowFromContents<W> {
  fromWebContents(contents: any): W | null;
}

export interface WindowControlsOptions extends Omit<WindowActionOptions, "contents"> {
  /** Channel prefix, matching the preload's windowControls. Default "window". */
  prefix?: string;
}

/**
 * Main's half of a frameless title bar: answers the preload's windowControls
 * for whichever window sent the request. Pass Electron's ipcMain and
 * BrowserWindow. Unknown actions are ignored.
 */
export function registerWindowControls<W extends ActionWindow>(
  ipcMain: IpcMainLike,
  BrowserWindow: WindowFromContents<W>,
  opts: WindowControlsOptions = {},
): void {
  const ch = windowChannels(opts.prefix);
  const { prefix: _prefix, ...actionOpts } = opts;
  ipcMain.on(ch.control, (event: { sender: unknown }, action: unknown) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (win && isWindowAction(action)) windowAction(win, action, actionOpts);
  });
  ipcMain.handle(ch.isMaximized, (event: { sender: unknown }) => BrowserWindow.fromWebContents(event.sender)?.isMaximized() ?? false);
}

export interface MaximizableWindow extends SendTarget {
  on(event: string, listener: (...args: any[]) => void): unknown;
}

/** Tell the window's page when it maximizes (true) and restores (false), for the title bar's button. */
export function forwardMaximized(win: MaximizableWindow, prefix?: string): void {
  const ch = windowChannels(prefix).maximized;
  win.on("maximize", () => sendTo(win, ch, true));
  win.on("unmaximize", () => sendTo(win, ch, false));
}
