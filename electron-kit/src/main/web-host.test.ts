import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { FakeIpcMain } from "../test/fakes.js";
import { broadcast, createIpcMain, recordIpc } from "./ipc.js";
import { createWebHost, fileUnder, injectWebPreload, isWebLaunch, webPreloadScript, type WebHost } from "./web-host.js";

// A preload the way electron-vite emits one: CommonJS, requiring only electron.
const PRELOAD = `"use strict";
const electron = require("electron");
electron.contextBridge.exposeInMainWorld("app", {
  sum: (a, b) => electron.ipcRenderer.invoke("sum", a, b),
  tell: (x) => electron.ipcRenderer.send("tell", x),
  onTick: (cb) => { const fn = (_e, n) => cb(n); electron.ipcRenderer.on("tick", fn); return () => electron.ipcRenderer.removeListener("tick", fn); },
  platform: process.platform,
});
`;

describe("isWebLaunch", () => {
  test("reads --web from argv or ELECTRON_KIT_WEB from the environment", () => {
    assert.equal(isWebLaunch(["electron", "."], {}), false);
    assert.equal(isWebLaunch(["electron", ".", "--web"], {}), true);
    assert.equal(isWebLaunch(["electron", "."], { ELECTRON_KIT_WEB: "1" }), true);
    assert.equal(isWebLaunch(["electron", "."], { ELECTRON_KIT_WEB: "0" }), false);
  });
});

describe("injectWebPreload", () => {
  test("puts the script first in <head>, once", () => {
    const html = `<!doctype html><html><head><meta charset="utf-8"><title>x</title></head><body><script type="module" src="/a.js"></script></body></html>`;
    const out = injectWebPreload(html);
    assert.ok(out.startsWith(`<!doctype html><html><head><script src="/__kit/preload.js"></script><meta`));
    assert.equal(injectWebPreload(out), out);
  });
  test("goes first without a head", () => {
    assert.ok(injectWebPreload("<p>hi</p>").startsWith("<script"));
  });
});

describe("fileUnder", () => {
  test("stays inside the root", () => {
    const root = join(tmpdir(), "kit-root");
    assert.equal(fileUnder(root, "/index.html"), join(root, "index.html"));
    assert.equal(fileUnder(root, "/"), root);
    assert.equal(fileUnder(root, "/../secret"), undefined);
    assert.equal(fileUnder(root, "/a/../../secret"), undefined);
    assert.equal(fileUnder(root, "/%2e%2e/secret"), undefined);
  });
});

describe("webPreloadScript", () => {
  test("wraps the bundle with a require that only knows electron", () => {
    const js = webPreloadScript(PRELOAD, { platform: "win32", web: true });
    assert.ok(js.includes('"use strict";\nconst electron = require("electron");'));
    assert.ok(js.includes("__kitRequire"));
    assert.ok(js.includes('"platform":"win32"'));
  });
});

