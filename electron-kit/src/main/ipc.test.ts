import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { FakeIpcMain, FakeWindow } from "../test/fakes.js";
import { broadcast, createIpcMain, sendTo } from "./ipc.js";

const event = { sender: { id: 7 } };

describe("createIpcMain", () => {
  test("handle gets only the renderer's arguments", async () => {
    const ipcMain = new FakeIpcMain();
    const ipc = createIpcMain(ipcMain, { getAllWindows: () => [] });
    ipc.handle("sum", (a: number, b: number) => a + b);
    ipc.handle("later", async (x: string) => `${x}!`);
    assert.equal(await ipcMain.invoke("sum", event, 2, 3), 5);
    assert.equal(await ipcMain.invoke("later", event, "hi"), "hi!");
  });

  test("handleWithEvent and on get the event first", async () => {
    const ipcMain = new FakeIpcMain();
    const ipc = createIpcMain(ipcMain, { getAllWindows: () => [] });
    ipc.handleWithEvent("who", (e: typeof event, n: number) => e.sender.id * n);
    assert.equal(await ipcMain.invoke("who", event, 6), 42);
    const heard: unknown[] = [];
    ipc.on("set-dirty", (e: typeof event, dirty: boolean) => heard.push(e.sender.id, dirty));
    ipcMain.emit("set-dirty", event, true);
    assert.deepEqual(heard, [7, true]);
  });

  test("a channel handled twice throws, as in Electron", () => {
    const ipc = createIpcMain(new FakeIpcMain(), { getAllWindows: () => [] });
    ipc.handle("x", () => 1);
    assert.throws(() => ipc.handle("x", () => 2), /second handler/);
  });

  test("handler errors reach the renderer's invoke", async () => {
    const ipcMain = new FakeIpcMain();
    createIpcMain(ipcMain, { getAllWindows: () => [] }).handle("boom", () => {
      throw new Error("nope");
    });
    await assert.rejects(ipcMain.invoke("boom", event), /nope/);
  });

  test("broadcast and sendTo through the kit", () => {
    const a = new FakeWindow();
    const ipc = createIpcMain(new FakeIpcMain(), { getAllWindows: () => [a] });
    assert.equal(ipc.broadcast("config", { theme: "night" }), 1);
    assert.equal(ipc.sendTo(a, "chat", 1), true);
    assert.deepEqual(a.webContents.sent, [["config", { theme: "night" }], ["chat", 1]]);
  });
});

describe("broadcast / sendTo", () => {
  test("every live window gets it; closed ones are skipped instead of throwing", () => {
    const live1 = new FakeWindow();
    const live2 = new FakeWindow();
    const closed = new FakeWindow();
    closed.destroyed = true;
    const pageGone = new FakeWindow();
    pageGone.webContents.destroyed = true;
    assert.equal(broadcast({ getAllWindows: () => [live1, closed, pageGone, live2] }, "notices", [1]), 2);
    assert.deepEqual(live1.webContents.sent, [["notices", [1]]]);
    assert.deepEqual(live2.webContents.sent, [["notices", [1]]]);
  });

  test("sendTo a missing or closed window is a no-op", () => {
    assert.equal(sendTo(null, "x"), false);
    assert.equal(sendTo(undefined, "x"), false);
    const w = new FakeWindow();
    w.destroyed = true;
    assert.equal(sendTo(w, "x"), false);
  });

  test("no payload sends undefined", () => {
    const w = new FakeWindow();
    sendTo(w, "session:reset");
    assert.deepEqual(w.webContents.sent, [["session:reset", undefined]]);
  });
});
