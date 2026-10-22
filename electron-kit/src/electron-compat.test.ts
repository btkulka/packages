// Compile-time proof that Electron's real objects fit the package's
// interfaces, and that a typed IPC schema catches mistakes. Everything here is
// checked by tsc; the one runtime test only marks the file as run.
import { test } from "node:test";
import type {
  App,
  BrowserWindow,
  IpcMain,
  IpcRenderer,
  Menu,
  MenuItemConstructorOptions,
  Screen,
  Shell,
  Tray,
  WebContents,
  nativeImage,
} from "electron";
import type * as Main from "./main/index.js";
import { createIpcMain, createTray, interceptClose, registerWindowControls, requestSingleInstance, startApp, windowState } from "./main/index.js";
import type { IpcRendererLike } from "./preload/index.js";
import { createBridge, windowControls } from "./preload/index.js";

type Assert<T extends true> = T;
type Fits<A, B> = [A] extends [B] ? true : false;

export type Checks = [
  Assert<
    Fits<
      BrowserWindow,
      Main.RevealTarget &
        Main.StatefulWindow &
        Main.ActionWindow &
        Main.SendTarget &
        Main.MaximizableWindow &
        Main.ClosableWindow &
        Main.Loadable
    >
  >,
  Assert<Fits<WebContents, Main.ActionWebContents & Main.WebContentsLike & Main.WindowOpener & Main.Loadable>>,
  Assert<Fits<App, Main.SingleInstanceApp & Main.LifecycleApp & Main.AppEmitterLike>>,
  Assert<Fits<typeof BrowserWindow, Main.WindowList & Main.WindowFromContents<BrowserWindow>>>,
  Assert<Fits<IpcMain, Main.IpcMainLike>>,
  Assert<Fits<IpcRenderer, IpcRendererLike>>,
  Assert<Fits<Screen, Main.ScreenLike>>,
  Assert<Fits<Shell, Main.ShellLike>>,
  Assert<Fits<{ Tray: typeof Tray; Menu: typeof Menu; nativeImage: typeof nativeImage }, Main.TrayModules>>,
];

type Schema = {
  invoke: { "config:get": () => { theme: string }; "config:set": (patch: { theme?: string }) => Promise<{ theme: string }> };
  send: { "set-dirty": (dirty: boolean) => void };
  events: { config: { theme: string } };
};

// Never called: it only has to compile, against Electron's own types.
export function usage(electron: typeof import("electron")): void {
  const { app, BrowserWindow, ipcMain, ipcRenderer, screen, Tray, Menu, nativeImage } = electron;

  if (requestSingleInstance(app, { window: () => BrowserWindow.getAllWindows()[0] })) {
    void startApp(app, BrowserWindow, { ready: () => undefined, allClosed: "stay" });
  }

  const state = windowState({ screen, store: { get: () => undefined, set: () => undefined }, defaults: { width: 800, height: 600 } });
  const win = new BrowserWindow({ ...state.bounds });
  state.attach(win);
  interceptClose(app, win, () => "hide");
  registerWindowControls(ipcMain, BrowserWindow, { quit: () => app.quit() });

  const tray = createTray(
    { Tray, Menu, nativeImage },
    { icon: ["a.ico", "b.png"], tooltip: "App", menu: () => [{ label: "Quit", click: () => app.quit() }, { type: "separator" }] },
  );
  tray?.refresh();
  // Annotated, Electron checks the items.
  const items = (): MenuItemConstructorOptions[] => [{ label: "Show", click: () => undefined }, { type: "separator" }, { role: "quit" }];
  createTray({ Tray, Menu, nativeImage }, { icon: nativeImage.createEmpty(), tooltip: "App", menu: items });

  const ipc = createIpcMain<Schema>(ipcMain, BrowserWindow);
  ipc.handle("config:get", () => ({ theme: "night" }));
  ipc.handle("config:set", async (patch) => ({ theme: patch.theme ?? "night" }));
  ipc.on("set-dirty", (_e, dirty) => void (dirty satisfies boolean));
  ipc.broadcast("config", { theme: "day" });
  // @ts-expect-error unknown channel
  ipc.handle("config:nope", () => 1);
  // @ts-expect-error wrong return type
  ipc.handle("config:get", () => 42);
  // @ts-expect-error wrong payload
  ipc.broadcast("config", { theme: 1 });

  const bridge = createBridge<Schema>(ipcRenderer);
  const get: () => Promise<{ theme: string }> = bridge.invoke("config:get");
  const set: (patch: { theme?: string }) => Promise<{ theme: string }> = bridge.invoke("config:set");
  const setDirty: (dirty: boolean) => void = bridge.send("set-dirty");
  const off: () => void = bridge.on("config")((c) => void (c.theme satisfies string));
  // @ts-expect-error wrong argument
  void bridge.invoke("config:set")({ theme: 3 });
  void [get, set, setDirty, off];

  // Without a schema, anything goes (the typical first step of a migration).
  const loose = createBridge(ipcRenderer);
  const anything: (id: string, n: number) => Promise<string[]> = loose.invoke("whatever");
  void anything;
  windowControls(ipcRenderer).onMaximized((m) => void (m satisfies boolean));
}

test("Electron's types fit the kit's interfaces (checked at compile time)", () => {});
