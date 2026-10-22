import assert from "node:assert/strict";
import { describe, mock, test } from "node:test";
import { FakeApp } from "../test/fakes.js";
import { startApp } from "./lifecycle.js";

const noWindows = { getAllWindows: () => [] as unknown[] };

function withPlatform(platform: NodeJS.Platform, fn: () => void) {
  const original = Object.getOwnPropertyDescriptor(process, "platform")!;
  Object.defineProperty(process, "platform", { value: platform });
  try {
    fn();
  } finally {
    Object.defineProperty(process, "platform", original);
  }
}

describe("startApp", () => {
  test("ready runs once Electron is ready, and the promise waits for it", async () => {
    const app = new FakeApp();
    const order: string[] = [];
    const done = startApp(app, noWindows, {
      ready: async () => {
        order.push("ready");
      },
    });
    order.push("sync");
    await done;
    assert.deepEqual(order, ["sync", "ready"]);
    assert.equal(app.quits, 0);
  });

  test("a ready that throws or rejects is reported and the app quits (no windowless zombie)", async () => {
    for (const ready of [
      () => {
        throw new Error("db locked");
      },
      () => Promise.reject(new Error("db locked")),
    ]) {
      const app = new FakeApp();
      const errors: unknown[] = [];
      await startApp(app, noWindows, { ready, onError: (e) => errors.push(e) });
      assert.match(String(errors[0]), /db locked/);
      assert.equal(app.quits, 1);
    }
  });

  test("without onError the failure goes to console.error", async (t) => {
    const logged = t.mock.method(console, "error", () => undefined);
    const app = new FakeApp();
    await startApp(app, noWindows, {
      ready: () => {
        throw new Error("boom");
      },
    });
    assert.equal(logged.mock.callCount(), 1);
    assert.equal(app.quits, 1);
  });

  test("last window closed: quits by default, except on macOS", () => {
    withPlatform("win32", () => {
      const app = new FakeApp();
      void startApp(app, noWindows, { ready: () => undefined });
      app.emit("window-all-closed");
      assert.equal(app.quits, 1);
    });
    withPlatform("darwin", () => {
      const app = new FakeApp();
      void startApp(app, noWindows, { ready: () => undefined });
      app.emit("window-all-closed");
      assert.equal(app.quits, 0);
    });
  });

  test("allClosed: 'quit' everywhere, 'stay' for tray apps, or a function", () => {
    withPlatform("darwin", () => {
      const app = new FakeApp();
      void startApp(app, noWindows, { ready: () => undefined, allClosed: "quit" });
      app.emit("window-all-closed");
      assert.equal(app.quits, 1);
    });
    const stay = new FakeApp();
    void startApp(stay, noWindows, { ready: () => undefined, allClosed: "stay" });
    stay.emit("window-all-closed");
    assert.equal(stay.quits, 0);
    const custom = new FakeApp();
    const handler = mock.fn(async () => undefined);
    void startApp(custom, noWindows, { ready: () => undefined, allClosed: handler });
    custom.emit("window-all-closed");
    assert.equal(handler.mock.callCount(), 1);
    assert.equal(custom.quits, 0);
  });

  test("activate re-creates the window only when none is open", () => {
    const app = new FakeApp();
    const windows: unknown[] = [];
    let created = 0;
    void startApp(app, { getAllWindows: () => windows }, { ready: () => undefined, createWindow: () => created++ });
    app.emit("activate");
    assert.equal(created, 1);
    windows.push({});
    app.emit("activate");
    assert.equal(created, 1);
  });
});
