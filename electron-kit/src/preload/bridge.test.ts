import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { FakeIpcRenderer } from "../test/fakes.js";
import { createBridge, subscribe } from "./bridge.js";

describe("createBridge", () => {
  test("invoke(channel) is a function that invokes with its arguments", async () => {
    const ipc = new FakeIpcRenderer();
    const { invoke } = createBridge(ipc);
    const override = invoke("config:override");
    assert.equal(await override("tool-a", { pinned: true }), "answer");
    assert.equal(await invoke("config:get")(), "answer");
    assert.deepEqual(ipc.invoked, [["config:override", "tool-a", { pinned: true }], ["config:get"]]);
  });

  test("send(channel) fires and forgets", () => {
    const ipc = new FakeIpcRenderer();
    createBridge(ipc).send("set-dirty")(true);
    assert.deepEqual(ipc.sentMessages, [["set-dirty", true]]);
  });

  test("on(channel) hands over the payload only, never the IPC event", () => {
    const ipc = new FakeIpcRenderer();
    const got: unknown[][] = [];
    createBridge(ipc).on("config")((...args: unknown[]) => got.push(args));
    ipc.emit("config", { sender: "ipcRenderer itself" }, { theme: "night" }, "extra");
    assert.deepEqual(got, [[{ theme: "night" }]]);
  });

  test("unsubscribing removes that callback only, and only once", () => {
    const ipc = new FakeIpcRenderer();
    const { on } = createBridge(ipc);
    const a: unknown[] = [];
    const b: unknown[] = [];
    const offA = on("tick")((p) => a.push(p));
    on("tick")((p) => b.push(p));
    ipc.emit("tick", {}, 1);
    offA();
    offA();
    ipc.emit("tick", {}, 2);
    assert.deepEqual(a, [1]);
    assert.deepEqual(b, [1, 2]);
    assert.equal(ipc.listenerCount("tick"), 1);
  });

  test("the same callback subscribed twice is two subscriptions", () => {
    const ipc = new FakeIpcRenderer();
    const seen: unknown[] = [];
    const cb = (p: unknown) => seen.push(p);
    const off1 = subscribe(ipc, "x", cb);
    subscribe(ipc, "x", cb);
    ipc.emit("x", {}, "once");
    off1();
    ipc.emit("x", {}, "twice");
    assert.deepEqual(seen, ["once", "once", "twice"]);
  });
});
