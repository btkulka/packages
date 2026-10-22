// @btkulka/electron-kit/preload: the preload's half. Pure functions
// over the ipcRenderer you pass in; no Node built-ins and nothing from main,
// so it bundles into a sandboxed preload.

export { createBridge, subscribe } from "./bridge.js";
export type { Bridge, IpcRendererLike } from "./bridge.js";
export { windowControls } from "./window-controls.js";
export type { WindowControls } from "./window-controls.js";
export * from "../index.js";
