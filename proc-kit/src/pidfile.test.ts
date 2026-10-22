import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readPidFile, removePidFile, writePidFile } from "./pidfile.js";

function dir() {
  const root = mkdtempSync(join(tmpdir(), "proc-kit-pid-"));
  return { root, done: () => rmSync(root, { recursive: true, force: true }) };
}

test("write then read: this process, alive, with extra fields, folder created", () => {
  const d = dir();
  try {
    const file = join(d.root, "run", "comfy.pid");
    const wrote = writePidFile(file, { supervisorPid: 123, port: 8188 });
    assert.equal(wrote.pid, process.pid);
    const read = readPidFile(file);
    assert.ok(read);
    assert.equal(read.pid, process.pid);
    assert.equal(read.alive, true);
    assert.equal(read.supervisorPid, 123);
    assert.equal(read.port, 8188);
    assert.ok(Math.abs(Date.parse(read.startedAt) - Date.now()) < 5000);
    assert.deepEqual(readdirSync(join(d.root, "run")), ["comfy.pid"], "no temp file left behind");
  } finally {
    d.done();
  }
});

test("a pid that has exited reads as not alive", async () => {
  const d = dir();
  try {
    const child = spawn(process.execPath, ["-e", "0"], { stdio: "ignore" });
    await new Promise((r) => child.once("exit", r));
    const file = join(d.root, "x.pid");
    writePidFile(file, { pid: child.pid });
    assert.equal(readPidFile(file)?.alive, false);
  } finally {
    d.done();
  }
});

test("missing, empty, garbage and bad pids read as null", () => {
  const d = dir();
  try {
    const file = join(d.root, "x.pid");
    assert.equal(readPidFile(file), null);
    for (const text of ["", "garbage", "[1,2]", '{"pid":0}', '{"pid":"abc"}', "-5\n"]) {
      writeFileSync(file, text);
      assert.equal(readPidFile(file), null, JSON.stringify(text));
    }
  } finally {
    d.done();
  }
});

test("the older line format (orson's comfy.pid) still reads", () => {
  const d = dir();
  try {
    const file = join(d.root, "comfy.pid");
    writeFileSync(file, `${process.pid}\n2026-10-22T10:00:00.000Z\n999\n`);
    const r = readPidFile(file);
    assert.equal(r?.pid, process.pid);
    assert.equal(r?.startedAt, "2026-10-22T10:00:00.000Z");
    assert.equal(r?.alive, true);
    writeFileSync(file, `${process.pid}`); // a bare pid
    assert.equal(readPidFile(file)?.pid, process.pid);
  } finally {
    d.done();
  }
});

test("removePidFile removes, and doesn't mind a missing file", () => {
  const d = dir();
  try {
    const file = join(d.root, "x.pid");
    writePidFile(file);
    removePidFile(file);
    assert.equal(existsSync(file), false);
    removePidFile(file);
  } finally {
    d.done();
  }
});
