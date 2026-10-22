import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { FakeApp, FakeContents } from "../test/fakes.js";
import { logCrashes, type CrashKind } from "./crash.js";

type Listener = (...args: unknown[]) => void;
const added = (event: string, before: Function[]) => process.listeners(event as "exit").filter((l) => !before.includes(l)) as Listener[];

describe("logCrashes", () => {
  test("reports uncaught exceptions and unhandled rejections, and can be undone", () => {
    const beforeEx = process.listeners("uncaughtException");
    const beforeRej = process.listeners("unhandledRejection");
    const seen: Array<[CrashKind, unknown]> = [];
    const off = logCrashes((kind, err) => seen.push([kind, err]));
    const [onEx] = added("uncaughtException", beforeEx);
    const [onRej] = added("unhandledRejection", beforeRej);
    assert.equal(typeof onEx, "function");
    assert.equal(typeof onRej, "function");
    // Called directly: emitting them for real would trip node:test's own handlers.
    const boom = new Error("boom");
    onEx(boom);
    onRej("nope", Promise.resolve());
    assert.deepEqual(seen, [
      ["uncaughtException", boom],
      ["unhandledRejection", "nope"],
    ]);
    off();
    assert.equal(added("uncaughtException", beforeEx).length, 0);
    assert.equal(added("unhandledRejection", beforeRej).length, 0);
  });

  test("a logger that throws doesn't throw out of the handler", (t) => {
    const consoleError = t.mock.method(console, "error", () => undefined);
    const before = process.listeners("uncaughtException");
    const off = logCrashes(() => {
      throw new Error("disk full");
    });
    const [onEx] = added("uncaughtException", before);
    assert.doesNotThrow(() => onEx?.(new Error("x")));
    assert.equal(consoleError.mock.callCount(), 1);
    off();
  });

  test("with the app: dead renderers are reported with why and where; clean exits aren't", () => {
    const app = new FakeApp();
    const seen: Array<[CrashKind, unknown]> = [];
    const off = logCrashes((kind, err) => seen.push([kind, err]), { app });
    const contents = new FakeContents();
    contents.url = "http://localhost:5173/?popout=a";
    app.emit("render-process-gone", {}, contents, { reason: "crashed", exitCode: -1073741819 });
    app.emit("render-process-gone", {}, contents, { reason: "clean-exit", exitCode: 0 });
    app.emit("render-process-gone", {}, undefined, { reason: "oom", exitCode: 1 });
    assert.deepEqual(seen, [
      ["render-process-gone", { reason: "crashed", exitCode: -1073741819, url: "http://localhost:5173/?popout=a" }],
      ["render-process-gone", { reason: "oom", exitCode: 1 }],
    ]);
    off();
    assert.equal(app.listenerCount("render-process-gone"), 0);
  });
});
