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
  Unsubscribe,
} from "../ipc-schema.js";
import type { SendTarget, WindowList } from "./types.js";

/** Electron's ipcMain, or the two methods of it used here. */
export interface IpcMainLike {
  handle(channel: string, listener: (event: any, ...args: any[]) => any): void;
  on(channel: string, listener: (event: any, ...args: any[]) => void): unknown;
}

type MaybePromise<T> = T | Promise<T>;

/* ------------------------------------------------------------ web sinks */

type Sink = (channel: string, args: unknown[]) => void;
const sinks = new Set<Sink>();

/**
 * Hear every broadcast() (and IpcMainKit.broadcast), as the web host does to
 * push them to the pages it serves (createWebHost). Returns the unsubscribe.
 */
export function addBroadcastSink(sink: Sink): Unsubscribe {
  sinks.add(sink);
  return () => void sinks.delete(sink);
}

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

/**
 * Send to every open window (pass Electron's BrowserWindow), and to every page
 * the web host serves. Returns how many windows it reached (web pages aren't
 * counted; the host's clients() says how many there are).
 */
export function broadcast(windows: WindowList, channel: string, payload?: unknown): number {
  let sent = 0;
  for (const win of windows.getAllWindows()) if (sendTo(win, channel, payload)) sent++;
  for (const sink of sinks) sink(channel, [payload]);
  return sent;
}

/* --------------------------------------------------------------- registry */

/**
 * The handlers and listeners an app registered, callable without a renderer:
 * what the web host (createWebHost) dispatches a page's invoke and send to.
 * Electron's ipcMain keeps its handlers to itself, so the kit records them on
 * the way in (recordIpc, which createIpcMain does for you).
 */
export interface IpcRegistry {
  /** Call the channel's handle() handler as a renderer's invoke would. Rejects when there's no handler. */
  invoke(channel: string, args?: unknown[], event?: unknown): Promise<unknown>;
  /** Call the channel's on() listeners as a renderer's send would. Returns how many heard it. */
  send(channel: string, args?: unknown[], event?: unknown): number;
  has(channel: string): boolean;
  /** Every channel with a handler or a listener. */
  channels(): string[];
}

/** An ipcMain that records what's registered on it (registry) while passing everything on to the real one. */
export interface RecordingIpcMain extends IpcMainLike {
  readonly registry: IpcRegistry;
}

/** The event a web page's call carries: there's no renderer process behind it. */
export const WEB_EVENT = Object.freeze({ sender: null, senderFrame: null, frameId: 0, processId: 0, web: true });

/**
 * Wrap Electron's ipcMain so the handlers and listeners registered through
 * it can also be called by the web host. Use the wrapped one everywhere
 * ipcMain was used (ipcMain.handle, ipcMain.on, the kit's helpers):
 *
 *   const ipcMain = recordIpc(electron.ipcMain);
 *   ipcMain.handle("config:get", () => config);
 *   createWebHost({ ipc: ipcMain.registry, … });
 */
export function recordIpc(ipcMain: IpcMainLike): RecordingIpcMain {
  if ((ipcMain as RecordingIpcMain).registry) return ipcMain as RecordingIpcMain;
  const handlers = new Map<string, (event: any, ...args: any[]) => any>();
  const listeners = new Map<string, Set<(event: any, ...args: any[]) => void>>();
  const registry: IpcRegistry = {
    async invoke(channel, args = [], event = WEB_EVENT) {
      const h = handlers.get(channel);
      if (!h) throw new Error(`No handler registered for '${channel}'`);
      return h(event, ...args);
    },
    send(channel, args = [], event = WEB_EVENT) {
      const set = listeners.get(channel);
      if (!set) return 0;
      for (const l of [...set]) l(event, ...args);
      return set.size;
    },
    has: (channel) => handlers.has(channel) || listeners.has(channel),
    channels: () => [...new Set([...handlers.keys(), ...listeners.keys()])],
  };
  return {
    registry,
    handle(channel, listener) {
      ipcMain.handle(channel, listener);
      handlers.set(channel, listener);
    },
    on(channel, listener) {
      const r = ipcMain.on(channel, listener);
      let set = listeners.get(channel);
      if (!set) listeners.set(channel, (set = new Set()));
      set.add(listener);
      return r;
    },
  };
}

/* ---------------------------------------------------------------- the kit */

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
  /** Push to every open window, and to every page the web host serves. */
  broadcast<K extends EventChannel<S>>(channel: K, payload: EventPayload<S, K>): number;
  /** Push to one window, if it's still there. */
  sendTo<K extends EventChannel<S>>(win: SendTarget | null | undefined, channel: K, payload: EventPayload<S, K>): boolean;
  /** What was registered here, callable without a renderer: what createWebHost takes. */
  readonly registry: IpcRegistry;
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
  const rec = recordIpc(ipcMain);
  return {
    registry: rec.registry,
    handle: (channel, handler) => rec.handle(channel, (_event, ...args) => (handler as (...a: unknown[]) => unknown)(...args)),
    handleWithEvent: (channel, handler) => rec.handle(channel, handler as (event: any, ...args: any[]) => any),
    on: (channel, listener) => {
      rec.on(channel, listener as (event: any, ...args: any[]) => void);
    },
    broadcast: (channel, payload) => broadcast(windows, channel, payload),
    sendTo: (win, channel, payload) => sendTo(win, channel, payload),
  };
}
