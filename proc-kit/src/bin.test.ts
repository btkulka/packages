import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { packageBin } from "./bin.js";

function app() {
  const root = mkdtempSync(join(tmpdir(), "proc-kit-bin-"));
  const pkg = (name: string, bin: unknown) => {
    const dir = join(root, "node_modules", ...name.split("/"));
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name, bin }));
    return dir;
  };
  return { root, pkg, done: () => rmSync(root, { recursive: true, force: true }) };
}

test("a string bin (tsx)", () => {
  const a = app();
  try {
    const dir = a.pkg("tsx", "./dist/cli.mjs");
    assert.equal(packageBin("tsx", { from: a.root }), join(dir, "dist", "cli.mjs"));
  } finally {
    a.done();
  }
});

test("an object bin, by the package's name or by `bin` (electron-vite, scoped)", () => {
  const a = app();
  try {
    const ev = a.pkg("electron-vite", { "electron-vite": "bin/electron-vite.js" });
    assert.equal(packageBin("electron-vite", { from: a.root }), join(ev, "bin", "electron-vite.js"));
    const multi = a.pkg("@scope/multi", { multi: "a.js", other: "b.js" });
    assert.equal(packageBin("@scope/multi", { from: a.root }), join(multi, "a.js"));
    assert.equal(packageBin("@scope/multi", { from: a.root, bin: "other" }), join(multi, "b.js"));
    const single = a.pkg("single", { differently: "only.js" });
    assert.equal(packageBin("single", { from: a.root }), join(single, "only.js"));
  } finally {
    a.done();
  }
});

test("found from a folder deep inside the app, walking up", () => {
  const a = app();
  try {
    const dir = a.pkg("tsx", "./dist/cli.mjs");
    const deep = join(a.root, "src", "scripts", "x");
    mkdirSync(deep, { recursive: true });
    assert.equal(packageBin("tsx", { from: deep }), join(dir, "dist", "cli.mjs"));
  } finally {
    a.done();
  }
});

test("missing package, or no such command: a clear error", () => {
  const a = app();
  try {
    a.pkg("nobin", undefined);
    a.pkg("@scope/multi", { one: "1.js", two: "2.js" });
    assert.throws(() => packageBin("proc-kit-not-installed", { from: a.root }), /isn't installed/);
    assert.throws(() => packageBin("nobin", { from: a.root }), /no command/);
    assert.throws(() => packageBin("@scope/multi", { from: a.root }), /no command/);
    assert.throws(() => packageBin("@scope/multi", { from: a.root, bin: "three" }), /named three/);
  } finally {
    a.done();
  }
});

test("defaults to the cwd: finds typescript's tsc from this package", () => {
  // D:\source\packages\node_modules\typescript, reached by walking up from proc-kit.
  assert.match(packageBin("typescript", { bin: "tsc" }), /typescript[\\/]bin[\\/]tsc$/);
});
