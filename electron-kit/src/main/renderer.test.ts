import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { FakeContents } from "../test/fakes.js";
import { devServerUrl, loadRenderer } from "./renderer.js";

const file = "C:\\Apps\\Thing\\out\\renderer\\index.html";

describe("loadRenderer", () => {
  test("the dev server when there is one", async () => {
    const wc = new FakeContents();
    await loadRenderer(wc, { devUrl: "http://localhost:5173", file });
    assert.deepEqual(wc.loads, [{ url: "http://localhost:5173/", argCount: 1 }]);
  });

  test("query and hash go on the dev URL, encoded like loadFile's", async () => {
    const wc = new FakeContents();
    await loadRenderer(wc, { devUrl: "http://127.0.0.1:5174", file, query: { popout: "pane 1/a&b" }, hash: "popout=tools%2Fx" });
    assert.equal(wc.loads[0]?.url, "http://127.0.0.1:5174/?popout=pane%201%2Fa%26b#popout=tools%2Fx");
  });

  test("existing dev-URL parameters are kept", () => {
    assert.equal(devServerUrl("http://localhost:5173/app/?v=1", { tray: "true" }), "http://localhost:5173/app/?v=1&tray=true");
  });

  test("no dev URL (unset, null or empty): the built file", async () => {
    for (const devUrl of [undefined, null, ""]) {
      const wc = new FakeContents();
      await loadRenderer(wc, { devUrl, file });
      assert.deepEqual(wc.loads, [{ file, options: undefined, argCount: 1 }], String(devUrl));
    }
  });

  test("query and hash go to loadFile's options", async () => {
    const wc = new FakeContents();
    await loadRenderer(wc, { file, query: { galleryId: "42" } });
    await loadRenderer(wc, { file, hash: "popout=x" });
    await loadRenderer(wc, { file, query: {}, hash: "" });
    assert.deepEqual(
      wc.loads.map((l) => l.options),
      [{ query: { galleryId: "42" } }, { hash: "popout=x" }, undefined],
    );
  });

  test("a failed load rejects for the caller to handle", async () => {
    const target = {
      loadURL: () => Promise.reject(new Error("ERR_CONNECTION_REFUSED")),
      loadFile: () => Promise.resolve(),
    };
    await assert.rejects(loadRenderer(target, { devUrl: "http://localhost:1", file }), /ERR_CONNECTION_REFUSED/);
  });
});
