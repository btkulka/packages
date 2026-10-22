import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { fitWindowBounds } from "./bounds.js";

// A 1920×1080 primary with a 40px taskbar, a 2560×1440 to its right and a
// 1920×1080 to its left (negative coordinates, as Windows reports them).
const primary = { x: 0, y: 0, width: 1920, height: 1040 };
const right = { x: 1920, y: 0, width: 2560, height: 1400 };
const left = { x: -1920, y: 0, width: 1920, height: 1040 };
const all = [primary, right, left];
const defaults = { width: 1440, height: 900 };

describe("fitWindowBounds", () => {
  test("nothing saved: the default size, centered", () => {
    const r = fitWindowBounds(undefined, all, primary, defaults);
    assert.deepEqual(r, { width: 1440, height: 900, maximized: false });
    assert.ok(!("x" in r) && !("y" in r), "no position keys, so Electron centers");
  });

  test("defaults larger than the primary work area shrink to fit it", () => {
    const small = { x: 0, y: 0, width: 1366, height: 728 };
    assert.deepEqual(fitWindowBounds(undefined, [small], small, defaults), { width: 1366, height: 728, maximized: false });
  });

  test("saved on a display that is still there: exactly as saved, maximized too", () => {
    const saved = { x: 200, y: 120, width: 1200, height: 800, maximized: true };
    assert.deepEqual(fitWindowBounds(saved, all, primary, defaults), saved);
  });

  test("saved on the right-hand and left-hand monitors", () => {
    const onRight = { x: 2200, y: 100, width: 1600, height: 1000 };
    assert.deepEqual(fitWindowBounds(onRight, all, primary, defaults), { ...onRight, maximized: false });
    const onLeft = { x: -1800, y: 50, width: 1200, height: 800 };
    assert.deepEqual(fitWindowBounds(onLeft, all, primary, defaults), { ...onLeft, maximized: false });
  });

  test("a window Windows snapped slightly past the edge (x = -7) stays put", () => {
    const snapped = { x: -7, y: 0, width: 974, height: 1047 };
    assert.deepEqual(fitWindowBounds(snapped, [primary], primary, defaults), { ...snapped, maximized: false });
  });

  test("saved on a monitor that's gone: size kept (shrunk to fit), centered, still maximized", () => {
    const saved = { x: 2200, y: 100, width: 2400, height: 1300, maximized: true };
    const r = fitWindowBounds(saved, [primary], primary, defaults);
    assert.deepEqual(r, { width: 1920, height: 1040, maximized: true });
    assert.ok(!("x" in r));
  });

  test("a title bar out of reach is off-screen", () => {
    // Far above the top edge.
    assert.ok(!("x" in fitWindowBounds({ x: 100, y: -200, width: 800, height: 600 }, [primary], primary, defaults)));
    // Below the bottom of the work area.
    assert.ok(!("x" in fitWindowBounds({ x: 100, y: 1030, width: 800, height: 600 }, [primary], primary, defaults)));
    // Only 50px showing at the right edge: too little to grab.
    assert.ok(!("x" in fitWindowBounds({ x: 1870, y: 100, width: 800, height: 600 }, [primary], primary, defaults)));
    // 100px showing at the left edge is enough.
    assert.equal(fitWindowBounds({ x: -700, y: 100, width: 800, height: 600 }, [primary], primary, defaults).x, -700);
  });

  test("garbage reads as nothing saved", () => {
    for (const bad of [null, 42, "x", [], {}, { x: "1", y: 0, width: 800, height: 600 }, { x: 0, y: 0, width: 0, height: 600 }, { x: NaN, y: 0, width: 800, height: 600 }, { x: 0, y: 0, width: Infinity, height: 600 }]) {
      assert.deepEqual(fitWindowBounds(bad, all, primary, defaults), { width: 1440, height: 900, maximized: false }, JSON.stringify(bad));
    }
  });

  test("fractional bounds (display scaling) are rounded", () => {
    assert.deepEqual(fitWindowBounds({ x: 100.4, y: 99.6, width: 800.5, height: 600.2 }, all, primary, defaults), {
      x: 100,
      y: 100,
      width: 801,
      height: 600,
      maximized: false,
    });
  });

  test("maximized must be exactly true", () => {
    assert.equal(fitWindowBounds({ x: 0, y: 0, width: 800, height: 600, maximized: "yes" }, all, primary, defaults).maximized, false);
  });
});
