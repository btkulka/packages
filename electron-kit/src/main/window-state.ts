import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { fitWindowBounds, type RestoredWindowState, type SavedWindowState, type WindowBounds, type WindowSize } from "./bounds.js";
import type { Rect, ScreenLike } from "./types.js";

/** Where window positions are kept, one entry per window key. */
export interface WindowStateStore {
  get(key: string): SavedWindowState | undefined;
  set(key: string, state: SavedWindowState): void;
}

/** The window members trackWindowState and windowState use. */
export interface StatefulWindow {
  isDestroyed(): boolean;
  isMaximized(): boolean;
  isFullScreen(): boolean;
  maximize(): void;
  getNormalBounds(): Rect;
  on(event: string, listener: (...args: any[]) => void): unknown;
}

/**
 * A JSON file of saved windows: { "<key>": { x, y, width, height, maximized } }.
 * This is the format of Benhäus's windows.json, so pointing it there keeps
 * the positions already saved. A missing or unreadable file reads as empty;
 * the folder is created on first write.
 */
export function windowStateFile(filePath: string): WindowStateStore {
  const readAll = (): Record<string, SavedWindowState> => {
    try {
      const parsed: unknown = JSON.parse(readFileSync(filePath, "utf8"));
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, SavedWindowState>) : {};
    } catch {
      return {};
    }
  };
  return {
    get: (key) => {
      const s = readAll()[key];
      return s && typeof s === "object" ? s : undefined;
    },
    set: (key, state) => {
      const all = readAll();
      all[key] = state;
      const dir = dirname(filePath);
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      writeFileSync(filePath, JSON.stringify(all, null, 2), "utf8");
    },
  };
}

/** fitWindowBounds against the displays Electron's screen reports now. Call after app ready. */
export function restoreWindowState(screen: ScreenLike, saved: unknown, defaults: WindowSize): RestoredWindowState {
  return fitWindowBounds(
    saved,
    screen.getAllDisplays().map((d) => d.workArea),
    screen.getPrimaryDisplay().workArea,
    defaults,
  );
}

export interface TrackOptions {
  /** Moves and resizes settle for this long before saving. Default 400 ms. */
  debounceMs?: number;
}

/**
 * Save a window's place as it moves, resizes, maximizes and restores
 * (debounced), and once more, at once, when it closes. Saves the normal
 * bounds, so a maximized window still remembers where it goes when restored.
 * Nothing is saved while the window is full screen.
 */
export function trackWindowState(win: StatefulWindow, save: (state: SavedWindowState) => void, opts: TrackOptions = {}): void {
  const wait = opts.debounceMs ?? 400;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const saveNow = () => {
    clearTimeout(timer);
    timer = undefined;
    if (win.isDestroyed() || win.isFullScreen()) return;
    const b = win.getNormalBounds();
    if (![b.x, b.y, b.width, b.height].every(Number.isFinite) || b.width <= 0 || b.height <= 0) return;
    save({ x: b.x, y: b.y, width: b.width, height: b.height, maximized: win.isMaximized() });
  };
  const later = () => {
    clearTimeout(timer);
    timer = setTimeout(saveNow, wait);
  };
  for (const event of ["resize", "move", "maximize", "unmaximize"]) win.on(event, later);
  win.on("close", saveNow);
}

export interface WindowStateOptions extends TrackOptions {
  screen: ScreenLike;
  store: WindowStateStore;
  /** Which window this is ("main", "popout:<id>"). Default "main". */
  key?: string;
  /** Size of a window opened for the first time. */
  defaults: WindowSize;
}

export interface ManagedWindowState {
  /** Spread into the BrowserWindow options. */
  bounds: WindowBounds;
  /** Whether it was maximized when it last closed. */
  maximized: boolean;
  /** Maximize the new window if it was, then keep its place saved. */
  attach(win: StatefulWindow): void;
}

/**
 * The usual pairing of restoreWindowState and trackWindowState:
 *
 *   const state = windowState({ screen, store, key: "main", defaults: { width: 1440, height: 900 } });
 *   const win = new BrowserWindow({ ...state.bounds, minWidth: 900, show: false });
 *   state.attach(win);
 */
export function windowState(opts: WindowStateOptions): ManagedWindowState {
  const key = opts.key ?? "main";
  const { maximized, ...bounds } = restoreWindowState(opts.screen, opts.store.get(key), opts.defaults);
  return {
    bounds,
    maximized,
    attach(win) {
      if (maximized) win.maximize();
      trackWindowState(win, (s) => opts.store.set(key, s), opts);
    },
  };
}
