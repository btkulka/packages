import { asBytes } from "../bytes.js";
import type { ChatPatch, ChatsPatch, ChatStreamDelta, ClaudeTransport, ImageBytesOut } from "../types.js";

// @btkulka/claude-kit/electron/preload: the IPC channels of ./main as a
// ClaudeTransport, to expose to the page:
//
//   contextBridge.exposeInMainWorld("claude", claudeBridge(ipcRenderer));
//
// The page then hands window.claude to <ClaudeProvider transport={…}>.
//
// No Node and nothing from ./main, so a sandboxed preload can bundle it.

/* eslint-disable @typescript-eslint/no-explicit-any */
// Listeners take `any`, as Electron's own typings do, so its IpcRenderer fits as it is.
interface IpcRendererLike {
  invoke(channel: string, ...args: any[]): Promise<any>;
  on(channel: string, listener: (event: any, ...args: any[]) => void): unknown;
  removeListener(channel: string, listener: (event: any, ...args: any[]) => void): unknown;
}

/** `saveDialog`: main was given a Save dialog (attachIpc's dialog and app), so Download uses it instead of the browser's download. */
export function claudeBridge(ipcRenderer: IpcRendererLike, o: { prefix?: string; saveDialog?: boolean } = {}): ClaudeTransport {
  const prefix = o.prefix ?? "claude";
  const call =
    <R>(name: string) =>
    (...args: unknown[]) =>
      ipcRenderer.invoke(`${prefix}:${name}`, ...args) as Promise<R>;
  const on =
    <T>(name: string) =>
    (cb: (payload: T) => void) => {
      const listener = (_e: unknown, payload: unknown) => cb(payload as T);
      ipcRenderer.on(`${prefix}:${name}`, listener);
      return () => void ipcRenderer.removeListener(`${prefix}:${name}`, listener);
    };
  return {
    state: call("state"),
    start: call("start"),
    seen: call("seen"),
    send: call("send"),
    // Over real IPC the bytes come as a Uint8Array; over a JSON transport (electron-kit's web host) as {type: "Buffer", data}.
    image: (...args: unknown[]) => (call<ImageBytesOut>("image")(...args) as Promise<ImageBytesOut>).then((r) => ({ ...r, bytes: asBytes(r.bytes) })),
    ...(o.saveDialog ? { saveImage: call<string | undefined>("saveImage") } : {}),
    stop: call("stop"),
    newChat: call("new"),
    select: call("select"),
    close: call("close"),
    answer: call("answer"),
    terminal: call("terminal"),
    configure: call("configure"),
    past: call("past"),
    load: call("load"),
    onList: on<ChatsPatch>("chats"),
    onChange: on<ChatPatch>("chat"),
    onStream: on<ChatStreamDelta>("stream"),
  };
}
