import { after, test } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { isAlive, killTree, killTreeSync } from "./kill.js";
import { waitFor } from "./wait.js";

/**
 * A node parent that starts a node grandchild and prints its pid: the shape of
 * a `shell: true` wrapper or an npm shim in front of the real server.
 */
async function tree(
  script = "const g=require('child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});" +
    "console.log(g.pid);setInterval(()=>{},1000);",
): Promise<{ root: ChildProcess; grandchild: number }> {
  const root = spawn(process.execPath, ["-e", script], {
    stdio: ["ignore", "pipe", "inherit"],
    // POSIX: a group of its own, which killTree signals as a whole.
    detached: process.platform !== "win32",
  });
  const grandchild = await new Promise<number>((resolve, reject) => {
    let buf = "";
    root.stdout!.on("data", (d) => {
      buf += String(d);
      const i = buf.indexOf("\n");
      if (i >= 0) resolve(Number(buf.slice(0, i)));
    });
    root.once("exit", (code) => reject(new Error(`tree exited early (${code})`)));
  });
  spawnedPids.push(root.pid!, grandchild);
  return { root, grandchild };
}

// Whatever a failed test leaves running would keep this file from finishing.
const spawnedPids: number[] = [];
after(() => {
  for (const pid of spawnedPids) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      /* gone */
    }
  }
});

const gone = (pid: number) => waitFor(() => !isAlive(pid), { timeoutMs: 5000, intervalMs: 50 });

test("isAlive: this process yes, nonsense pids no", () => {
  assert.equal(isAlive(process.pid), true);
  assert.equal(isAlive(0), false);
  assert.equal(isAlive(-5), false);
  assert.equal(isAlive(1.5), false);
  assert.equal(isAlive(Number.NaN), false);
});

test("isAlive turns false once a process exits", async () => {
  const child = spawn(process.execPath, ["-e", "0"], { stdio: "ignore" });
  await new Promise((r) => child.once("exit", r));
  assert.equal(isAlive(child.pid!), false);
});

test("killTree takes the grandchild too", async () => {
  const { root, grandchild } = await tree();
  assert.equal(isAlive(grandchild), true);
  assert.equal(await killTree(root.pid!), true);
  assert.equal(await gone(root.pid!), true);
  assert.equal(await gone(grandchild), true);
});

test("killTree with a grace period still ends a program that ignores the polite ask", async () => {
  // Windows: a console node refuses taskkill without /F. POSIX: this one ignores SIGTERM.
  const script =
    "process.on('SIGTERM',()=>{});" +
    "const g=require('child_process').spawn(process.execPath,['-e',\"process.on('SIGTERM',()=>{});setInterval(()=>{},1000)\"],{stdio:'ignore'});" +
    "console.log(g.pid);setInterval(()=>{},1000);";
  const { root, grandchild } = await tree(script);
  const started = Date.now();
  assert.equal(await killTree(root.pid!, { graceMs: 400 }), true);
  assert.ok(Date.now() - started >= 350, "waited out the grace period first");
  assert.equal(await gone(root.pid!), true);
  assert.equal(await gone(grandchild), true);
});

test("killTree with a grace period returns as soon as the program exits", { skip: process.platform === "win32" && "POSIX: SIGTERM" }, async () => {
  const { root, grandchild } = await tree();
  const started = Date.now();
  assert.equal(await killTree(root.pid!, { graceMs: 5000 }), true);
  assert.ok(Date.now() - started < 4000);
  assert.equal(await gone(root.pid!), true);
  assert.equal(await gone(grandchild), true);
});

test("killTree on a process that's gone, or a bad pid, is false", async () => {
  const child = spawn(process.execPath, ["-e", "0"], { stdio: "ignore" });
  await new Promise((r) => child.once("exit", r));
  assert.equal(await killTree(child.pid!), false);
  assert.equal(await killTree(0), false);
  assert.equal(await killTree(-1), false);
  assert.equal(await killTree(2.5), false);
});

test("killTreeSync takes the tree, for exit handlers", async () => {
  const { root, grandchild } = await tree();
  assert.equal(killTreeSync(root.pid!), true);
  assert.equal(await gone(root.pid!), true);
  assert.equal(await gone(grandchild), true);
  assert.equal(killTreeSync(0), false);
});