describe("createWebHost", () => {
  let dir: string;
  let host: WebHost;
  let ipcMain: FakeIpcMain;
  const told: unknown[] = [];

  before(async () => {
    dir = await mkdtemp(join(tmpdir(), "kit-web-"));
    await mkdir(join(dir, "renderer", "assets"), { recursive: true });
    await writeFile(join(dir, "renderer", "index.html"), `<!doctype html><html><head><meta charset="utf-8"></head><body><script type="module" src="/assets/app.js"></script></body></html>`);
    await writeFile(join(dir, "renderer", "assets", "app.js"), "console.log(1)");
    await writeFile(join(dir, "preload.cjs"), PRELOAD);
    ipcMain = new FakeIpcMain();
    const ipc = createIpcMain(ipcMain, { getAllWindows: () => [] });
    ipc.handle("sum", (a: number, b: number) => a + b);
    ipc.handle("boom", () => {
      throw new Error("nope");
    });
    ipc.on("tell", (_e: unknown, x: unknown) => told.push(x));
    // Port 0 picks a free one; the host reports what it got.
    host = await createWebHost({ port: 0, rendererDir: join(dir, "renderer"), preloadFile: join(dir, "preload.cjs"), ipc: ipc.registry, platform: "win32", info: { app: "test" } });
    assert.notEqual(host.port, 0);
    assert.equal(host.url, `http://127.0.0.1:${host.port}`);
  });
  after(() => host.close());

  const url = (p: string) => `${host.url}${p}`;

  test("serves the page with the preload injected, and assets as they are", async () => {
    const html = await (await fetch(url("/"))).text();
    assert.ok(html.includes('<head><script src="/__kit/preload.js"></script><meta'));
    const js = await fetch(url("/assets/app.js"));
    assert.equal(js.headers.get("content-type"), "text/javascript; charset=utf-8");
    assert.equal(await js.text(), "console.log(1)");
    assert.equal((await fetch(url("/missing.png"))).status, 404);
    // A router path gets the page.
    assert.ok((await (await fetch(url("/inbox/42"))).text()).includes("<script"));
  });

  test("serves the preload shim with the bundle and the info", async () => {
    const js = await (await fetch(url("/__kit/preload.js"))).text();
    assert.ok(js.includes('exposeInMainWorld("app"'));
    assert.ok(js.includes('"app":"test"'));
    assert.ok(js.includes('"platform":"win32"'));
    const info = (await (await fetch(url("/__kit/info"))).json()) as { web: boolean; channels: string[] };
    assert.equal(info.web, true);
    assert.deepEqual(info.channels.sort(), ["boom", "sum", "tell"]);
  });

  test("invoke reaches the handler and brings back its answer or error", async () => {
    const call = (channel: string, args: unknown[], headers: Record<string, string> = { "x-kit-ipc": "1" }) =>
      fetch(url("/__kit/invoke"), { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify({ channel, args }) });
    assert.deepEqual(await (await call("sum", [2, 3])).json(), { ok: true, result: 5 });
    assert.deepEqual(await (await call("boom", [])).json(), { ok: false, error: "nope" });
    assert.deepEqual(await (await call("nothing", [])).json(), { ok: false, error: "No handler registered for 'nothing'" });
    assert.equal((await call("sum", [1, 1], {})).status, 403);
    assert.equal((await call("sum", [1, 1], { "x-kit-ipc": "1", origin: "http://evil.example" })).status, 403);
    assert.equal((await call("sum", [1, 1], { "x-kit-ipc": "1", origin: `http://localhost:${host.port}` })).status, 200);
  });

  test("send reaches the listeners", async () => {
    const r = await fetch(url("/__kit/send"), { method: "POST", headers: { "content-type": "application/json", "x-kit-ipc": "1" }, body: JSON.stringify({ channel: "tell", args: ["hi"] }) });
    assert.deepEqual(await r.json(), { ok: true, heard: 1 });
    assert.deepEqual(told, ["hi"]);
  });

  test("broadcasts reach the page's event stream", async () => {
    const res = await fetch(url("/__kit/events"));
    const reader = res.body!.getReader();
    const read = async (): Promise<string> => new TextDecoder().decode((await reader.read()).value);
    assert.equal(await read(), ": connected\n\n");
    for (let i = 0; i < 20 && host.clients() === 0; i++) await new Promise((r) => setTimeout(r, 10));
    assert.equal(host.clients(), 1);
    assert.equal(broadcast({ getAllWindows: () => [] }, "tick", 7), 0);
    assert.equal(await read(), 'event: ipc\ndata: {"channel":"tick","args":[7]}\n\n');
    host.push("tick", 8, "two");
    assert.equal(await read(), 'event: ipc\ndata: {"channel":"tick","args":[8,"two"]}\n\n');
    await reader.cancel();
  });

  test("a path that leaves the folder is refused", async () => {
    assert.equal((await fetch(url("/..%2F..%2Fpreload.cjs"))).status, 403);
  });
});

describe("recordIpc", () => {
  test("records handlers and listeners while passing them to ipcMain", async () => {
    const ipcMain = new FakeIpcMain();
    const rec = recordIpc(ipcMain);
    rec.handle("double", (_e, n: number) => n * 2);
    const heard: unknown[] = [];
    rec.on("say", (_e, x: unknown) => heard.push(x));
    assert.equal(await ipcMain.invoke("double", { sender: null }, 4), 8);
    assert.equal(await rec.registry.invoke("double", [5]), 10);
    assert.equal(rec.registry.send("say", ["yo"]), 1);
    assert.deepEqual(heard, ["yo"]);
    assert.equal(rec.registry.send("silence", []), 0);
    await assert.rejects(rec.registry.invoke("none"), /No handler registered for 'none'/);
    assert.deepEqual(rec.registry.channels().sort(), ["double", "say"]);
    assert.equal(recordIpc(rec), rec, "wrapping twice gives the same recorder");
  });
});
