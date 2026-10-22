import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { WINDOW_ACTIONS, isWindowAction, windowChannels } from "./index.js";

describe("window actions", () => {
  test("Benhäus's action names, quit included", () => {
    assert.deepEqual(
      [...WINDOW_ACTIONS].sort(),
      ["close", "force_reload", "maximize", "minimize", "quit", "reload_window", "reset_zoom", "toggle_devtools", "toggle_fullscreen", "zoom_in", "zoom_out"],
    );
    assert.equal(isWindowAction("zoom_in"), true);
    for (const bad of ["Zoom_In", "", null, 3, "toString", "__proto__"]) assert.equal(isWindowAction(bad), false, String(bad));
  });

  test("channels default to Benhäus's window:control / window:maximized", () => {
    assert.deepEqual(windowChannels(), { control: "window:control", isMaximized: "window:is-maximized", maximized: "window:maximized" });
    assert.equal(windowChannels("nh:window").control, "nh:window:control");
  });
});
