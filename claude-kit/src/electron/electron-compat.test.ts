// Compile-time proof that Electron's real objects fit attachIpc and
// claudeBridge as they are, with no casts in the app (tsc checks it; the
// runtime test only marks the file as run).
import { test } from "node:test";
import type { App, BrowserWindow, Dialog, IpcMain, IpcRenderer, nativeImage } from "electron";
import type { AttachIpcOptions } from "./main.js";
import type { claudeBridge } from "./preload.js";
import type { nativeImageTools } from "./main.js";

type Assert<T extends true> = T;
type Fits<A, B> = [A] extends [B] ? true : false;

export type Checks = [
  Assert<Fits<IpcMain, AttachIpcOptions["ipcMain"]>>,
  Assert<Fits<typeof BrowserWindow, NonNullable<AttachIpcOptions["BrowserWindow"]>>>,
  Assert<Fits<Dialog, NonNullable<AttachIpcOptions["dialog"]>>>,
  Assert<Fits<App, NonNullable<AttachIpcOptions["app"]>>>,
  Assert<Fits<IpcRenderer, Parameters<typeof claudeBridge>[0]>>,
  Assert<Fits<typeof nativeImage, Parameters<typeof nativeImageTools>[0]>>,
];

test("Electron's objects fit (checked by tsc)", () => undefined);
