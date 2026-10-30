# @btkulka/electron-kit

The Electron scaffolding Ben's seven Electron apps each wrote for themselves: the single-instance lock, saved window positions, loading the dev server or the built page, opening links safely in the browser, close-to-tray and "ask before closing", the tray icon, typed IPC on both sides of the bridge, frameless title-bar controls, the ready/activate/all-closed boilerplate, crash logging, and a web host that serves the app as a web app (its page and IPC over HTTP, for a Benhäus tab or any browser).

It never requires `electron`. Every function takes the Electron objects it needs (`app`, `BrowserWindow`, `screen`, `shell`, `ipcMain`, `ipcRenderer`, `{ Tray, Menu, nativeImage }`) as arguments. The parameter types are small structural interfaces, not Electron's own classes, so any Electron from 28 up fits. This was checked against the Electron 28, 30, 33, 39 and 41 typings the apps have installed. Tests use fakes.

| Import | Runs in | What's in it |
|---|---|---|
| `@btkulka/electron-kit` | anywhere | IPC schema types, `WindowAction`, `windowChannels`. No Node, no Electron. |
| `@btkulka/electron-kit/main` | main process | Everything below under "Main". Uses `node:fs`/`node:path` (window-state file). Re-exports the root. |
| `@btkulka/electron-kit/preload` | preload | `createBridge`, `subscribe`, `windowControls`. No Node built-ins and nothing from `/main` (a test walks both builds' import graphs to prove it). Re-exports the root. |

There is no `/renderer` entry. The renderer only needs types, which it can import from the root.

## Using it from an app

```json
"devDependencies": { "@btkulka/electron-kit": "file:../packages/electron-kit" }
```

Use `file:../../packages/electron-kit` from `nhi/lilith`, and `file:../../../packages/electron-kit` from `norf-hampton-electron/packages/main`. Build the package first (`npm run build` in `D:\source\packages\electron-kit`): apps load its `dist/`, which isn't committed.

**Sandboxed preloads must bundle the preload entry.** A sandboxed preload (`sandbox: true`, or Electron 20+'s default when `sandbox` isn't set) can only `require` `electron` and a few built-ins, never a package from `node_modules`. The bundler has to inline `@btkulka/electron-kit/preload` into the preload file. Benhäus, clipdrift and candybar-manager have sandboxed preloads. Orson, norf-hampton-electron, art-student and lilith run with `sandbox: false`, where a plain `require` also works. A sample preload bundled with esbuild came out at 1.7 KB with `require("electron")` as its only import.

How each bundler gets that:

- **electron-vite** (benhaus, clipdrift, orson, candybar-manager). `externalizeDepsPlugin()` leaves everything in the app's `dependencies` as a runtime `require`, so either:
  - list the package under **`devDependencies`** (it is then bundled, and electron-builder doesn't pack it), or
  - exclude it explicitly in both `main` and `preload`: `externalizeDepsPlugin({ exclude: ["@btkulka/electron-kit"] })`. Orson already passes `{ exclude: ["chalk"] }`, so add the name to that array.

  Do both to be safe. The `exclude` option exists in electron-vite 2.3 (clipdrift) and 5.0 (the others).
- **esbuild** (norf-hampton-electron `packages/main`): `--bundle` already inlines it, since only `electron`, `jsdom`, `tough-cookie` and `better-sqlite3` are external. Nothing to change.
- **tsc, no bundler** (art-student): a CommonJS main and an unbundled preload `require` the package at runtime. Node resolves `exports` → `dist/cjs`. This works because art-student's preload runs with `sandbox: false`. Put the package in **`dependencies`**, and after `npm run dist` check that `app.asar` contains `node_modules/@btkulka/electron-kit/dist/cjs` (electron-builder has to follow the `file:` symlink).
- **Plain JS** (lilith `main.js`/`preload.js`, `sandbox: false`): `require("@btkulka/electron-kit/main")` and `require("@btkulka/electron-kit/preload")` load the CommonJS build. Put it in `dependencies`.

**Types.** The `exports` map has `types`, and `typesVersions` maps `main` and `preload` for TypeScript's old `node`/`node10` resolution, which art-student, candybar-manager and norf `packages/main` use. Consumers compiled cleanly with `module commonjs` + `node10`, `esnext` + `bundler` (benhaus, clipdrift) and `nodenext` in a `type: module` package (orson). TypeScript ≥ 5.4 is needed; every app has 5.6 or newer. A CommonJS file compiled under `nodenext` would get TS1479, because the typings are the ESM build's; no app does this today.

**Electron version.** Electron 28 (Node 18) or newer, for `exports` support and the APIs used. The apps are on Electron 28.3 (clipdrift, art-student), 30.5 (lilith), 33.4 (norf), 39.8 (candybar) and 41 (benhaus, orson).

## API

### Shared (root)

```ts
import type { IpcSchema, WindowAction } from "@btkulka/electron-kit";
import { WINDOW_ACTIONS, isWindowAction, windowChannels } from "@btkulka/electron-kit";
```

- **`IpcSchema`**: describe the app's channels once and both sides are type-checked against it. All three keys are optional. Without a schema, every channel is a `string` with `any` arguments, which is the easy first step of a migration.
  ```ts
  export type AppIpc = {
    invoke: { "config:get": () => Config; "config:set": (patch: Partial<Config>) => Config };  // renderer asks, main answers
    send: { "set-dirty": (dirty: boolean) => void };                                            // renderer tells
    events: { config: Config };                                                                // main pushes one payload
  };
  ```
- **`WindowAction`**: `"minimize" | "maximize" (toggles) | "close" | "quit" | "reload_window" | "force_reload" | "toggle_devtools" | "zoom_in" | "zoom_out" | "reset_zoom" | "toggle_fullscreen"`. These are Benhäus's names, which its MCP `window_control` tool already uses. `WINDOW_ACTIONS` is the list, and `isWindowAction(x)` is the guard.
- **`windowChannels(prefix = "window")`** returns `{ control: "window:control", isMaximized: "window:is-maximized", maximized: "window:maximized" }`.

### Preload

```ts
import { contextBridge, ipcRenderer } from "electron";
import { createBridge, windowControls } from "@btkulka/electron-kit/preload";

const { invoke, send, on } = createBridge<AppIpc>(ipcRenderer);   // or createBridge(ipcRenderer) untyped
contextBridge.exposeInMainWorld("app", {
  config: { get: invoke("config:get"), set: invoke("config:set"), onChange: on("config") },
  setDirty: send("set-dirty"),
  window: windowControls(ipcRenderer),
});
```

- **`createBridge<S>(ipcRenderer)`** returns `{ invoke(ch), send(ch), on(ch) }`. Each call takes a channel and returns a function:
  - `invoke(ch)` gives `(...args) => Promise<result>`.
  - `send(ch)` gives `(...args) => void`.
  - `on(ch)` gives `(callback) => unsubscribe`. The callback gets **the payload only**: the IPC event, which carries `sender`, never reaches the renderer. The returned function removes exactly that listener and is safe to call twice.
- **`subscribe(ipcRenderer, channel, callback)`** is the same as `on`, non-curried. It's Orson's `subscribe(channel, fn)` with `ipcRenderer` first.
- **`windowControls(ipcRenderer, prefix?)`** returns `{ control(action), minimize(), toggleMaximize(), close(), toggleDevTools(), isMaximized(): Promise<boolean>, onMaximized(cb: (maximized: boolean) => void): unsubscribe }`. It pairs with main's `registerWindowControls` and `forwardMaximized` on the same prefix.

### Main

```ts
import { app, BrowserWindow, ipcMain, screen, shell, Tray, Menu, nativeImage } from "electron";
import * as kit from "@btkulka/electron-kit/main";
```

**Single instance**

- **`requestSingleInstance(app, { window?, onSecondInstance? }): boolean`**:
  - The first copy gets `true`, and a later launch then brings `window()` forward.
  - With `onSecondInstance(argv, cwd)`, your handler runs instead and nothing is revealed for you.
  - A second copy gets `false` and has already called `app.quit()`. It must do nothing else.
  ```ts
  if (kit.requestSingleInstance(app, { window: () => mainWindow })) {
    void kit.startApp(app, BrowserWindow, { ready });
  }
  ```
- **`revealWindow(win)`**: restores the window if it's minimized, then calls `show()` (it may be hidden in the tray) and `focus()`. It's a no-op for a null or destroyed window.

**Window position**

- **`windowState({ screen, store, key = "main", defaults, debounceMs = 400 })`** returns `{ bounds, maximized, attach(win) }`. Call it after `ready`.
  ```ts
  const state = kit.windowState({ screen, store: kit.windowStateFile(join(app.getPath("userData"), "windows.json")), key: "main", defaults: { width: 1440, height: 900 } });
  const win = new BrowserWindow({ ...state.bounds, minWidth: 900, show: false });
  state.attach(win);  // maximizes if it was, then saves on move/resize/maximize/unmaximize (debounced) and on close (at once)
  ```
  It restores the saved spot exactly when the window's title bar is still reachable on some display. That means within 50px above a work area's top, at least 50px above its bottom, and with 100px of its width over the work area, so Windows' `x = -7` snaps count. Otherwise it keeps the saved size (shrunk to the primary work area), drops the position (Electron centers the window) and keeps `maximized`. Defaults are shrunk to the primary work area too. It saves `getNormalBounds()`, so a maximized window remembers where it restores to. Nothing is saved while the window is full screen.
- **`windowStateFile(path): WindowStateStore`** stores `{ "<key>": { x, y, width, height, maximized } }`. This is **Benhäus's `windows.json` format**. A missing or corrupt file reads as empty, and the folder is created on first write.
- **`WindowStateStore`** is `{ get(key), set(key, state) }`. Adapt any other store to it (clipdrift's electron-store is shown below).
- Lower level: `restoreWindowState(screen, saved, defaults)`, `trackWindowState(win, save, { debounceMs })`, and the pure `fitWindowBounds(saved, workAreas, primaryWorkArea, defaults)`.

**Loading the page**

- **`loadRenderer(winOrWebContents, { devUrl, file, query?, hash? }): Promise<void>`** loads `devUrl` (with the query and hash added) when it's set and non-empty, and otherwise `loadFile(file, { query, hash })`. Query values are `encodeURIComponent`-encoded in both cases. The promise rejects with Electron's load error; `void` it the way the apps did, or handle it.
  ```ts
  kit.loadRenderer(win, { devUrl: process.env.ELECTRON_RENDERER_URL, file: join(__dirname, "../renderer/index.html"), query: { popout: id } });
  ```
- `devServerUrl(devUrl, query?, hash?)` builds just the URL.

**External links**

- **`openExternal(shell, url, { protocols? }): Promise<boolean>`** opens only `http:`, `https:` and `mailto:` by default, normalized, and resolves `true` when it opened the link and `false` when it refused. On Windows, `shell.openExternal` hands any string to whatever protocol handler claims it (`file:`, `ms-msdt:`, `search-ms:`…), so unchecked URLs can launch programs. A shell failure still rejects. `externalUrl(url, opts)` is the check on its own.
- **`routeNewWindowsToBrowser(webContents, shell, opts?)`**: `target=_blank` and `window.open` are denied and go through `openExternal` instead. Refused and failed opens are dropped quietly. Call it per window, and for webviews from `app.on("web-contents-created")`.

**IPC**

- **`createIpcMain<S>(ipcMain, BrowserWindow)`** returns:
  - `handle(ch, (...args) => result)`, with no event argument.
  - `handleWithEvent(ch, (event, ...args) => result)`.
  - `on(ch, (event, ...args) => void)`.
  - `broadcast(ch, payload)` and `sendTo(win, ch, payload)`.

  All are checked against `S`. Handling a channel twice throws, as in Electron. The event is typed `any`; annotate it as `IpcMainInvokeEvent` yourself if you use it.
- **`sendTo(win, channel, payload?): boolean`** is a no-op (`false`) when the window or its page is gone. It replaces `mainWindow?.webContents.send(…)`, which throws "Object has been destroyed" after a close.
- **`broadcast(BrowserWindow, channel, payload?): number`** sends to every live window (and every page the web host serves) and returns how many windows it reached.
- **`recordIpc(ipcMain): RecordingIpcMain`** wraps Electron's `ipcMain` so what's registered through it is also callable without a renderer, which is what the web host dispatches a page's calls to: `registry.invoke(channel, args)`, `registry.send(channel, args)`, `registry.has(channel)`, `registry.channels()`. `createIpcMain` records for you (`ipc.registry`); an app that calls `ipcMain.handle` directly wraps once (`const ipcMain = recordIpc(electron.ipcMain)`) and uses the wrapped one everywhere. Wrapping twice gives the same recorder. The event a web call carries is `WEB_EVENT` (`sender: null`, `web: true`), so a `handleWithEvent` handler that needs `event.sender` must cope with none.
- `broadcast()` and `IpcMainKit.broadcast` also reach every page the web host serves (`addBroadcastSink` is how it listens). `sendTo` is one window, so it doesn't.

**Frameless title bar**

- **`windowAction(win, action, { contents?, devToolsMode?, quit? }): boolean`**. Reloads and fullscreen act on the window. DevTools and zoom act on `contents` (a webview's page) when it's given. Zoom steps are 0.5 levels. `quit` only works when you pass `quit`. It returns `false` for anything it didn't do.
- **`registerWindowControls(ipcMain, BrowserWindow, { prefix?, quit?, devToolsMode? })`** answers the preload's `windowControls` for whichever window sent the request: a `send` on `<prefix>:control` and an invoke of `<prefix>:is-maximized`. Unknown actions are ignored.
- **`forwardMaximized(win, prefix?)`** sends `<prefix>:maximized` with `true`/`false` on maximize and unmaximize.

**Closing**

- **`interceptClose(app, win, decide: () => "close" | "hide" | "keep")`** decides what the X, Alt+F4 and the taskbar's Close do:
  - `"hide"` sends the window to the tray.
  - `"keep"` vetoes the close while you ask (a dialog, an overlay, the renderer). Call `win.close()` again once you have the answer, and have `decide` return `"close"` then.
  - Once the app is quitting (`before-quit`, or Windows' `session-end` on log-off or shutdown), windows just close and `decide` isn't called. A tray app therefore never blocks a quit or Windows shutting down.
  ```ts
  kit.interceptClose(app, win, () => "hide");                                       // tray app
  kit.interceptClose(app, win, () => (!dirty ? "close" : askSync() ? "close" : "keep"));  // unsaved changes
  ```
- **`isQuitting(app)`** stays `true` once a quit has started, even if a `before-quit` handler delays the quit to clean up.

**Lifecycle**

- **`startApp(app, BrowserWindow, { ready, createWindow?, allClosed?, onError? }): Promise<void>`**:
  - Runs `ready` after `whenReady`. If `ready` throws or rejects, it reports the error (`onError`, or `console.error` by default) and **quits**, rather than leaving the app running with no window.
  - `activate` re-creates the window through `createWindow` when none is open (the macOS dock; this never fires on Windows).
  - `allClosed` controls what happens when the last window closes: `"quit-unless-mac"` (default), `"quit"`, `"stay"` (tray apps) or a function.
  - The returned promise resolves after `ready` and never rejects.

**Tray**

- **`createTray({ Tray, Menu, nativeImage }, { icon, fallbackIcon?, tooltip, menu, onClick?, onDoubleClick? })`** returns `{ tray, refresh(), destroy() }`, or `null`.
  - `icon` is a path, a list of candidate paths (the first that loads wins), a `data:` URL or a `nativeImage`. A missing file counts as not loading.
  - With no icon and no `fallbackIcon` it returns `null` (candybar's behaviour).
  - `menu()` is called again by `refresh()` (clipdrift's rebuilt menu). Annotate it as `(): MenuItemConstructorOptions[]` to get Electron's checks on the items.
  - **Call `destroy()` on quit** or Windows can leave a ghost icon in the notification area. It's safe to call twice.

**Crashes**

- **`logCrashes((kind, error) => …, { app? }): () => void`** reports uncaught exceptions and unhandled rejections in main instead of showing Electron's crash dialog. The app keeps running, as in candybar and Orson. With `app`, it also reports `render-process-gone` (`{ reason, exitCode, url }`; clean exits are skipped). A logger that throws can't loop. It returns a function that removes the listeners.

**Web host: the app as a web app**

- **`createWebHost({ port, rendererDir, preloadFile, ipc, host?, platform?, info?, fallback?, log? }): Promise<WebHost>`** serves the built renderer over HTTP on `127.0.0.1:<port>` and bridges its IPC to the browser, so the same app shows in a Benhäus tab (or any browser) with or without its own window. The page is the built `index.html`, unchanged but for one `<script src="/__kit/preload.js">` added first in `<head>`: the built **preload bundle itself**, wrapped so its `require("electron")` gets a stand-in whose `contextBridge.exposeInMainWorld` sets `window.<key>` and whose `ipcRenderer` goes over HTTP (`POST /__kit/invoke`, `POST /__kit/send`, with `sendSync` as a synchronous request) and a server-sent-events stream (`GET /__kit/events`) for what main pushes. `process`, `module`, `exports`, `__dirname` and `__filename` are supplied; a preload may require nothing but `electron` (bundle anything else in). The page reads `window.__kitWeb` (`{ web: true, platform, port, ...info }`) to tell it's on the web and hide what only a window has (frameless title-bar controls, `<webview>`s). The kit's own window channels are answered in the page (`window:is-maximized` is false; `window:control` reload reloads the page).
  ```ts
  const ipc = kit.createIpcMain<AppIpc>(ipcMain, BrowserWindow);
  const host = await kit.createWebHost({ port: 7791, rendererDir: join(__dirname, "../renderer"), preloadFile: join(__dirname, "../preload/index.cjs"), ipc: ipc.registry, info: { app: "Orange Friction" } });
  host.url;        // http://127.0.0.1:7791
  host.clients();  // pages listening for events
  host.push("tick", payload);   // what webContents.send would do, to every page; broadcast() does this for you
  await host.close();
  ```
  `ipc` is where a page's calls go: `createIpcMain(…).registry`, or `recordIpc(ipcMain).registry` for an app that registers on `ipcMain` directly (see IPC above). Only the page it serves can call in: the IPC routes need a custom header, which a cross-site request can't send without a preflight that isn't answered, and an `Origin` other than the host's own is refused. Paths never leave `rendererDir`; a path with no extension that isn't a file gets `fallback` (`index.html`), for routers.
- **`isWebLaunch(argv = process.argv, env = process.env): boolean`**: whether this launch asked for the web host alone, no window: `--web` on the command line or `ELECTRON_KIT_WEB=1` in the environment (what an app's `npm run web` sets: build, then `electron . --web`). In `second-instance`, pass that launch's argv with an empty env to read its flag rather than this process's. The pattern:
  ```ts
  const webLaunch = kit.isWebLaunch();
  kit.requestSingleInstance(app, { onSecondInstance: (argv) => (win ? kit.revealWindow(win) : !kit.isWebLaunch(argv, {}) && createWindow()) });
  kit.startApp(app, BrowserWindow, { ready: () => { if (!webLaunch) createWindow(); void serveWeb(); }, allClosed: webLaunch ? "stay" : "quit" });
  ```
  Serve in both modes, so a web tab can join a desktop app that's already running (Benhäus adopts whatever answers on the port). Two instances can't share a profile, so a `--web` launch into a running desktop app only reaches its `second-instance`, which is why the desktop app serves too.
- Pure pieces, for tests: `injectWebPreload(html)`, `webPreloadScript(preloadSource, info)`, `fileUnder(root, urlPath)`.

## Replaces

| Repo | File (lines) | What | Replaced by |
|---|---|---|---|
| benhaus | `src/main/index.ts` 36-40, 434-441 | `requestSingleInstanceLock` + `second-instance` (notice link or `show()`) | `requestSingleInstance(app, { onSecondInstance })` |
| benhaus | `src/main/index.ts` 185-191 | `show()` | `revealWindow(main)` |
| benhaus | `src/main/index.ts` 45-54 | `rendererUrl` / `load` | `loadRenderer(win, { devUrl: process.env.ELECTRON_RENDERER_URL, file, hash })` |
| benhaus | `src/main/index.ts` 56-82 (bounds part), 84-95 | saved-bounds check, debounced save | `windowState({ … key }).bounds` / `.attach(win)` |
| benhaus | `src/main/store.ts` 89-96 | `windowState` get/set on `windows.json` | `windowStateFile(join(userData, "windows.json"))` (same format) |
| benhaus | `src/main/index.ts` 96-97 | maximize/unmaximize → `window:maximized` | `forwardMaximized(win)` |
| benhaus | `src/main/index.ts` 112-120 | close → quit overlay while services run | `interceptClose(app, main, decide)` |
| benhaus | `src/main/index.ts` 134-138, 158-161, 468-471 | `setWindowOpenHandler` → `shell.openExternal` | `routeNewWindowsToBrowser(wc, shell, …)` |
| benhaus | `src/main/launch.ts` 22 | `openInBrowser` (unchecked) | `openExternal(shell, url, …)` |
| benhaus | `src/main/index.ts` 167-175 | `allContents` / `broadcast` | `ipc.broadcast` or `broadcast(BrowserWindow, …)` |
| benhaus | `src/main/index.ts` 314 | `handle` wrapper (drops event) | `createIpcMain(ipcMain, BrowserWindow).handle` |
| benhaus | `src/main/index.ts` 421-424, `src/main/windowActions.ts` 9-23 | `window:control` + `windowAction` | `registerWindowControls(ipcMain, BrowserWindow, { quit })` / `windowAction(win, a, { contents })` |
| benhaus | `src/main/index.ts` 481-482, 590 | `whenReady` / `window-all-closed` | `startApp(app, BrowserWindow, { ready, allClosed: "quit" })` |
| benhaus | `src/preload/index.ts` 6-14, 104-106 | `invoke` / `on` helpers, window control | `createBridge(ipcRenderer)` (keep the names `invoke`/`on`), `windowControls` (optional, see the notes) |
| clipdrift | `src/main/main.ts` 52-59, 491-506, 524-548 | electron-store `windowBounds`, display check, debounced save | `windowState({ store: adapter })` |
| clipdrift | `src/main/main.ts` 126-156, 222-250, 486-489, 550-557 | preload path + dev/file load with `?popout=` / `?tray=` | `loadRenderer(win, { devUrl, file, query })` |
| clipdrift | `src/main/main.ts` 212-220 | `showMainWindow` | `revealWindow(mainWindow)` + its `APP_WINDOW_SHOWN` send |
| clipdrift | `src/main/main.ts` 295-352 | `buildTrayMenu` / `rebuildTrayMenu` / `createTray` | `createTray(…)` + `.refresh()` |
| clipdrift | `src/main/main.ts` 454-482, 559-580 | close → background / quit / ask | `interceptClose(app, mainWindow, decide)` |
| clipdrift | `src/main/main.ts` 709-713, 806-818 | `whenReady`, `activate`, `window-all-closed` (stay in tray) | `startApp(…, { allClosed: "stay", createWindow })` |
| clipdrift | `src/main/utils/broadcast.ts` (whole file, used in 9 files) | `broadcastToAllWindows` | `broadcast(BrowserWindow, channel, data)` |
| clipdrift | `src/main/ipc/handlers/discover.ts` 175-200 | URL scheme check before `openExternal` | `openExternal(shell, url, { protocols: ["http:", "https:"] })` |
| clipdrift | `src/main/preload.ts` (26 `on*` blocks, e.g. 193-202) | `ipcRenderer.on` + `removeListener` cleanup | `createBridge(ipcRenderer).on(CH)` |
| candybar-manager | `src/main.ts` 9-16 | `uncaughtException` / `unhandledRejection` | `logCrashes((k, e) => log.error(k, e))` |
| candybar-manager | `src/main.ts` 111-118, 167-202 | tray icon candidates + tray | `createTray(…, { icon: [packaged, dev] })` |
| candybar-manager | `src/main.ts` 152-157 | dev/file load | `loadRenderer` |
| candybar-manager | `src/main.ts` 160, 257-265 | `whenReady`, `activate`, `window-all-closed` | `startApp` |
| candybar-manager | `src/main.ts` 2902-2916 | `toggle-devtools` | `windowAction(win, "toggle_devtools")` |
| candybar-manager | `src/main.ts` 2919-2921 | `open-external` (unchecked) | `openExternal(shell, url)` |
| candybar-manager | `src/lib/jobQueue/ipcBridge.ts` 27-31 | broadcast to all windows | `broadcast(BrowserWindow, …)` |
| candybar-manager | `src/preload.ts` (28 `ipcRenderer.on`, 8 off/remove) | listeners, mostly with no way to unsubscribe | `createBridge(ipcRenderer).on(ch)` |
| art-student | `src/main/main.ts` 215-235 | single-instance lock + `second-instance` (`--paste`) | `requestSingleInstance(app, { onSecondInstance })` |
| art-student | `src/main/main.ts` 72-76 | reveal existing settings window | `revealWindow(mainWindow)` |
| art-student | `src/main/main.ts` 115-121, 247-248 | close → hide unless quitting; `isQuitting` in `before-quit` | `interceptClose(app, win, () => (stopClipboardPolling(), "hide"))` |
| art-student | `src/main/main.ts` 237-245 | `whenReady`, `window-all-closed` (stay), `activate` | `startApp(…, { allClosed: "stay" })` |
| art-student | `src/main/tray.ts` 11-71, 129-135 | icon path + fallback icon, tray, `destroyTray` (keep `createDefaultIcon` 99-127) | `createTray(…, { icon, fallbackIcon: createDefaultIcon() })` + `.destroy()` |
| art-student | `src/preload.ts` 47-56 | `onClipboardUpdate` listener + cleanup | `createBridge(ipcRenderer).on("clipboard-updated")` |
| norf-hampton-electron | `packages/main/src/main.ts` 70-84 | single-instance lock, restore + focus | `requestSingleInstance(app, { window: getMainWindow })` |
| norf-hampton-electron | `packages/main/src/main.ts` 51-56, `window/mainWindow.ts` 34-45 | dev (5174) / file load, `?galleryId=` | `loadRenderer(win, { devUrl, file, query })` |
| norf-hampton-electron | `packages/main/src/main.ts` 86-103 | `whenReady().catch(quit)`, all-closed, activate | `startApp` |
| norf-hampton-electron | `packages/main/src/window/mainWindow.ts` 23-29, 63-69 | maximize → `WINDOW_MAXIMIZED_CHANGED` | `forwardMaximized(win, prefix)` |
| norf-hampton-electron | `packages/main/src/ipc/windowHandlers.ts` 7-35 | minimize / maximize / close / isMaximized | `registerWindowControls(ipcMain, BrowserWindow, { prefix })` |
| norf-hampton-electron | `packages/main/src/preload.ts` (10 `on*` blocks, window calls) | listeners + window calls | `createBridge(ipcRenderer).on`, `windowControls(ipcRenderer, prefix)` |
| orson | `src/desktop/main.ts` 433-438 | `ELECTRON_RENDERER_URL` / file load | `loadRenderer` |
| orson | `src/desktop/main.ts` 384-390 | `emitMaxState` | `forwardMaximized(win, prefix)` (payload becomes a boolean) |
| orson | `src/desktop/main.ts` 392-407, 2298-2308 | close → renderer confirm handshake | `interceptClose(app, mainWindow, decide)` |
| orson | `src/desktop/main.ts` 2286-2297, 2309-2314 | window minimize / maximize / close, DevTools (detached) | `windowAction(win, a, { devToolsMode: "detach" })` or `registerWindowControls` |
| orson | `src/desktop/main.ts` 2794-2797 | `window-all-closed` | `startApp(…, { allClosed: async () => … })` |
| orson | `src/desktop/main.ts` 2805-2813 | `uncaughtException` / `unhandledRejection` → errlog | `logCrashes` |
| orson | `src/desktop/main.ts` (19 `mainWindow?.webContents.send`) | unchecked sends | `sendTo(mainWindow, ch, payload)` |
| orson | `src/desktop/preload.ts` 126-130 | `subscribe` | `subscribe(ipcRenderer, ch, fn)` or `createBridge(ipcRenderer).on(ch)` |
| lilith | `main.js` 119-133 | `LILITH_DEV_SERVER` / dist / fallback load | `loadRenderer(win, { devUrl, file })` |
| lilith | `main.js` 136-154 | unsaved-changes close dialog | `interceptClose(app, win, decide)` |
| lilith | `main.js` 157-168 | `whenReady`, `activate`, `window-all-closed` | `startApp` |
| lilith | `preload.js` 23-30 | `onMenu` multi-channel listener | `subscribe(ipcRenderer, ch, …)` per channel |

Python copies: none. No Python project does Electron scaffolding.

## Migration notes per app

General, for every app:

- **Add the dependency, build, inject.** Add the dependency (see "Using it from an app") and build the package. Then pass Electron's own objects: `requestSingleInstance(app, …)`, `windowState({ screen, … })`, `createTray({ Tray, Menu, nativeImage }, …)` and so on.
- **Delete each copy in the same change** (the packages README's rule), so there's one version.
- **`on(ch)` callbacks get the payload only.** Any renderer code that read a second argument or the event (none found) would break.
- **`openExternal` now refuses anything but http(s) and mailto by default.** Pass `protocols` where a copy opened other schemes on purpose: benhaus's `vscode://` and `claude://` go through `shell` directly in `launch.ts` and should stay that way.
- **`interceptClose` checks the quit flag before `decide` and takes it from `before-quit` and `session-end`.** Drop the app's own `isQuitting`/`confirmedClose` flags where they only served the close handler. Keep a flag where the app's `before-quit` uses it to avoid running twice (benhaus `quitting`, clipdrift `isShuttingDown`).

### benhaus (Electron 41, electron-vite 5, main and preload emitted as `.cjs`, sandboxed preload)

- In `electron.vite.config.ts`, add `{ exclude: ["@btkulka/electron-kit"] }` to both `externalizeDepsPlugin()` calls, or list the package under `devDependencies`. **The preload is sandboxed, so if it isn't inlined the window gets no API at all.**
- **Window state.**
  - `windowStateFile(join(app.getPath("userData"), "windows.json"))` reads the existing file, so saved positions carry over.
  - `windowOptions(key, fallback)` becomes `const s = windowState({ screen, store, key, defaults: fallback })`, spread `s.bounds` into the options, then `s.attach(win)` in place of `if (maximized) win.maximize(); trackBounds(...)`.
  - Keep the focus/blur → `window:focus` lines and `watchPointer`.
  - Delete `windowState` from `store.ts`. Nothing else uses it.
  - **Behaviour differences:**
    - A window saved on a monitor that's gone now keeps its saved size (shrunk to the screen) and its maximized flag. Before, it fell back to 1440×900, not maximized.
    - The 1440×900 default is shrunk on screens smaller than that.
    - Positions are now also saved at once on close.
- **Loading the page.** `load(win, hash)` becomes `loadRenderer(win, { devUrl: process.env.ELECTRON_RENDERER_URL, file: join(__dirname, "../renderer/index.html"), hash })`.
- **Second launch.**
  ```ts
  requestSingleInstance(app, { onSecondInstance: (argv) => { const l = argv.find(isNoticeLink); if (l) openNoticeLink(l); else show(); } })
  ```
  It returns `primary`; keep the `if (!primary) return` guard in `ready`, or only call `startApp` when it's true. `show()` becomes `revealWindow(main)` (keep `summon()`, which toggles minimize, as it is).
- **Closing.**
  ```ts
  interceptClose(app, main, () => procs.running().length ? (show(), void ui("overlay", { overlay: "quit" }).catch(() => app.quit()), "keep") : "close")
  ```
  Keep the `quitting` flag in `before-quit`, which guards the second `app.quit()`.
- **Links.** All three `setWindowOpenHandler` blocks become `routeNewWindowsToBrowser(wc, shell, { protocols: ["http:", "https:", "mailto:"] })`. Before, *any* scheme a web tool opened went to the shell; a tool that relies on another scheme (say `slack:`) needs it added to `protocols`. `openInBrowser` becomes `openExternal(shell, url)`.
- **IPC.**
  - `const ipc = createIpcMain(ipcMain, BrowserWindow)`; then `handle` is `ipc.handle` and `broadcast` is `ipc.broadcast`.
  - `window:control` becomes `registerWindowControls(ipcMain, BrowserWindow, { quit: () => app.quit() })`. The channel is the same, so the renderer is unchanged.
  - `windowAction` in `windowActions.ts` becomes the kit's: `windowAction(win, action, { contents: wc, quit: () => app.quit() })`. `windowKey` stays in Benhäus. `WindowAction` in `shared/types.ts` can re-export the kit's type, since the names are identical.
- **Preload, and the parity check.** `scripts/check-parity.mjs` finds preload channels with the regexes `\b(?:invoke|on)\("…"\)` and `ipcRenderer\.send\("…"`.
  - Destructure `const { invoke, on } = createBridge(ipcRenderer)` and keep every `invoke("…")` / `on("…")` call site as it is.
  - Keep `ipcRenderer.send("window:control", …)` and `ipcRenderer.send("window:returnToMain", …)` written out. If you switch them to `windowControls(...)` or `send("…")`, update the regex in the same change or `npm run check` fails.
  - `mcp.reply` builds its channel at runtime (`mcp:ui:${id}`); leave it as it is.
- **Optional.** The `BENHAUS_DEBUG` `render-process-gone` log could become `logCrashes(…, { app })`.

### clipdrift (Electron 28.3, electron-vite 2.3, CommonJS main, sandboxed preload)

- `externalizeDepsPlugin({ exclude: ["@btkulka/electron-kit"] })` in `main` and `preload`, or list it under `devDependencies`.
- **Window state.** Keep the electron-store file and adapt it, so saved bounds survive:
  ```ts
  const store: WindowStateStore = {
    get: () => { const b = windowStore.get("windowBounds"); return b && { ...b, maximized: b.isMaximized } as SavedWindowState; },
    set: (_k, s) => windowStore.set("windowBounds", { x: s.x, y: s.y, width: s.width, height: s.height, isMaximized: s.maximized }),
  };
  ```
  **Behaviour differences:**
  - Before, a maximized window kept its last unmaximized bounds; now `getNormalBounds()` gives them directly.
  - The visibility test now uses work areas and needs a reachable title bar. Before, it only checked that the top-left corner was on a display's full bounds.
  - Saved positions are written on close too.
  - Note that `x`/`y` are now omitted rather than passed as `undefined`.
- **Loading the page.**
  - `loadRenderer(win, { devUrl: process.env.ELECTRON_RENDERER_URL ?? (process.env.NODE_ENV === "development" ? "http://localhost:5174" : undefined), file: path.join(__dirname, "../renderer/index.html"), query: { popout: paneId } })`. The tray popup uses `query: { tray: "true" }`.
  - The dev URL now encodes the pane id, which was raw before. Pane ids are plain, so nothing changes in practice.
  - Keep the `app.isPackaged ? preload.js : ../preload/index.js` preload path logic.
- **Tray.**
  - `createTray({ Tray, Menu, nativeImage }, { icon: <the data: URL>, tooltip: "ClipDrift", menu: buildTrayMenuItems, onClick: toggleTrayPopup })`.
  - `rebuildTrayMenu()` becomes `trayHandle.refresh()`.
  - Use `trayHandle.tray.getBounds()` for the popup position: the positioning code stays in clipdrift, because only clipdrift positions a popup.
  - In `before-quit`, `tray.destroy()` becomes `trayHandle.destroy()`.
- **Closing.**
  ```ts
  interceptClose(app, mainWindow, () => {
    const b = windowStore.get("closeBehavior");
    if (b === "background") { mainWindow.webContents.send(APP_WINDOW_HIDDEN); return "hide"; }
    if (b === "quit") { app.quit(); return "keep"; }
    void showCloseBehaviorDialog(); return "keep";
  })
  ```
  The tray and menu Quit items can drop `isQuitting = true`. Keep `isShuttingDown`.
- **Lifecycle.** `startApp(app, BrowserWindow, { ready: <the async whenReady body>, createWindow, allClosed: "stay" })`. The headless branch calls `app.exit(1)` itself, which is fine. **Note:** an exception in the ready body now quits the app; before, it was an unhandled rejection.
- **Single instance: don't add a lock blindly.** ClipDrift has none, and `--headless` (`npm run serve`) runs a second Electron process next to the desktop app.
- **Broadcasting and links.**
  - `utils/broadcast.ts`: replace `broadcastToAllWindows(ch, data)` with `broadcast(BrowserWindow, ch, data)` in the 9 files that use it, then delete the file.
  - `DISCOVER_OPEN_SOURCE`: `if (!(await openExternal(shell, url, { protocols: ["http:", "https:"] }))) return failure(INVALID_INPUT, "Only http and https links can be opened")`. Keep the `validateParams` string check.
- **Preload.** Each `onX: (cb) => { const handler = …; ipcRenderer.on(CH, handler); return () => ipcRenderer.removeListener(CH, handler) }` becomes `onX: on(IPC_CHANNELS.X)` (typed in place with `as (cb: (t: BackgroundTask) => void) => () => void`, or via an `IpcSchema`). The invoke wrappers with explicit return types can stay as they are.

### candybar-manager (Electron 39, electron-vite 5, CommonJS main, `sandbox: true` preload)

- `externalizeDepsPlugin({ exclude: [...] })` in `main` and `preload`, or list it under `devDependencies`. The preload is sandboxed.
- **Crashes.** Lines 9-16 become `logCrashes((kind, err) => log.error(kind, err))`.
- **Tray.**
  ```ts
  trayHandle = createTray({ Tray, Menu, nativeImage }, { icon: [path.join(app.getAppPath(), "assets", "tray-icon.png"), path.join(__dirname, "..", "..", "assets", "tray-icon.png")], tooltip: "Track Lab", menu: () => [...], onClick: () => revealWindow(BrowserWindow.getAllWindows()[0]) })
  ```
  It returns `null` when neither icon exists, as before. Destroy it in `will-quit`; candybar didn't destroy it before.
- **Loading the page.** Prefer `devUrl: process.env.ELECTRON_RENDERER_URL`, which electron-vite sets with the real port. Today the code hard-codes `http://localhost:5173` when `NODE_ENV === "development"`.
- **Lifecycle.** `startApp(app, BrowserWindow, { ready, createWindow })`. The default `allClosed` is candybar's current behaviour; keep the "All windows closed" log line by passing a function if wanted.
- **IPC handlers.**
  - `toggle-devtools`: `windowAction(win, "toggle_devtools")`.
  - `open-external`: `await openExternal(shell, url)`. It now ignores non-web URLs; the renderer only passes Qobuz and Beatport links.
  - `jobQueue/ipcBridge.ts`: `broadcast(BrowserWindow, ch, payload)`.
- **Preload.** `onX: (cb) => ipcRenderer.on(ch, …)` returned the `ipcRenderer` (no way to unsubscribe); `on(ch)` returns an unsubscribe function, which is harmless for callers that ignore it.
  - **`offStoreCartProgress`** tags `callback.__wrapped`, which doesn't survive `contextBridge`: the renderer's function arrives as a fresh proxy each call, so it never unsubscribed. Replace it with the unsubscribe returned by `onStoreCartProgress` and update `src/renderer` accordingly.
  - `offUsbHealthProgress` (`removeAllListeners`) can stay, or move to the returned unsubscribe.

### art-student (Electron 28.3, tsc only, CommonJS, `moduleResolution: node`, unbundled `sandbox: false` preload)

- Put the package in **`dependencies`**: the `file:` link is `require`d at runtime from `dist/main/*.js` and `dist/preload.js`. Types resolve through `typesVersions`. **Check that `npm run dist` packs it** (see "Using it from an app").
- **Single instance and lifecycle.** In `main()`, the normal branch becomes:
  ```ts
  if (!requestSingleInstance(app, { onSecondInstance: (argv) => { const o = parseCliArgs(argv); if (o.paste) void saveClipboardImage(o.paste); else createSettingsWindow(); } })) return;
  startApp(app, BrowserWindow, { ready: initializeApp, createWindow: createSettingsWindow, allClosed: "stay" });
  ```
  Keep `before-quit` for the clean-up, but without `isQuitting`. The CLI branches (`--paste`/`--register`/`--unregister`) stay ahead of the lock, as now.
  - **Behaviour difference:** `activate` only creates a window when none is open; art-student opened settings on every `activate`. That's macOS only, so it doesn't matter on Windows.
- **Settings window.**
  - The early return becomes `if (mainWindow) return revealWindow(mainWindow)`. This also restores a minimized window, which before stayed minimized.
  - The close handler becomes `interceptClose(app, mainWindow, () => { stopClipboardPolling(); return "hide"; })`.
  - `loadFile(htmlPath)` can stay, or become `loadRenderer(mainWindow, { file: htmlPath })`.
- **Tray.** In `tray.ts`:
  ```ts
  createTray({ Tray, Menu, nativeImage }, { icon: getIconPath(), fallbackIcon: createDefaultIcon(), tooltip: "Art Student", menu: () => [...], onDoubleClick: onOpenSettings })
  ```
  `destroyTray` becomes `handle.destroy()`. Keep `createDefaultIcon` and `handleSaveClipboard`.
- **Preload.** `onClipboardUpdate: createBridge(ipcRenderer).on("clipboard-updated")`; the invoke wrappers can use `invoke(…)`. It keeps `sandbox: false`, so the unbundled `require` works.

### norf-hampton-electron (Electron 33, esbuild for `packages/main`, `sandbox: false`, Vite renderer)

- Add the dependency to `packages/main/package.json` (`file:../../../packages/electron-kit`). esbuild inlines it, so no config change is needed. `tsconfig` uses `moduleResolution: node`, which `typesVersions` covers.
- **Single instance and lifecycle.**
  ```ts
  if (requestSingleInstance(app, { window: getMainWindow })) startApp(app, BrowserWindow, { ready: initialize, onError: (e) => console.error("[Main] Failed to initialize:", e) })
  ```
  It already quits on failure. Keep `createWindow` out (`initialize` re-registers IPC, which throws on a second run; on Windows `activate` never fires anyway).
- **Loading the page.** `loadRenderer(win, { devUrl: process.env.NODE_ENV === "development" ? "http://localhost:5174" : undefined, file: path.join(__dirname, "../../renderer/dist/index.html"), query: { galleryId } })`.
- **Window controls.**
  - Main: `registerWindowControls(ipcMain, BrowserWindow, { prefix: "nh:window" })` and `forwardMaximized(win, "nh:window")` in both window factories. Delete those handlers from `windowHandlers.ts`, but keep `WINDOW_PLAY_IN_NEW` and the `WINDOW_CLOSING` send on close.
  - Preload: `const w = windowControls(ipcRenderer, "nh:window")`, then `windowMinimize: w.minimize, windowMaximize: w.toggleMaximize, windowClose: w.close, windowIsMaximized: w.isMaximized, onWindowMaximizedChanged: w.onMaximized`, so the renderer API keeps its shape.
  - Remove the now-unused `WINDOW_*` channel constants from `@norfhampton/common`.
- **Preload listeners.** Each `onX` block becomes `on(IPC_CHANNELS.X)` from `createBridge(ipcRenderer)`.

### orson (Electron 41, electron-vite 5, `type: module`, main and preload emitted as `.cjs`, `sandbox: false`)

- `externalizeDepsPlugin({ exclude: ["chalk", "@btkulka/electron-kit"] })` in `main`, and add the same exclude to `preload`. Or list it under `devDependencies`.
- **Loading the page.** `await loadRenderer(mainWindow, { devUrl: process.env.ELECTRON_RENDERER_URL, file: resolve(__dirname, "..", "renderer", "index.html") })`.
- **Maximize state.** `emitMaxState` becomes `forwardMaximized(mainWindow, "orson:window")`. The payload is now a bare boolean, so adapt the preload: `onState: (fn) => subscribe(ipcRenderer, "orson:window:maximized", (m: boolean) => fn({ maximized: m }))`. Or keep `emitMaxState`; the renderer doesn't call `window.onState` today.
- **Closing.**
  ```ts
  interceptClose(app, mainWindow, () => {
    if (confirmedClose || closeRequestPending) return "close";   // second X while the modal is up quits, as now
    closeRequestPending = true; sendTo(mainWindow, CHANNELS.windowCloseRequest); return "keep";
  })
  ```
  `windowCloseConfirm` sets `confirmedClose = true` and calls `mainWindow.close()`; `windowCloseCancel` clears `closeRequestPending`.
- **DevTools.** `devToggleDevTools` becomes `windowAction(mainWindow, "toggle_devtools", { devToolsMode: "detach" })`. The minimize, maximize and close handlers can use `windowAction` too. They are `ipcMain.handle` channels, and `toggleMaximize` returns the new state; the renderer doesn't use them, so either keep them or move to `registerWindowControls` (a send, no return value).
- **Lifecycle.** `window-all-closed` becomes `startApp(app, BrowserWindow, { ready: <whenReady body>, allClosed: async () => { await shutdown(); if (process.platform !== "darwin") app.quit(); } })`. Keep `before-quit` (`app.exit(0)` after `shutdown`).
  - **Behaviour difference:** a throw in the ready body now quits. Orson already wraps `seedLocationVisualsAtBoot` so a seed failure won't.
- **Crashes.**
  ```ts
  logCrashes((kind, err) => { console.error(`[main] ${kind}`, err); writeErrlogCause(kind === "uncaughtException" ? "main:uncaught" : "main:unhandled", kind === "uncaughtException" ? "uncaught exception" : "unhandled promise rejection", err); })
  ```
- **Sends.** Each `mainWindow?.webContents.send(ch, x)` becomes `sendTo(mainWindow, ch, x)`. There are 19; the old form throws after the window is destroyed (during shutdown, for example).
- **Preload.** Its `subscribe(channel, fn)` becomes the kit's `subscribe(ipcRenderer, channel, fn)`, or `const { on } = createBridge(ipcRenderer)` and `onEvent: on(CHANNELS.jobsEvent)`.
- **Single instance: none today.** Don't add one without thinking about the Playwright harness (`ORSON_USERDATA`, `ORSON_CDP_PORT`). Electron's lock is per `userData` folder, so isolated profiles would still run side by side.

### lilith (Electron 30, plain CommonJS JS, Vite renderer only, `sandbox: false`)

- Put the package in **`dependencies`** (`file:../../packages/electron-kit`). `main.js`: `const kit = require("@btkulka/electron-kit/main")`; `preload.js`: `const { createBridge, subscribe } = require("@btkulka/electron-kit/preload")`.
- **Loading the page.** Keep the dist-or-source choice and hand it over:
  ```js
  kit.loadRenderer(win, { devUrl: process.env.LILITH_DEV_SERVER, file: app.isPackaged || fs.existsSync(distIndex) ? distIndex : fallback })
  ```
  Use the sync `existsSync` from `fs`; the async `fs.access` callback can go.
- **Closing.**
  ```js
  kit.interceptClose(app, win, () => !rendererDirty ? "close" : dialog.showMessageBoxSync(win, {...}) === 0 ? "close" : "keep")
  ```
  This drops `confirmedClose` and the recursive `win.close()`.
- **Lifecycle.** `kit.startApp(app, BrowserWindow, { ready: async () => { library.open(); await rebuildAppMenu(); createWindow(); }, createWindow })`. A failing `library.open()` now quits with a logged error instead of leaving a windowless process.
- **Preload.** `onMenu(handler)` becomes `const offs = MENU_CHANNELS.map((ch) => subscribe(ipcRenderer, ch, (p) => handler(ch, p))); return () => offs.forEach((off) => off());`. The invoke wrappers can use `createBridge(ipcRenderer).invoke(…)`. `sendToFocused` stays (focused-window semantics), but its `send` can be `kit.sendTo(win, channel, payload)`.

## Not shared, and why

- **`ELECTRON_RUN_AS_NODE` stripping in launch scripts** (norf `scripts/start-*.js`, orson `strip-electron-env.ts`, benhaus `scripts/run.mjs`/`launch.cjs`) belongs to `proc-kit`.
- **CSP.** Every app sets it as a static `<meta>` in its `index.html`, with its own schemes (`local-file:`, `asset:`, `userdata:`…). There's no code to share, and no app sets CSP headers.
- **Navigation guards (`will-navigate`).** No app has one, so none was added.
- **Custom file protocols.** clipdrift's `local-file://` streams with ranges and swaps in upscaled files; orson's `asset://`/`userdata://` are root-confined with a traversal guard; candybar's `media://` transcodes AIFF. They are three different behaviours. A root-confined `serveFile(path, range)` could become its own package later.
- **Loggers** (art-student's rotating file log, clipdrift's shared logger, candybar's electron-log, orson's errlog) use different backends. `logCrashes` takes a callback instead.
- **Settings stores** (benhaus `store.ts`, art-student `settings.ts`, clipdrift electron-store): only the window-position part was repeated; general JSON settings are a separate concern.
- **One-app pieces:**
  - benhaus: `ui()` request/response, `windowKey`, `summon()`, pop-out management, webview shortcut forwarding.
  - clipdrift: tray-popup positioning and pop-out crash recovery.
  - lilith: the Recent menu.
  - The application menus, which are each app's own template.
  - `registerSchemesAsPrivileged`, `setAppUserModelId` and command-line switches: one line each, with app-specific values.

## Working on it

```
npm run build       # ESM (dist/esm) + CommonJS (dist/cjs)
npm run typecheck
npm test            # build, then node --test on dist/esm/**/*.test.js
```

`src/electron-compat.test.ts` type-checks Electron's real `BrowserWindow`, `App`, `IpcMain`, `IpcRenderer`, `Screen`, `Shell` and `Tray`/`Menu`/`nativeImage` against the kit's interfaces, and checks that a typed schema rejects wrong channels, arguments and payloads. `electron` is a dev dependency for those types only, installed with `ELECTRON_SKIP_BINARY_DOWNLOAD=1`: the package never `require`s it, and its binary isn't downloaded. `src/test/fakes.ts` holds the fake `BrowserWindow`, `app`, `ipcMain` and `ipcRenderer` the tests use; it is left out of the CommonJS build.
