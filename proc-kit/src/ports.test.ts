import { after, test } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer, type Server } from "node:net";
import { freePort, parseLsof, parseNetstat, pidsOnPort, pidsOnPortSync, probePort, waitForPort, waitForPortFree } from "./ports.js";
import { findExecutable } from "./which.js";
import { isAlive } from "./kill.js";
import { sleep, waitFor } from "./wait.js";

// The lookups shell out to netstat (built into Windows) or lsof (not always
// installed on Linux): skip the live ones where lsof is missing.
const canLookUp = process.platform === "win32" || findExecutable("lsof") !== null;
const live = { skip: canLookUp ? false : "lsof not installed" };

const NETSTAT = `
Active Connections

  Proto  Local Address          Foreign Address        State           PID
  TCP    0.0.0.0:135            0.0.0.0:0              LISTENING       1568
  TCP    0.0.0.0:5173           0.0.0.0:0              LISTENING       2001
  TCP    0.0.0.0:51730          0.0.0.0:0              LISTENING       2002
  TCP    0.0.0.0:15173          0.0.0.0:0              LISTENING       2003
  TCP    127.0.0.1:5173         127.0.0.1:60000        ESTABLISHED     2001
  TCP    127.0.0.1:60000        127.0.0.1:5173         ESTABLISHED     3000
  TCP    127.0.0.1:5173         127.0.0.1:60001        TIME_WAIT       0
  TCP    [::]:5173              [::]:0                 LISTENING       2001
  TCP    [::1]:8787             [::]:0                 LISTENING       2100
  TCP    192.168.1.5:8080       0.0.0.0:0              ABHÖREN         2200
  TCP    0.0.0.0:80             0.0.0.0:0              LISTENING       4
  UDP    0.0.0.0:5173           *:*                                    2300
  UDP    [::]:8787              *:*                                    2301
`;

test("parseNetstat: exact port, IPv4 and IPv6 listeners only", () => {
  assert.deepEqual(parseNetstat(NETSTAT, 5173), [2001]); // not 51730/15173, not the ESTABLISHED client, not UDP
  assert.deepEqual(parseNetstat(NETSTAT, 8787), [2100]); // IPv6 loopback only (what `-p tcp` misses)
  assert.deepEqual(parseNetstat(NETSTAT, 8080), [2200]); // localized state: wildcard foreign address
  assert.deepEqual(parseNetstat(NETSTAT, 80), [4]); // http.sys
  assert.deepEqual(parseNetstat(NETSTAT, 60000), []); // a client socket isn't a listener
  assert.deepEqual(parseNetstat(NETSTAT, 9999), []);
  assert.deepEqual(parseNetstat("", 5173), []);
});

test("parseLsof: one pid per line, deduped", () => {
  assert.deepEqual(parseLsof("123\n456\n123\n"), [123, 456]);
  assert.deepEqual(parseLsof(""), []);
  assert.deepEqual(parseLsof("garbage\n"), []);
});

function listen(host: string): Promise<{ server: Server; port: number }> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, host, () => {
      const addr = server.address();
      resolve({ server, port: typeof addr === "object" && addr ? addr.port : 0 });
    });
  });
}

const close = (server: Server) => new Promise<void>((r) => server.close(() => r()));

test("pidsOnPort / pidsOnPortSync find this process on IPv4 and on IPv6-only", live, async () => {
  const v4 = await listen("127.0.0.1");
  const v6 = await listen("::1").catch(() => null); // a box without IPv6
  try {
    assert.deepEqual(await pidsOnPort(v4.port), [process.pid]);
    assert.deepEqual(pidsOnPortSync(v4.port), [process.pid]);
    if (v6) assert.deepEqual(await pidsOnPort(v6.port), [process.pid]);
  } finally {
    await close(v4.server);
    if (v6) await close(v6.server);
  }
  assert.deepEqual(await pidsOnPort(v4.port), []);
});

