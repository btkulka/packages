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

/** The parts of Electron's ipcRenderer the bridge uses. Pass the real one. */
export interface IpcRendererLike {
  invoke(channel: string, ...args: any[]): Promise<any>;
  send(channel: string, ...args: any[]): void;
  on(channel: string, listener: (event: any, ...args: any[]) => void): unknown;
  removeListener(channel: string, listener: (...args: any[]) => void): unknown;
}

export interface Bridge<S extends IpcSchema> {
  /** A function that invokes `channel` with its arguments and resolves to main's answer. */
  invoke<K extends InvokeChannel<S>>(channel: K): (...args: InvokeArgs<S, K>) => Promise<InvokeResult<S, K>>;
  /** A function that sends on `channel` without waiting for an answer. */
  send<K extends SendChannel<S>>(channel: K): (...args: SendArgs<S, K>) => void;
  /**
   * A subscribe function for `channel`: it calls back with each payload main
   * pushes (the IPC event itself never reaches the renderer) and returns the
   * function that unsubscribes exactly that callback.
   */
  on<K extends EventChannel<S>>(channel: K): (callback: (payload: EventPayload<S, K>) => void) => Unsubscribe;
}

/**
 * The preload's door to main. Every app's preload had these three helpers in
 * some form; build the API object from them and expose it:
 *
 *   const { invoke, send, on } = createBridge<AppIpc>(ipcRenderer);
 *   contextBridge.exposeInMainWorld("app", {
 *     settings: { get: invoke("settings:get"), onChange: on("settings") },
 *     setDirty: send("set-dirty"),
 *   });
 */
export function createBridge<S extends IpcSchema = AnyIpc>(ipcRenderer: IpcRendererLike): Bridge<S> {
  return {
    invoke:
      (channel) =>
      (...args) =>
        ipcRenderer.invoke(channel, ...args),
    send:
      (channel) =>
      (...args) =>
        ipcRenderer.send(channel, ...args),
    on: (channel) => (callback) => subscribe(ipcRenderer, channel, callback),
  };
}

/**
 * Listen on one channel, calling back with the payload only. Returns the
 * unsubscribe function, which removes this listener and no other.
 */
export function subscribe<T = any>(ipcRenderer: IpcRendererLike, channel: string, callback: (payload: T) => void): Unsubscribe {
  const listener = (_event: unknown, payload: T) => callback(payload);
  ipcRenderer.on(channel, listener);
  let active = true;
  return () => {
    if (!active) return;
    active = false;
    ipcRenderer.removeListener(channel, listener);
  };
}
