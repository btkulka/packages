// What a frameless window's own title bar (and the keys a native menu used to
// answer) can ask of its window. Shared by main (which acts) and preload
// (which asks), so both agree on the names and channels.

/**
 * Every action windowAction understands. `maximize` toggles. `quit` only works
 * when the app passes a quit handler (it is the app's call, not the window's).
 * The names are Benhäus's, which its MCP window_control tool already uses.
 */
export const WINDOW_ACTIONS = [
  "minimize",
  "maximize",
  "close",
  "quit",
  "reload_window",
  "force_reload",
  "toggle_devtools",
  "zoom_in",
  "zoom_out",
  "reset_zoom",
  "toggle_fullscreen",
] as const;

export type WindowAction = (typeof WINDOW_ACTIONS)[number];

export function isWindowAction(value: unknown): value is WindowAction {
  return typeof value === "string" && (WINDOW_ACTIONS as readonly string[]).includes(value);
}

/** The IPC channels the window-control pair uses, under a prefix ("window" by default). */
export interface WindowChannels {
  /** Renderer → main (send): one WindowAction. */
  control: string;
  /** Renderer → main (invoke): resolves to whether the sender's window is maximized. */
  isMaximized: string;
  /** Main → renderer (event): a boolean, sent on maximize and unmaximize. */
  maximized: string;
}

/**
 * The default prefix gives `window:control` and `window:maximized`, the
 * channels Benhäus already has, so its parity check and renderer keep working.
 */
export function windowChannels(prefix = "window"): WindowChannels {
  return {
    control: `${prefix}:control`,
    isMaximized: `${prefix}:is-maximized`,
    maximized: `${prefix}:maximized`,
  };
}