test("probePort: either loopback by default, or the host asked for", async () => {
  const v4 = await listen("127.0.0.1");
  try {
    assert.equal(await probePort(v4.port), true);
    assert.equal(await probePort(v4.port, { host: "127.0.0.1" }), true);
    assert.equal(await probePort(v4.port, { host: "::1", timeoutMs: 300 }), false);
  } finally {
    await close(v4.server);
  }
  assert.equal(await probePort(v4.port, { timeoutMs: 300 }), false);
  const v6 = await listen("::1").catch(() => null);
  if (v6) {
    try {
      assert.equal(await probePort(v6.port), true); // a Vite on ::1 only still counts as up
    } finally {
      await close(v6.server);
    }
  }
});

test("waitForPort resolves once something listens, false on timeout", async () => {
  const { server, port } = await listen("127.0.0.1");
  await close(server); // a port that was free a moment ago
  setTimeout(() => {
    const s = createServer().listen(port, "127.0.0.1");
    setTimeout(() => s.close(), 1500);
  }, 300);
  assert.equal(await waitForPort(port, { timeoutMs: 5000, intervalMs: 50 }), true);
  await sleep(1600);
  assert.equal(await waitForPort(port, { timeoutMs: 200, intervalMs: 50 }), false);
});

test("waitForPortFree resolves once the listener is gone", live, async () => {
  const { server, port } = await listen("127.0.0.1");
  setTimeout(() => server.close(), 300);
  assert.equal(await waitForPortFree(port, { timeoutMs: 200, intervalMs: 50 }), false);
  assert.equal(await waitForPortFree(port, { timeoutMs: 5000, intervalMs: 50 }), true);
});

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

/** A node child listening on a port, behind a node parent: a tree. Resolves the child, the port and the listener's pid. */
async function listenerTree(): Promise<{ root: ChildProcess; port: number; listenerPid: number }> {
  const inner = "const s=require('net').createServer().listen(0,'127.0.0.1',()=>console.log(process.pid+' '+s.address().port));";
  const outer =
    "const c=require('child_process').spawn(process.execPath,['-e',process.argv[1]],{stdio:['ignore','inherit','inherit']});setInterval(()=>{},1000);";
  const root = spawn(process.execPath, ["-e", outer, inner], {
    stdio: ["ignore", "pipe", "inherit"],
    detached: process.platform !== "win32",
  });
  const line = await new Promise<string>((resolve, reject) => {
    let buf = "";
    root.stdout!.on("data", (d) => {
      buf += String(d);
      const i = buf.indexOf("\n");
      if (i >= 0) resolve(buf.slice(0, i).trim());
    });
    root.once("exit", (code) => reject(new Error(`listener tree exited early (${code})`)));
  });
  const [pid, port] = line.split(" ").map(Number);
  spawnedPids.push(root.pid!, pid);
  return { root, port, listenerPid: pid };
}

test("freePort kills the listener's tree and waits for the port", live, async () => {
  const { root, port, listenerPid } = await listenerTree();
  assert.deepEqual(await pidsOnPort(port), [listenerPid]);
  const r = await freePort(port);
  assert.deepEqual(r, { killed: [listenerPid], skipped: [], free: true });
  assert.equal(await waitFor(() => !isAlive(listenerPid), { timeoutMs: 5000 }), true);
  // The root survives: freePort takes the listener and what it started, not its parent.
  assert.equal(isAlive(root.pid!), true);
  root.kill("SIGKILL");
});

test("freePort spares this process and excluded pids, and says the port is still held", live, async () => {
  const { server, port } = await listen("127.0.0.1");
  try {
    const started = Date.now();
    const r = await freePort(port);
    assert.deepEqual(r, { killed: [], skipped: [process.pid], free: false });
    assert.ok(Date.now() - started < 3000, "no waiting for a port we chose not to free");
  } finally {
    await close(server);
  }
  const tree = await listenerTree();
  try {
    const r = await freePort(tree.port, { exclude: [tree.listenerPid] });
    assert.deepEqual(r, { killed: [], skipped: [tree.listenerPid], free: false });
    assert.equal(isAlive(tree.listenerPid), true);
  } finally {
    await freePort(tree.port);
    tree.root.kill("SIGKILL");
  }
});

test("freePort on a free port does nothing", live, async () => {
  const { server, port } = await listen("127.0.0.1");
  await close(server);
  assert.deepEqual(await freePort(port), { killed: [], skipped: [], free: true });
});
