// Stand-ins for Electron's main-process objects, just real enough for the
// tests: they keep state and emit the events Electron would.
import { EventEmitter } from "node:events";

export class FakeContents extends EventEmitter {
  destroyed = false;
  sent: unknown[][] = [];
  zoom = 0;
  devTools = false;
  devToolsMode: string | undefined;
  reloads = 0;
  hardReloads = 0;
  loads: Array<{ url?: string; file?: string; options?: unknown; argCount: number }> = [];
  openHandler: ((details: { url: string }) => unknown) | undefined;
  url = "app://index.html";

  isDestroyed() {
    return this.destroyed;
  }
  send(channel: string, ...args: unknown[]) {
    if (this.destroyed) throw new Error("Object has been destroyed");
    this.sent.push([channel, ...args]);
  }
  reload() {
    this.reloads++;
  }
  reloadIgnoringCache() {
    this.hardReloads++;
  }
  isDevToolsOpened() {
    return this.devTools;
  }
  openDevTools(options?: { mode: string }) {
    this.devTools = true;
    this.devToolsMode = options?.mode;
  }
  closeDevTools() {
    this.devTools = false;
  }
  toggleDevTools() {
    this.devTools = !this.devTools;
    this.devToolsMode = undefined;
  }
  getZoomLevel() {
    return this.zoom;
  }
  setZoomLevel(level: number) {
    this.zoom = level;
  }
  loadURL(url: string): Promise<void> {
    this.loads.push({ url, argCount: 1 });
    return Promise.resolve();
  }
  loadFile(file: string, options?: unknown): Promise<void> {
    this.loads.push({ file, options, argCount: arguments.length });
    return Promise.resolve();
  }
  setWindowOpenHandler(handler: (details: { url: string }) => unknown) {
    this.openHandler = handler;
  }
  getURL() {
    return this.url;
  }
}

export class FakeWindow extends EventEmitter {
  webContents = new FakeContents();
  destroyed = false;
  minimized = false;
  maximized = false;
  visible = true;
  fullScreen = false;
  bounds = { x: 100, y: 100, width: 800, height: 600 };
  calls: string[] = [];

  isDestroyed() {
    return this.destroyed;
  }
  isMinimized() {
    return this.minimized;
  }
  isMaximized() {
    return this.maximized;
  }
  isVisible() {
    return this.visible;
  }
  isFullScreen() {
    return this.fullScreen;
  }
  restore() {
    this.calls.push("restore");
    this.minimized = false;
  }
  show() {
    this.calls.push("show");
    this.visible = true;
  }
  hide() {
    this.calls.push("hide");
    this.visible = false;
  }
  focus() {
    this.calls.push("focus");
  }
  minimize() {
    this.calls.push("minimize");
    this.minimized = true;
  }
  maximize() {
    this.calls.push("maximize");
    this.maximized = true;
    this.emit("maximize");
  }
  unmaximize() {
    this.calls.push("unmaximize");
    this.maximized = false;
    this.emit("unmaximize");
  }
  setFullScreen(flag: boolean) {
    this.fullScreen = flag;
  }
  getNormalBounds() {
    return { ...this.bounds };
  }
  /** Like Electron: emits a preventable "close", then is destroyed unless prevented. */
  close() {
    this.calls.push("close");
    let prevented = false;
    this.emit("close", { preventDefault: () => (prevented = true) });
    if (!prevented) {
      this.destroyed = true;
      this.emit("closed");
    }
  }
}

export class FakeApp extends EventEmitter {
  lock = true;
  quits = 0;
  requestSingleInstanceLock() {
    return this.lock;
  }
  whenReady() {
    return Promise.resolve();
  }
  /** Like Electron: emits before-quit, then closes the windows it's given. */
  quit() {
    this.quits++;
    this.emit("before-quit", { preventDefault() {} });
  }
}

/** Electron's ipcMain: one handler per channel (a second throws), any number of listeners. */
export class FakeIpcMain extends EventEmitter {
  handlers = new Map<string, (event: any, ...args: any[]) => any>();
  handle(channel: string, listener: (event: any, ...args: any[]) => any) {
    if (this.handlers.has(channel)) throw new Error(`Attempted to register a second handler for '${channel}'`);
    this.handlers.set(channel, listener);
  }
  async invoke(channel: string, event: unknown, ...args: unknown[]) {
    const h = this.handlers.get(channel);
    if (!h) throw new Error(`No handler registered for '${channel}'`);
    return h(event, ...args);
  }
}

export class FakeIpcRenderer extends EventEmitter {
  invoked: unknown[][] = [];
  sentMessages: unknown[][] = [];
  answer: unknown = "answer";
  invoke(channel: string, ...args: unknown[]) {
    this.invoked.push([channel, ...args]);
    return Promise.resolve(this.answer);
  }
  send(channel: string, ...args: unknown[]) {
    this.sentMessages.push([channel, ...args]);
  }
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
