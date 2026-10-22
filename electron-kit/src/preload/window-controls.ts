import type { Unsubscribe } from "../ipc-schema.js";
import { windowChannels, type WindowAction } from "../window-actions.js";
import { subscribe, type IpcRendererLike } from "./bridge.js";

export interface WindowControls {
  /** Ask main to do one WindowAction to this window. */
  control(action: WindowAction): void;
  minimize(): void;
  /** Maximize, or restore when already maximized. */
  toggleMaximize(): void;
  close(): void;
  toggleDevTools(): void;
  isMaximized(): Promise<boolean>;
  /** Called with true on maximize and false on restore. */
  onMaximized(callback: (maximized: boolean) => void): Unsubscribe;
}

/**
 * The renderer half of a frameless window's title bar. Pairs with main's
 * registerWindowControls (and forwardMaximized), using the same prefix.
 */
export function windowControls(ipcRenderer: IpcRendererLike, prefix?: string): WindowControls {
  const ch = windowChannels(prefix);
  const control = (action: WindowAction) => ipcRenderer.send(ch.control, action);
  return {
    control,
    minimize: () => control("minimize"),
    toggleMaximize: () => control("maximize"),
    close: () => control("close"),
    toggleDevTools: () => control("toggle_devtools"),
    isMaximized: () => ipcRenderer.invoke(ch.isMaximized),
    onMaximized: (callback) => subscribe<boolean>(ipcRenderer, ch.maximized, (m) => callback(Boolean(m))),
  };
}
