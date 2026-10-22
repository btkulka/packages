import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import { FakeWindow, sleep } from "../test/fakes.js";
import type { SavedWindowState } from "./bounds.js";
import { restoreWindowState, trackWindowState, windowState, windowStateFile, type WindowStateStore } from "./window-state.js";

const root = mkdtempSync(join(tmpdir(), "electron-kit-ws-"));
after(() => rmSync(root, { recursive: true, force: true }));

const screen = {
  getAllDisplays: () => [{ workArea: { x: 0, y: 0, width: 1920, height: 1040 } }],
  getPrimaryDisplay: () => ({ workArea: { x: 0, y: 0, width: 1920, height: 1040 } }),
};

function memoryStore(initial: Record<string, SavedWindowState> = {}): WindowStateStore & { data: Record<string, SavedWindowState> } {
  const data = { ...initial };
  return { data, get: (k) => data[k], set: (k, s) => void (data[k] = s) };
}

describe("windowStateFile", () => {
  test("creates its folder on first write and keeps windows apart", () => {
    const file = join(root, "nested", "deeper", "windows.json");
    const store = windowStateFile(file);
    assert.equal(store.get("main"), undefined);
    store.set("main", { x: 1, y: 2, width: 3, height: 4, maximized: true });
    store.set("popout:a", { x: 5, y: 6, width: 7, height: 8 });
    assert.deepEqual(store.get("main"), { x: 1, y: 2, width: 3, height: 4, maximized: true });
    assert.deepEqual(store.get("popout:a"), { x: 5, y: 6, width: 7, height: 8 });
    assert.deepEqual(Object.keys(JSON.parse(readFileSync(file, "utf8"))), ["main", "popout:a"]);
  });

  test("reads a file Benhäus already wrote", () => {
    const file = join(root, "benhaus-windows.json");
    writeFileSync(file, JSON.stringify({ main: { x: 10, y: 20, width: 1440, height: 900, maximized: false } }, null, 2));
    assert.deepEqual(windowStateFile(file).get("main"), { x: 10, y: 20, width: 1440, height: 900, maximized: false });
  });

  test("a corrupt or odd file reads as empty and is replaced on the next write", () => {
    const dir = join(root, "corrupt");
    mkdirSync(dir);
    for (const [name, text] of [["torn.json", '{"main": {"x": 1'], ["array.json", "[1,2]"], ["null.json", "null"], ["value.json", '{"main": 5}']]) {
      const file = join(dir, name);
      writeFileSync(file, text);
      const store = windowStateFile(file);
      assert.equal(store.get("main"), undefined, name);
      store.set("main", { x: 1, y: 1, width: 2, height: 2 });
      assert.deepEqual(store.get("main"), { x: 1, y: 1, width: 2, height: 2 }, name);
    }
  });
});

describe("restoreWindowState", () => {
  test("uses the displays the screen reports", () => {
    assert.deepEqual(restoreWindowState(screen, { x: 50, y: 50, width: 800, height: 600 }, { width: 1, height: 1 }), {
      x: 50,
      y: 50,
      width: 800,
      height: 600,
      maximized: false,
    });
    assert.deepEqual(restoreWindowState(screen, { x: 5000, y: 50, width: 800, height: 600 }, { width: 1, height: 1 }), {
      width: 800,
      height: 600,
      maximized: false,
    });
  });
});

describe("trackWindowState", () => {
  test("moves and resizes settle into one save of the normal bounds", async () => {
    const win = new FakeWindow();
    const saves: SavedWindowState[] = [];
    trackWindowState(win, (s) => saves.push(s), { debounceMs: 15 });
    win.bounds = { x: 10, y: 10, width: 900, height: 700 };
    win.emit("move");
    win.emit("resize");
    win.emit("move");
    assert.equal(saves.length, 0, "debounced");
    await sleep(40);
    assert.deepEqual(saves, [{ x: 10, y: 10, width: 900, height: 700, maximized: false }]);
  });

  test("maximizing saves the flag with the bounds it restores to", async () => {
    const win = new FakeWindow();
    const saves: SavedWindowState[] = [];
    trackWindowState(win, (s) => saves.push(s), { debounceMs: 5 });
    win.maximize();
    await sleep(25);
    assert.deepEqual(saves.at(-1), { x: 100, y: 100, width: 800, height: 600, maximized: true });
    win.unmaximize();
    await sleep(25);
    assert.equal(saves.at(-1)?.maximized, false);
  });

  test("closing saves at once, without waiting for the debounce", () => {
    const win = new FakeWindow();
    const saves: SavedWindowState[] = [];
    trackWindowState(win, (s) => saves.push(s), { debounceMs: 10_000 });
    win.emit("move");
    win.close();
    assert.equal(saves.length, 1);
  });

  test("nothing is saved for a destroyed or full-screen window, or nonsense bounds", async () => {
    const saves: SavedWindowState[] = [];
    const gone = new FakeWindow();
    trackWindowState(gone, (s) => saves.push(s), { debounceMs: 5 });
    gone.emit("move");
    gone.destroyed = true;
    const full = new FakeWindow();
    full.fullScreen = true;
    trackWindowState(full, (s) => saves.push(s), { debounceMs: 5 });
    full.emit("resize");
    const odd = new FakeWindow();
    odd.bounds = { x: 0, y: 0, width: 0, height: 600 };
    trackWindowState(odd, (s) => saves.push(s), { debounceMs: 5 });
    odd.emit("resize");
    await sleep(30);
    assert.deepEqual(saves, []);
  });
});

describe("windowState", () => {
  test("restores, maximizes the new window when it was, and saves under its key", async () => {
    const store = memoryStore({ "popout:x": { x: 40, y: 40, width: 1000, height: 700, maximized: true } });
    const state = windowState({ screen, store, key: "popout:x", defaults: { width: 800, height: 600 }, debounceMs: 5 });
    assert.deepEqual(state.bounds, { x: 40, y: 40, width: 1000, height: 700 });
    assert.equal(state.maximized, true);
    const win = new FakeWindow();
    state.attach(win);
    assert.equal(win.maximized, true);
    await sleep(25);
    assert.equal(store.data["popout:x"]?.maximized, true);
  });

  test("first run: defaults, key 'main', not maximized", () => {
    const store = memoryStore();
    const state = windowState({ screen, store, defaults: { width: 1440, height: 900 } });
    assert.deepEqual(state.bounds, { width: 1440, height: 900 });
    const win = new FakeWindow();
    state.attach(win);
    assert.equal(win.maximized, false);
    win.close();
    assert.ok(store.data.main, "saved under 'main' on close");
  });
});
