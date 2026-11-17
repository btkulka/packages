import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { httpError, isCrossSiteWrite, router } from "./http.js";
import type { Logger } from "./log.js";
import { startApp, type RunningApp } from "./serve.js";

const quiet: Logger = { info: () => {}, warn: () => {}, error: () => {} };
let dir: string;
let app: RunningApp;
let base: string;

const freePortNumber = () =>
  new Promise<number>((resolve) => {
    const s = createServer();
    s.listen(0, "127.0.0.1", () => {
      const p = (s.address() as AddressInfo).port;
      s.close(() => resolve(p));
    });
  });

before(async () => {
  dir = mkdtempSync(join(tmpdir(), "app-server-"));
  mkdirSync(join(dir, "dist", "assets"), { recursive: true });
  writeFileSync(join(dir, "dist", "index.html"), "<!doctype html><title>app</title>");
  writeFileSync(join(dir, "dist", "assets", "a.js"), "console.log(1)");
  const { add, handle } = router();
  add("GET", "/api/health", () => ({ ok: true, name: "Test" }));
  add("GET", "/api/items/:id", (c) => ({ id: c.params.id, q: c.query.get("q") }));
  add("POST", "/api/items", async (c) => ({ got: await c.body() }));
  add("GET", "/api/teapot", () => {
    throw httpError(418, "I'm a teapot.");
  });
  add("GET", "/api/boom", () => {
    throw new Error("kaboom");
  });
  const port = await freePortNumber();
  app = await startApp({
    name: "Test",
    version: "0.0.1",
    port,
    hosts: ["127.0.0.1", "localhost"],
    root: dir,
    distDir: join(dir, "dist"),
    prod: true,
    log: quiet,
    api: handle,
    before: (req, res) => {
      if (req.url !== "/_hello") return false;
      res.end("hello");
      return true;
    },
    freeFirst: false,
    exitOnSignal: false,
  });
  base = `http://127.0.0.1:${port}`;
});

after(async () => {
  await app.close();
  rmSync(dir, { recursive: true, force: true });
});

test("the API: routes, params, JSON bodies, typed errors, unknown paths and throws", async () => {
  assert.deepEqual(await (await fetch(`${base}/api/items/7?q=x`)).json(), { id: "7", q: "x" });
  const post = await fetch(`${base}/api/items`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ a: 1 }) });
  assert.deepEqual(await post.json(), { got: { a: 1 } });
  const tea = await fetch(`${base}/api/teapot`);
  assert.equal(tea.status, 418);
  assert.deepEqual(await tea.json(), { error: "I'm a teapot." });
  assert.equal((await fetch(`${base}/api/nope`)).status, 404);
  const boom = await fetch(`${base}/api/boom`);
  assert.equal(boom.status, 500);
  assert.deepEqual(await boom.json(), { error: "kaboom" });
});

test("another site's page can't write; reads and curl pass", async () => {
  const bad = await fetch(`${base}/api/items`, { method: "POST", headers: { origin: "https://evil.example", "content-type": "application/json" }, body: "{}" });
  assert.equal(bad.status, 403);
  const own = await fetch(`${base}/api/items`, { method: "POST", headers: { origin: base, "content-type": "application/json" }, body: "{}" });
  assert.equal(own.status, 200);
  assert.ok(!isCrossSiteWrite({ method: "GET", headers: { origin: "https://evil.example" } }));
  assert.ok(!isCrossSiteWrite({ method: "POST", headers: {} }));
  assert.ok(isCrossSiteWrite({ method: "POST", headers: { origin: "null", host: "x" } }));
});

test("the built page: files from dist, index.html for the rest, immutable assets", async () => {
  const page = await fetch(`${base}/kitchen/anything`);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /<title>app<\/title>/);
  const asset = await fetch(`${base}/assets/a.js`);
  assert.match(asset.headers.get("cache-control") ?? "", /immutable/);
  assert.match(asset.headers.get("content-type") ?? "", /javascript/);
  assert.equal((await fetch(`${base}/..%2f..%2fpackage.json`)).status, 200, "a path out of dist falls back to the page");
});

test("before answers first; every address shares the handler", async () => {
  assert.equal(await (await fetch(`${base}/_hello`)).text(), "hello");
  assert.ok(app.servers.length >= 1);
  assert.ok(app.hosts.includes("127.0.0.1"));
});
