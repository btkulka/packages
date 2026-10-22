import type {
  AnyIpc,
  EventChannel,
  EventPayload,
  InvokeArgs,
  InvokeChannel,
  InvokeResult,
  IpcSchema,
  SendArgs,
  SendChannel,
} from "../ipc-schema.js";
import type { SendTarget, WindowList } from "./types.js";

/** Electron's ipcMain, or the two methods of it used here. */
export interface IpcMainLike {
  handle(channel: string, listener: (event: any, ...args: any[]) => any): void;
  on(channel: string, listener: (event: any, ...args: any[]) => void): unknown;
}

type MaybePromise<T> = T | Promise<T>;

/**
 * Send to one window, unless it (or its page) is gone. Returns whether it was
 * sent. Replaces `mainWindow?.webContents.send(…)`, which throws "Object has
 * been destroyed" when the window closed first.
 */
export function sendTo(win: SendTarget | null | undefined, channel: string, payload?: unknown): boolean {
  if (!win || win.isDestroyed() || win.webContents.isDestroyed()) return false;
  win.webContents.send(channel, payload);
  return true;
}

/** Send to every open window (pass Electron's BrowserWindow). Returns how many it reached. */
export function broadcast(windows: WindowList, channel: string, payload?: unknown): number {
  let sent = 0;
  for (const win of windows.getAllWindows()) if (sendTo(win, channel, payload)) sent++;
  return sent;
}

export interface IpcMainKit<S extends IpcSchema> {
  /** ipcMain.handle, minus the event: the handler gets only the renderer's arguments. */
  handle<K extends InvokeChannel<S>>(channel: K, handler: (...args: InvokeArgs<S, K>) => MaybePromise<InvokeResult<S, K>>): void;
  /** ipcMain.handle with the event first, for handlers that need event.sender. */
  handleWithEvent<K extends InvokeChannel<S>>(
    channel: K,
    handler: (event: any, ...args: InvokeArgs<S, K>) => MaybePromise<InvokeResult<S, K>>,
  ): void;
  /** ipcMain.on for the renderer's send channels; the event comes first. */
  on<K extends SendChannel<S>>(channel: K, listener: (event: any, ...args: SendArgs<S, K>) => void): void;
  /** Push to every open window. */
  broadcast<K extends EventChannel<S>>(channel: K, payload: EventPayload<S, K>): number;
  /** Push to one window, if it's still there. */
  sendTo<K extends EventChannel<S>>(win: SendTarget | null | undefined, channel: K, payload: EventPayload<S, K>): boolean;
}

/**
 * Main's side of the IPC, checked against the app's schema when it has one:
 *
 *   const ipc = createIpcMain<AppIpc>(ipcMain, BrowserWindow);
 *   ipc.handle("config:get", () => getConfig());
 *   ipc.broadcast("config", config);
 *
 * Registering a channel twice throws, as Electron's ipcMain.handle does.
 */
export function createIpcMain<S extends IpcSchema = AnyIpc>(ipcMain: IpcMainLike, windows: WindowList): IpcMainKit<S> {
  return {
    handle: (channel, handler) => ipcMain.handle(channel, (_event, ...args) => (handler as (...a: unknown[]) => unknown)(...args)),
    handleWithEvent: (channel, handler) => ipcMain.handle(channel, handler as (event: any, ...args: any[]) => any),
    on: (channel, listener) => {
      ipcMain.on(channel, listener as (event: any, ...args: any[]) => void);
    },
    broadcast: (channel, payload) => broadcast(windows, channel, payload),
    sendTo: (win, channel, payload) => sendTo(win, channel, payload),
  };
}
