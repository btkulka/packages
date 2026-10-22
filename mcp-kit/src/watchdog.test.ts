import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { describe, it } from "node:test";
import { installParentWatchdog, pidAlive } from "./watchdog.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function until(check: () => boolean, ms: number) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (check()) return true;
    await sleep(50);
  }
  return check();
}

describe("installParentWatchdog", () => {
  it("fires once on stdin EOF", () => {
    const input = new EventEmitter();
    const reasons: string[] = [];
    installParentWatchdog({ input, onOrphan: (r) => reasons.push(r), ppid: () => 1234, alive: () => true });
    input.emit("end");
    input.emit("close");
    assert.deepEqual(reasons, ["stdin EOF"]);
  });

  it("fires on stdin close", () => {
    const input = new EventEmitter();
    const reasons: string[] = [];
    installParentWatchdog({ input, onOrphan: (r) => reasons.push(r), ppid: () => 1234, alive: () => true });
    input.emit("close");
    assert.deepEqual(reasons, ["stdin closed"]);
  });

  it("ignores stdin when stdin is false", () => {
    const input = new EventEmitter();
    const reasons: string[] = [];
    const stop = installParentWatchdog({ input, stdin: false, onOrphan: (r) => reasons.push(r), ppid: () => 1234, alive: () => true });
    input.emit("end");
    assert.deepEqual(reasons, []);
    stop();
  });

  it("fires when the parent pid changes (POSIX re-parenting)", async () => {
    let ppid = 1234;
    const reasons: string[] = [];
    installParentWatchdog({ input: new EventEmitter(), intervalMs: 10, onOrphan: (r) => reasons.push(r), ppid: () => ppid, alive: () => true });
    ppid = 1;
    assert.ok(await until(() => reasons.length > 0, 2000));
    assert.deepEqual(reasons, ["ppid changed 1234 -> 1"]);
  });

  it("fires when the parent pid is gone but unchanged (Windows)", async () => {
    let up = true;
    const reasons: string[] = [];
    installParentWatchdog({ input: new EventEmitter(), intervalMs: 10, onOrphan: (r) => reasons.push(r), ppid: () => 4321, alive: () => up });
    await sleep(40);
    assert.deepEqual(reasons, []);
    up = false;
    assert.ok(await until(() => reasons.length > 0, 2000));
    assert.deepEqual(reasons, ["ppid 4321 no longer exists"]);
  });

  it("stop() stops watching", async () => {
    const input = new EventEmitter();
    const reasons: string[] = [];
    const stop = installParentWatchdog({ input, intervalMs: 10, onOrphan: (r) => reasons.push(r), ppid: () => 4321, alive: () => false });
    stop();
    input.emit("end");
    await sleep(50);
    assert.deepEqual(reasons, []);
    assert.equal(input.listenerCount("end"), 0);
  });
});

describe("pidAlive", () => {
  it("is true for this process and false for one that exited", async () => {
    assert.equal(pidAlive(process.pid), true);
    const child = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
    const pid = child.pid!;
    await new Promise((r) => child.once("exit", r));
    assert.ok(await until(() => !pidAlive(pid), 5000));
  });
});

describe("watchdog in a real process tree", () => {
  it("exits a server whose parent is killed, through the pid poll alone", async () => {
    // test → parent → server. The server's stdin is not a pipe from the parent, so only the pid poll can notice.
    const serverCode = `
      const { installParentWatchdog } = require(${JSON.stringify(require_path())});
      installParentWatchdog({ intervalMs: 100 });
      setInterval(() => {}, 1000);
    `;
    const parentCode = `
      const { spawn } = require("node:child_process");
      const c = spawn(process.execPath, ["-e", ${JSON.stringify(serverCode)}], { stdio: ["ignore", "ignore", "ignore"] });
      console.log(c.pid);
      setInterval(() => {}, 1000);
    `;
    const parent = spawn(process.execPath, ["-e", parentCode], { stdio: ["ignore", "pipe", "inherit"] });
    const serverPid = await new Promise<number>((resolve) => parent.stdout!.once("data", (d) => resolve(Number(String(d).trim()))));
    assert.ok(serverPid > 0);
    await sleep(300);
    assert.equal(pidAlive(serverPid), true, "server runs while its parent does");
    parent.kill();
    const gone = await until(() => !pidAlive(serverPid), 10_000);
    if (!gone) process.kill(serverPid);
    assert.ok(gone, "server exits after its parent is killed");
  });
});

/** The built CommonJS entry, so a plain `node -e` child can load the kit. Tests run from the package folder. */
function require_path() {
  return `${process.cwd().replace(/\\/g, "/")}/dist/cjs/index.js`;
}
