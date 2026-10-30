// @btkulka/electron-kit/main: the main process's half. Every function
// takes the Electron objects it needs (app, BrowserWindow, screen, shell,
// ipcMain…) as arguments; nothing here requires electron itself.

export { requestSingleInstance, revealWindow } from "./single-instance.js";
export type { SingleInstanceApp, SingleInstanceOptions } from "./single-instance.js";

export { fitWindowBounds } from "./bounds.js";
export type { RestoredWindowState, SavedWindowState, WindowBounds, WindowSize } from "./bounds.js";
export { restoreWindowState, trackWindowState, windowState, windowStateFile } from "./window-state.js";
export type { ManagedWindowState, StatefulWindow, TrackOptions, WindowStateOptions, WindowStateStore } from "./window-state.js";

export { devServerUrl, loadRenderer } from "./renderer.js";
export type { Loadable, RendererSource } from "./renderer.js";

export { DEFAULT_EXTERNAL_PROTOCOLS, externalUrl, openExternal, routeNewWindowsToBrowser } from "./external.js";
export type { ExternalOptions, ShellLike, WindowOpener } from "./external.js";

export { addBroadcastSink, broadcast, createIpcMain, recordIpc, sendTo, WEB_EVENT } from "./ipc.js";
export type { IpcMainKit, IpcMainLike, IpcRegistry, RecordingIpcMain } from "./ipc.js";

export { createWebHost, fileUnder, injectWebPreload, isWebLaunch, webPreloadScript } from "./web-host.js";
export type { WebHost, WebHostOptions } from "./web-host.js";

export { forwardMaximized, registerWindowControls, windowAction } from "./window-controls.js";
export type {
  ActionWebContents,
  ActionWindow,
  DevToolsMode,
  MaximizableWindow,
  WindowActionOptions,
  WindowControlsOptions,
  WindowFromContents,
} from "./window-controls.js";

export { interceptClose, isQuitting } from "./close.js";
export type { ClosableWindow, CloseDecision } from "./close.js";

export { startApp } from "./lifecycle.js";
export type { LifecycleApp, StartAppOptions } from "./lifecycle.js";

export { createTray } from "./tray.js";
export type { ImageLike, TrayHandle, TrayLike, TrayModules, TrayOptions } from "./tray.js";

export { logCrashes } from "./crash.js";
export type { CrashKind, CrashLogOptions, RendererGone } from "./crash.js";

export type { AppEmitterLike, EmitterLike, Rect, RevealTarget, ScreenLike, SendTarget, WebContentsLike, WindowList } from "./types.js";

export * from "../index.js";
