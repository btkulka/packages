import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { describe, test } from "node:test";
import { createTray, type ImageLike } from "./tray.js";

class Image implements ImageLike {
  constructor(readonly source: string, readonly empty = false) {}
  isEmpty() {
    return this.empty;
  }
}

function fakeElectron(existing: string[] = [], throwing: string[] = []) {
  const made: FakeTray[] = [];
  class FakeTray extends EventEmitter {
    tooltip = "";
    menus: unknown[] = [];
    destroyed = 0;
    constructor(readonly image: Image) {
      super();
      made.push(this);
    }
    setToolTip(t: string) {
      this.tooltip = t;
    }
    setContextMenu(m: unknown) {
      this.menus.push(m);
    }
    destroy() {
      this.destroyed++;
    }
    isDestroyed() {
      return this.destroyed > 0;
    }
  }
  return {
    made,
    Tray: FakeTray,
    Menu: { buildFromTemplate: (items: unknown[]) => ({ items }) },
    nativeImage: {
      // Like Electron, a missing file gives an empty image rather than an error.
      createFromPath: (p: string) => {
        if (throwing.includes(p)) throw new Error("bad path");
        return new Image(p, !existing.includes(p));
      },
      createFromDataURL: (u: string) => new Image(u, !u.startsWith("data:image/png;base64,")),
    },
  };
}

const menu = () => [{ label: "Show" }, { type: "separator" }, { label: "Quit" }];

describe("createTray", () => {
  test("the first candidate icon that loads wins (packaged path, then dev path)", () => {
    const e = fakeElectron(["D:\\dev\\assets\\tray.png"]);
    const t = createTray(e, { icon: ["C:\\app\\resources\\tray.png", "D:\\dev\\assets\\tray.png"], tooltip: "Track Lab", menu });
    assert.ok(t);
    assert.equal(e.made[0]?.image.source, "D:\\dev\\assets\\tray.png");
    assert.equal(e.made[0]?.tooltip, "Track Lab");
    assert.deepEqual(e.made[0]?.menus, [{ items: menu() }]);
  });

  test("a data: URL icon, or a nativeImage passed in", () => {
    const e = fakeElectron();
    createTray(e, { icon: "data:image/png;base64,AAAA", tooltip: "ClipDrift", menu });
    assert.equal(e.made[0]?.image.source, "data:image/png;base64,AAAA");
    const img = new Image("generated");
    createTray(e, { icon: img, tooltip: "x", menu });
    assert.equal(e.made[1]?.image, img);
  });

  test("nothing loads: the fallback, or null and no tray at all", () => {
    const e = fakeElectron([], ["C:\\weird"]);
    const fallback = createTray(e, { icon: ["C:\\missing.ico", "C:\\weird"], fallbackIcon: "data:image/png;base64,BBBB", tooltip: "x", menu });
    assert.ok(fallback);
    assert.equal(e.made[0]?.image.source, "data:image/png;base64,BBBB");
    assert.equal(createTray(e, { icon: "C:\\missing.ico", tooltip: "x", menu }), null);
    assert.equal(createTray(e, { icon: new Image("empty", true), tooltip: "x", menu }), null);
    assert.equal(e.made.length, 1);
  });

  test("refresh rebuilds the menu; destroy is safe twice and stops refreshes", () => {
    const e = fakeElectron(["C:\\tray.ico"]);
    let label = "Ask on close";
    const t = createTray(e, { icon: "C:\\tray.ico", tooltip: "x", menu: () => [{ label }] })!;
    label = "Ask on close (currently: quit)";
    t.refresh();
    assert.deepEqual(e.made[0]?.menus, [{ items: [{ label: "Ask on close" }] }, { items: [{ label: "Ask on close (currently: quit)" }] }]);
    t.destroy();
    t.destroy();
    t.refresh();
    assert.equal(e.made[0]?.destroyed, 1);
    assert.equal(e.made[0]?.menus.length, 2);
  });

  test("click and double-click handlers", () => {
    const e = fakeElectron(["C:\\tray.ico"]);
    const hits: string[] = [];
    createTray(e, { icon: "C:\\tray.ico", tooltip: "x", menu, onClick: () => hits.push("click"), onDoubleClick: () => hits.push("double") });
    e.made[0]?.emit("click");
    e.made[0]?.emit("double-click");
    assert.deepEqual(hits, ["click", "double"]);
  });
});
