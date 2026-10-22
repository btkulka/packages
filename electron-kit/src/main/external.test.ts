import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { FakeContents, sleep } from "../test/fakes.js";
import { externalUrl, openExternal, routeNewWindowsToBrowser } from "./external.js";

function fakeShell(fail = false) {
  const opened: string[] = [];
  return {
    opened,
    openExternal: (url: string) => {
      opened.push(url);
      return fail ? Promise.reject(new Error("no handler")) : Promise.resolve();
    },
  };
}

describe("externalUrl", () => {
  test("web and mail links pass, normalized", () => {
    assert.equal(externalUrl("https://example.com/a?b=1"), "https://example.com/a?b=1");
    assert.equal(externalUrl("  HTTP://Example.COM  "), "http://example.com/");
    assert.equal(externalUrl("mailto:ben@example.com"), "mailto:ben@example.com");
  });

  test("anything that could launch a local program is refused", () => {
    for (const bad of [
      "file:///C:/Windows/System32/calc.exe",
      "javascript:alert(1)",
      "ms-msdt:/id PCWDiagnostic",
      "search-ms:query=x",
      "vbscript:msgbox",
      "C:\\Windows\\notepad.exe",
      "\\\\server\\share\\x.exe",
      "not a url",
      "",
      undefined,
      42,
    ]) {
      assert.equal(externalUrl(bad), undefined, String(bad));
    }
  });

  test("the allowed schemes can be narrowed or widened, any case", () => {
    assert.equal(externalUrl("mailto:a@b.c", { protocols: ["http:", "https:"] }), undefined);
    assert.equal(externalUrl("vscode://file/x", { protocols: ["VSCODE:"] }), "vscode://file/x");
  });
});

describe("openExternal", () => {
  test("opens allowed links once and says so", async () => {
    const shell = fakeShell();
    assert.equal(await openExternal(shell, "https://example.com"), true);
    assert.deepEqual(shell.opened, ["https://example.com/"]);
  });

  test("refuses others without touching the shell", async () => {
    const shell = fakeShell();
    assert.equal(await openExternal(shell, "file:///C:/x.exe"), false);
    assert.deepEqual(shell.opened, []);
  });

  test("a shell failure still rejects", async () => {
    await assert.rejects(openExternal(fakeShell(true), "https://example.com"), /no handler/);
  });
});

describe("routeNewWindowsToBrowser", () => {
  test("new windows are denied and opened in the browser instead", () => {
    const wc = new FakeContents();
    const shell = fakeShell();
    routeNewWindowsToBrowser(wc, shell);
    assert.deepEqual(wc.openHandler?.({ url: "https://example.com/x" }), { action: "deny" });
    assert.deepEqual(wc.openHandler?.({ url: "file:///C:/x.exe" }), { action: "deny" });
    assert.deepEqual(shell.opened, ["https://example.com/x"]);
  });

  test("a failing shell doesn't become an unhandled rejection", async () => {
    const wc = new FakeContents();
    routeNewWindowsToBrowser(wc, fakeShell(true));
    wc.openHandler?.({ url: "https://example.com" });
    await sleep(10); // an unhandled rejection would fail the run here
  });
});
