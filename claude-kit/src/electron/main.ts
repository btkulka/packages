import { join } from "node:path";
import { writeFileSync } from "node:fs";
import type { ChatHost } from "../host/host.js";
import type { ImageTools } from "../host/images.js";
import type { AskDecision, ClaudeMode, NewChatImage, NewChatOptions, ThumbSize } from "../types.js";

// @btkulka/claude-kit/electron/main: a ChatHost over Electron IPC. The
// preload half (./preload) turns these channels back into a ClaudeTransport
// for the screens. Electron is never imported: the app hands its objects in.

/* eslint-disable @typescript-eslint/no-explicit-any */
// Listeners take `any`, as Electron's own typings do, so its IpcMain (and electron-kit's recording one) fit as they are.
interface IpcMainLike {
  handle(channel: string, listener: (event: any, ...args: any[]) => any): void;
  removeHandler(channel: string): void;
}
interface WebContentsLike {
  send(channel: string, ...args: unknown[]): void;
  isDestroyed?(): boolean;
}
interface BrowserWindowLike {
  webContents: WebContentsLike;
  isDestroyed?(): boolean;
}
interface BrowserWindowStatic {
  getAllWindows(): BrowserWindowLike[];
  getFocusedWindow(): BrowserWindowLike | null;
}
interface DialogLike {
  showSaveDialog(...args: unknown[]): Promise<{ canceled: boolean; filePath?: string }>;
}
interface NativeImageLike {
  getSize(): { width: number; height: number };
  resize(o: { width: number; height: number; quality?: "good" | "better" | "best" }): NativeImageLike;
  toPNG(): Buffer;
  toJPEG(quality: number): Buffer;
}
interface NativeImageStatic {
  createFromBuffer(buffer: Buffer): NativeImageLike;
}

export interface AttachIpcOptions {
  ipcMain: IpcMainLike;
  /** Where events go: every window's webContents (BrowserWindow.getAllWindows) unless given a sender of its own. */
  BrowserWindow?: BrowserWindowStatic;
  send?: (channel: string, payload: unknown) => void;
  /** For Download's Save dialog (starting in `app.getPath("downloads")`). Without them, the screens download through the browser. */
  dialog?: DialogLike;
  app?: { getPath(name: "downloads"): string };
  /** The channels' prefix: "claude" gives claude:state, claude:send… */
  prefix?: string;
}

/** Electron's nativeImage as the host's image tools: thumbnails, and images over Claude's limit scaled down. */
export function nativeImageTools(nativeImage: NativeImageStatic): ImageTools {
  return {
    size: (bytes) => {
      const s = nativeImage.createFromBuffer(bytes).getSize();
      return s.width && s.height ? s : undefined;
    },
    resize: (bytes, to, as, quality = 88) => {
      const small = nativeImage.createFromBuffer(bytes).resize({ ...to, quality: "better" });
      return as === "jpeg" ? small.toJPEG(quality) : small.toPNG();
    },
  };
}

/** The channels a prefix gives, for the preload half and for an app that wires its own. */
export const channels = (prefix = "claude") => ({
  state: `${prefix}:state`,
  start: `${prefix}:start`,
  seen: `${prefix}:seen`,
  send: `${prefix}:send`,
  image: `${prefix}:image`,
  saveImage: `${prefix}:saveImage`,
  stop: `${prefix}:stop`,
  newChat: `${prefix}:new`,
  select: `${prefix}:select`,
  close: `${prefix}:close`,
  answer: `${prefix}:answer`,
  terminal: `${prefix}:terminal`,
  configure: `${prefix}:configure`,
  past: `${prefix}:past`,
  load: `${prefix}:load`,
  onList: `${prefix}:chats`,
  onChange: `${prefix}:chat`,
  onStream: `${prefix}:stream`,
});

/** Registers the host's channels and sends its events to the windows. Returns the undo. */
export function attachIpc(host: ChatHost, o: AttachIpcOptions): () => void {
  const ch = channels(o.prefix);
  const send =
    o.send ??
    ((channel: string, payload: unknown) => {
      for (const w of o.BrowserWindow?.getAllWindows() ?? []) if (!w.isDestroyed?.() && !w.webContents.isDestroyed?.()) w.webContents.send(channel, payload);
    });
  const handlers: Record<string, (...args: never[]) => unknown> = {
    [ch.state]: () => host.state(),
    [ch.start]: (chat?: string) => host.start(chat),
    [ch.seen]: (chats: string | string[]) => host.seen(chats),
    [ch.send]: (text: string, chat?: string, images?: NewChatImage[]) => host.send(text, chat, images),
    [ch.image]: (ref: string, folder?: string, thumb?: ThumbSize) => host.image(ref, folder, thumb),
    [ch.stop]: (chat?: string) => host.stop(chat),
    [ch.newChat]: (opts?: NewChatOptions) => host.newChat(opts),
    [ch.select]: (chat: string) => host.select(chat),
    [ch.close]: (chat: string) => host.close(chat),
    [ch.answer]: (id: string, d: AskDecision) => host.answer(id, d),
    [ch.terminal]: (chat?: string) => host.terminal(chat),
    [ch.configure]: (chat: string, c: { mode?: ClaudeMode; model?: string }) => host.configure(chat, c),
    [ch.past]: (query?: string, limit?: number) => host.past({ query, limit }),
    [ch.load]: (sessionId: string) => host.load(sessionId),
    [ch.saveImage]: async (ref: string, s?: { folder?: string; name?: string }) => {
      if (!o.dialog) throw new Error("No Save dialog here.");
      const img = await host.images.read(ref, s?.folder);
      const name = host.images.fileName(img, s?.name);
      const ext = name.split(".").pop() ?? "png";
      const opts = { defaultPath: o.app ? join(o.app.getPath("downloads"), name) : name, filters: [{ name: "Image", extensions: [ext] }, { name: "All files", extensions: ["*"] }] };
      const win = o.BrowserWindow?.getFocusedWindow();
      const r = win ? await o.dialog.showSaveDialog(win, opts) : await o.dialog.showSaveDialog(opts);
      if (r.canceled || !r.filePath) return undefined;
      writeFileSync(r.filePath, img.bytes);
      return r.filePath;
    },
  };
  // A transport that carries arguments as JSON (electron-kit's web host) turns a left-out one into null: that's left out too.
  for (const [channel, fn] of Object.entries(handlers)) o.ipcMain.handle(channel, (_e: unknown, ...args: unknown[]) => fn(...(args.map((a) => a ?? undefined) as never[])));
  const off = host.on((e) => send(e.type === "chats" ? ch.onList : e.type === "chat" ? ch.onChange : ch.onStream, e.payload));
  return () => {
    off();
    for (const channel of Object.keys(handlers)) o.ipcMain.removeHandler(channel);
  };
}
