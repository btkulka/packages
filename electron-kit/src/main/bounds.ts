import type { Rect } from "./types.js";

/** A window's saved place: its normal (unmaximized) bounds and whether it was maximized. */
export interface SavedWindowState extends Rect {
  maximized?: boolean;
}

/** BrowserWindow options to spread in. x and y are absent when the saved spot is off every screen (Electron then centers). */
export interface WindowBounds {
  x?: number;
  y?: number;
  width: number;
  height: number;
}

export interface RestoredWindowState extends WindowBounds {
  maximized: boolean;
}

export interface WindowSize {
  width: number;
  height: number;
}

/** How far above a display's top edge a title bar may sit (Windows snaps windows to y = -7). */
const TITLE_SLACK = 50;
/** How much of the window's width must be over a display for it to be grabbed and dragged. */
const MIN_GRAB = 100;

const num = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n);

function isSaved(s: unknown): s is SavedWindowState {
  if (!s || typeof s !== "object") return false;
  const r = s as Record<string, unknown>;
  return num(r.x) && num(r.y) && num(r.width) && num(r.height) && r.width > 0 && r.height > 0;
}

/** True when the window's title bar is on this display, far enough in to grab. */
function reachable(b: Rect, area: Rect): boolean {
  const titleOnArea = b.y >= area.y - TITLE_SLACK && b.y <= area.y + area.height - TITLE_SLACK;
  const overlap = Math.min(b.x + b.width, area.x + area.width) - Math.max(b.x, area.x);
  return titleOnArea && overlap >= Math.min(MIN_GRAB, b.width);
}

const clampTo = (size: WindowSize, area: Rect): WindowSize => ({
  width: Math.round(Math.min(size.width, area.width)),
  height: Math.round(Math.min(size.height, area.height)),
});

/**
 * Where a window should open, from what was saved and the displays there are
 * now. Pure; restoreWindowState feeds it Electron's screen.
 *
 * - Nothing (or garbage) saved: the default size, shrunk to fit the primary work area.
 * - Saved on a display that's still there: exactly as saved, maximized too.
 * - Saved on a display that's gone, or dragged nearly off-screen: the saved
 *   size shrunk to fit the primary work area, no position (centered), and
 *   still maximized if it was.
 */
export function fitWindowBounds(saved: unknown, workAreas: Rect[], primary: Rect, defaults: WindowSize): RestoredWindowState {
  if (!isSaved(saved)) return { ...clampTo(defaults, primary), maximized: false };
  const maximized = saved.maximized === true;
  const b = { x: Math.round(saved.x), y: Math.round(saved.y), width: Math.round(saved.width), height: Math.round(saved.height) };
  if (workAreas.some((a) => reachable(b, a))) return { ...b, maximized };
  return { ...clampTo(b, primary), maximized };
}
