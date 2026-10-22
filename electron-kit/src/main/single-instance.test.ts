import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { FakeApp, FakeWindow } from "../test/fakes.js";
import { requestSingleInstance, revealWindow } from "./single-instance.js";

describe("requestSingleInstance", () => {
  test("a second copy quits at once and listens for nothing", () => {
    const app = new FakeApp();
    app.lock = false;
    assert.equal(requestSingleInstance(app, { window: () => new FakeWindow() }), false);
    assert.equal(app.quits, 1);
    assert.equal(app.listenerCount("second-instance"), 0);
  });

  test("the first copy brings its window forward on a second launch", () => {
    const app = new FakeApp();
    const win = new FakeWindow();
    win.minimized = true;
    win.visible = false;
    assert.equal(requestSingleInstance(app, { window: () => win }), true);
    assert.equal(app.quits, 0);
    app.emit("second-instance", {}, ["app.exe"], "C:\\");
    assert.deepEqual(win.calls, ["restore", "show", "focus"]);
  });

  test("the window is looked up at launch time, and may not exist yet", () => {
    const app = new FakeApp();
    let win: FakeWindow | undefined;
    requestSingleInstance(app, { window: () => win });
    assert.doesNotThrow(() => app.emit("second-instance", {}, [], ""));
    win = new FakeWindow();
    app.emit("second-instance", {}, [], "");
    assert.deepEqual(win.calls, ["show", "focus"]);
  });

  test("onSecondInstance gets the launch's argv and cwd and replaces the reveal", () => {
    const app = new FakeApp();
    const win = new FakeWindow();
    const seen: unknown[] = [];
    requestSingleInstance(app, { window: () => win, onSecondInstance: (argv, cwd) => seen.push(argv, cwd) });
    app.emit("second-instance", {}, ["app.exe", "--paste", "D:\\Art"], "D:\\Art");
    assert.deepEqual(seen, [["app.exe", "--paste", "D:\\Art"], "D:\\Art"]);
    assert.deepEqual(win.calls, []);
  });
});

describe("revealWindow", () => {
  test("restores only when minimized, always shows and focuses", () => {
    const win = new FakeWindow();
    revealWindow(win);
    assert.deepEqual(win.calls, ["show", "focus"]);
  });

  test("missing or destroyed windows are ignored", () => {
    assert.doesNotThrow(() => revealWindow(null));
    assert.doesNotThrow(() => revealWindow(undefined));
    const win = new FakeWindow();
    win.destroyed = true;
    revealWindow(win);
    assert.deepEqual(win.calls, []);
  });
});
