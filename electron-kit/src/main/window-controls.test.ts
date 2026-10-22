import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { FakeContents, FakeIpcMain, FakeIpcRenderer, FakeWindow } from "../test/fakes.js";
import { windowControls } from "../preload/window-controls.js";
import type { WindowAction } from "../window-actions.js";
import { forwardMaximized, registerWindowControls, windowAction } from "./window-controls.js";

describe("windowAction", () => {
  test("minimize, maximize (toggles), close, fullscreen", () => {
    const win = new FakeWindow();
    assert.equal(windowAction(win, "maximize"), true);
    assert.equal(win.maximized, true);
    windowAction(win, "maximize");
    assert.equal(win.maximized, false);
    windowAction(win, "minimize");
    assert.equal(win.minimized, true);
    windowAction(win, "toggle_fullscreen");
    assert.equal(win.fullScreen, true);
    windowAction(win, "toggle_fullscreen");
    assert.equal(win.fullScreen, false);
    windowAction(win, "close");
    assert.equal(win.destroyed, true);
  });

  test("reloads act on the window's page; zoom and DevTools on the page the key came from", () => {
    const win = new FakeWindow();
    const webview = new FakeContents();
    windowAction(win, "reload_window", { contents: webview });
    windowAction(win, "force_reload", { contents: webview });
    assert.equal(win.webContents.reloads, 1);
    assert.equal(win.webContents.hardReloads, 1);
    windowAction(win, "zoom_in", { contents: webview });
    windowAction(win, "zoom_in", { contents: webview });
    assert.equal(webview.zoom, 1);
    windowAction(win, "zoom_out", { contents: webview });
    assert.equal(webview.zoom, 0.5);
    windowAction(win, "reset_zoom", { contents: webview });
    assert.equal(webview.zoom, 0);
    windowAction(win, "toggle_devtools", { contents: webview });
    assert.equal(webview.devTools, true);
    assert.equal(win.webContents.devTools, false);
  });

  test("DevTools in a fixed mode (Orson opens them detached)", () => {
    const win = new FakeWindow();
    windowAction(win, "toggle_devtools", { devToolsMode: "detach" });
    assert.equal(win.webContents.devTools, true);
    assert.equal(win.webContents.devToolsMode, "detach");
    windowAction(win, "toggle_devtools", { devToolsMode: "detach" });
    assert.equal(win.webContents.devTools, false);
  });

  test("quit only with a quit handler; unknown actions do nothing", () => {
    const win = new FakeWindow();
    assert.equal(windowAction(win, "quit"), false);
    let quit = 0;
    assert.equal(windowAction(win, "quit", { quit: () => quit++ }), true);
    assert.equal(quit, 1);
    assert.equal(windowAction(win, "explode" as WindowAction), false);
    assert.deepEqual(win.calls, []);
  });
});

describe("registerWindowControls + preload windowControls", () => {
  function wire(prefix?: string, quit?: () => void) {
    const ipcMain = new FakeIpcMain();
    const win = new FakeWindow();
    const sender = { id: 1 };
    registerWindowControls(ipcMain, { fromWebContents: (wc: unknown) => (wc === sender ? win : null) }, { prefix, quit });
    const ipcRenderer = new FakeIpcRenderer();
    const controls = windowControls(ipcRenderer, prefix);
    // Deliver what the preload sent to main, as Electron would.
    const deliver = () => {
      for (const [channel, ...args] of ipcRenderer.sentMessages.splice(0)) ipcMain.emit(channel as string, { sender }, ...args);
    };
    return { ipcMain, win, sender, ipcRenderer, controls, deliver };
  }

  test("the renderer's buttons act on the window that sent them", () => {
    const { win, controls, deliver, ipcRenderer } = wire();
    controls.toggleMaximize();
    assert.deepEqual(ipcRenderer.sentMessages, [["window:control", "maximize"]]);
    deliver();
    assert.equal(win.maximized, true);
    controls.minimize();
    controls.toggleDevTools();
    deliver();
    assert.equal(win.minimized, true);
    assert.equal(win.webContents.devTools, true);
    controls.close();
    deliver();
    assert.equal(win.destroyed, true);
  });

  test("garbage actions and unknown senders are ignored", () => {
    const { ipcMain, win } = wire();
    ipcMain.emit("window:control", { sender: { id: 1 } }, "maximize"); // not the registered sender object
    ipcMain.emit("window:control", { sender: {} }, "close");
    assert.equal(win.maximized, false);
    assert.equal(win.destroyed, false);
  });

  test("isMaximized answers for the sender's window", async () => {
    const { ipcMain, win, sender } = wire();
    assert.equal(await ipcMain.invoke("window:is-maximized", { sender }), false);
    win.maximize();
    assert.equal(await ipcMain.invoke("window:is-maximized", { sender }), true);
    assert.equal(await ipcMain.invoke("window:is-maximized", { sender: {} }), false);
  });

  test("a prefix moves every channel; quit passes through when given", () => {
    let quits = 0;
    const { ipcMain, ipcRenderer, controls, deliver } = wire("orson:window", () => quits++);
    controls.control("quit");
    assert.deepEqual(ipcRenderer.sentMessages[0], ["orson:window:control", "quit"]);
    deliver();
    assert.equal(quits, 1);
    assert.ok(ipcMain.handlers.has("orson:window:is-maximized"));
  });

  test("forwardMaximized tells the page, and onMaximized hears it as a boolean", () => {
    const win = new FakeWindow();
    forwardMaximized(win);
    win.maximize();
    win.unmaximize();
    assert.deepEqual(win.webContents.sent, [
      ["window:maximized", true],
      ["window:maximized", false],
    ]);
    win.webContents.destroyed = true;
    assert.doesNotThrow(() => win.maximize());

    const ipcRenderer = new FakeIpcRenderer();
    const heard: boolean[] = [];
    const off = windowControls(ipcRenderer).onMaximized((m) => heard.push(m));
    ipcRenderer.emit("window:maximized", {}, true);
    ipcRenderer.emit("window:maximized", {}, 0);
    off();
    ipcRenderer.emit("window:maximized", {}, true);
    assert.deepEqual(heard, [true, false]);
  });

  test("preload isMaximized invokes the right channel", async () => {
    const ipcRenderer = new FakeIpcRenderer();
    ipcRenderer.answer = true;
    assert.equal(await windowControls(ipcRenderer).isMaximized(), true);
    assert.deepEqual(ipcRenderer.invoked, [["window:is-maximized"]]);
  });
});
