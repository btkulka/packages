import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { FakeApp, FakeWindow } from "../test/fakes.js";
import { interceptClose, isQuitting } from "./close.js";

describe("interceptClose", () => {
  test("'hide' keeps the app in the tray", () => {
    const app = new FakeApp();
    const win = new FakeWindow();
    interceptClose(app, win, () => "hide");
    win.close();
    assert.equal(win.destroyed, false);
    assert.equal(win.visible, false);
  });

  test("'keep' vetoes so the app can ask; closing again after the answer goes through", () => {
    const app = new FakeApp();
    const win = new FakeWindow();
    let asked = 0;
    let confirmed = false;
    interceptClose(app, win, () => {
      if (confirmed) return "close";
      asked++;
      return "keep";
    });
    win.close();
    assert.equal(win.destroyed, false);
    assert.equal(win.visible, true, "not hidden");
    assert.equal(asked, 1);
    confirmed = true; // the renderer's modal (or a dialog) said yes
    win.close();
    assert.equal(win.destroyed, true);
  });

  test("'close' lets it close", () => {
    const app = new FakeApp();
    const win = new FakeWindow();
    interceptClose(app, win, () => "close");
    win.close();
    assert.equal(win.destroyed, true);
  });

  test("while quitting, windows close without being asked", () => {
    const app = new FakeApp();
    const win = new FakeWindow();
    let asked = 0;
    interceptClose(app, win, () => {
      asked++;
      return "hide";
    });
    assert.equal(isQuitting(app), false);
    app.quit();
    assert.equal(isQuitting(app), true);
    win.close();
    assert.equal(win.destroyed, true);
    assert.equal(asked, 0);
  });

  test("Windows ending the session counts as quitting (a hidden-to-tray app must not block shutdown)", () => {
    const app = new FakeApp();
    const win = new FakeWindow();
    interceptClose(app, win, () => "hide");
    app.emit("session-end");
    win.close();
    assert.equal(win.destroyed, true);
  });

  test("one quit listener per app, however many windows", () => {
    const app = new FakeApp();
    for (let i = 0; i < 3; i++) interceptClose(app, new FakeWindow(), () => "close");
    isQuitting(app);
    assert.equal(app.listenerCount("before-quit"), 1);
    assert.equal(app.listenerCount("session-end"), 1);
  });
});
