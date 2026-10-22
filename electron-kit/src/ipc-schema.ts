// Typed IPC contracts, shared by main and preload. Types only: nothing here
// runs, so the renderer, the preload and main can all import it.
//
// An app describes its channels once:
//
//   type AppIpc = {
//     invoke: { "config:get": () => Config; "config:set": (patch: Partial<Config>) => Config };
//     send: { "set-dirty": (dirty: boolean) => void };
//     events: { config: Config };
//   };
//
// and both sides check against it: main's handle("config:get", …) must return
// a Config, and the preload's invoke("config:get") resolves to one. Leave the
// schema out and every channel is a plain string with `any` arguments, which
// is how most apps start their migration.

/** The three directions a channel can go. All are optional. */
export interface IpcSchema {
  /** Renderer asks, main answers: ipcRenderer.invoke → ipcMain.handle. Channel → handler signature. */
  invoke?: object;
  /** Renderer tells, main doesn't answer: ipcRenderer.send → ipcMain.on. Channel → listener signature. */
  send?: object;
  /** Main pushes to renderers: webContents.send → ipcRenderer.on. Channel → payload type. */
  events?: object;
}

/** No schema: any channel, any arguments. */
export type AnyIpc = Record<never, never>;

type Fn = (...args: any[]) => any;

type InvokeMap<S> = S extends { invoke: infer I } ? I : never;
type SendMap<S> = S extends { send: infer M } ? M : never;
type EventMapOf<S> = S extends { events: infer E } ? E : never;

/** Channel names the schema allows to be invoked (any string without a schema). */
export type InvokeChannel<S> = [InvokeMap<S>] extends [never] ? string : keyof InvokeMap<S> & string;
/** Arguments the renderer passes to an invoke channel. */
export type InvokeArgs<S, K> = [InvokeMap<S>] extends [never]
  ? any[]
  : K extends keyof InvokeMap<S>
    ? InvokeMap<S>[K] extends Fn
      ? Parameters<InvokeMap<S>[K]>
      : never
    : never;
/** What an invoke channel resolves to in the renderer. */
export type InvokeResult<S, K> = [InvokeMap<S>] extends [never]
  ? any
  : K extends keyof InvokeMap<S>
    ? InvokeMap<S>[K] extends Fn
      ? Awaited<ReturnType<InvokeMap<S>[K]>>
      : never
    : never;

/** Channel names the renderer may send on. */
export type SendChannel<S> = [SendMap<S>] extends [never] ? string : keyof SendMap<S> & string;
/** Arguments of a send channel. */
export type SendArgs<S, K> = [SendMap<S>] extends [never]
  ? any[]
  : K extends keyof SendMap<S>
    ? SendMap<S>[K] extends Fn
      ? Parameters<SendMap<S>[K]>
      : never
    : never;

/** Channel names main may push on. */
export type EventChannel<S> = [EventMapOf<S>] extends [never] ? string : keyof EventMapOf<S> & string;
/** The single payload an event channel carries. */
export type EventPayload<S, K> = [EventMapOf<S>] extends [never]
  ? any
  : K extends keyof EventMapOf<S>
    ? EventMapOf<S>[K]
    : never;

/** Stops a subscription. */
export type Unsubscribe = () => void;
