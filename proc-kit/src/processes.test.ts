import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { cimScript, listProcesses, parseCimJson, parsePs } from "./processes.js";
import { findExecutable } from "./which.js";

test("parseCimJson: an array, a lone object, nulls, a BOM, garbage", () => {
  const rows = JSON.stringify([
    { ProcessId: 10, ParentProcessId: 1, Name: "node.exe", CommandLine: "node a.js", ExecutablePath: "C:\\node.exe" },
    { ProcessId: 4, ParentProcessId: 0, Name: "System", CommandLine: null, ExecutablePath: null },
  ]);
  assert.deepEqual(parseCimJson(rows), [
    { pid: 10, ppid: 1, name: "node.exe", commandLine: "node a.js", executablePath: "C:\\node.exe" },
    { pid: 4, ppid: 0, name: "System" },
  ]);
  assert.deepEqual(parseCimJson(`\uFEFF${JSON.stringify({ ProcessId: 7, ParentProcessId: 3, Name: "x.exe" })}`), [
    { pid: 7, ppid: 3, name: "x.exe" },
  ]);
  assert.deepEqual(parseCimJson("[]"), []);
  assert.deepEqual(parseCimJson(""), []);
  assert.deepEqual(parseCimJson("not json"), []);
});

test("parsePs: pid, ppid, argv[0]'s basename as the name", () => {
  const out = "    1     0 /sbin/init splash\n  420     1 /usr/bin/node /srv/app/src/server.js --watch\n  421   420 node\n";
  assert.deepEqual(parsePs(out), [
    { pid: 1, ppid: 0, name: "init", commandLine: "/sbin/init splash" },
    { pid: 420, ppid: 1, name: "node", commandLine: "/usr/bin/node /srv/app/src/server.js --watch" },
    { pid: 421, ppid: 420, name: "node", commandLine: "node" },
  ]);
});

test("cimScript: filters by pid and name, quotes escaped, output forced to UTF-8", () => {
  const s = cimScript({ pid: 42, name: "it's.exe" });
  assert.match(s, /-Filter "ProcessId=42 AND Name='it\\'s.exe'"/);
  assert.match(s, /UTF8Encoding \$false/);
  assert.match(s, /ConvertTo-Json -Compress -Depth 2 -InputObject \$p/);
  assert.doesNotMatch(cimScript(), /-Filter/);
  assert.doesNotMatch(cimScript({ name: 'a"$b' }), /"\$b|a"/); // can't break out of the PowerShell string
});

const canList = process.platform === "win32" || findExecutable("ps") !== null;

test("listProcesses finds a child by pid, with its parent and a non-ASCII command line", { skip: !canList && "no ps" }, async () => {
  const marker = "Benhäus-proc-kit-test";
  const child = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)", marker], { stdio: "ignore" });
  try {
    const [p, ...rest] = await listProcesses({ pid: child.pid });
    assert.equal(rest.length, 0);
    assert.equal(p.pid, child.pid);
    assert.equal(p.ppid, process.pid);
    assert.match(p.name, /^node(\.exe)?$/i);
    assert.ok(p.commandLine?.includes(marker), `command line came back as ${p.commandLine}`);
    if (process.platform === "win32") assert.equal(p.executablePath?.toLowerCase(), process.execPath.toLowerCase());

    const nodes = await listProcesses({ name: process.platform === "win32" ? "node.exe" : p.name });
    assert.ok(nodes.some((n) => n.pid === process.pid));
    assert.ok(nodes.some((n) => n.pid === child.pid));
  } finally {
    child.kill();
  }
});

test("listProcesses for a pid that isn't running is empty", { skip: !canList && "no ps" }, async () => {
  const child = spawn(process.execPath, ["-e", "0"], { stdio: "ignore" });
  await new Promise((r) => child.once("exit", r));
  assert.deepEqual(await listProcesses({ pid: child.pid }), []);
});
