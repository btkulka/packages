import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test, type TestContext } from "node:test";
import {
  findRunning,
  helloRoute,
  parseTailscaleStatus,
  recordHistory,
  serveOrAttach,
  servingHello,
  shaOf,
  snapshotName,
  writeSnapshot,
  type Hello,
  type ServeOrAttachOptions,
} from "./index.js";

/** A stand-in app: answers the hello as `hello`, and "<host> says hi" everywhere else. */
function fakeApp(host: string, port: number, hello: () => Hello): Promise<Server> {
  const route = helloRoute(hello);
  const server = createServer((req, res) => {
    if (route(req, res)) return;
    res.writeHead(200, { "content-type": "text/plain" });
    res.end(`${host} says hi to ${req.method} ${req.url}`);
  });
  return new Promise((resolve) => server.listen(port, host, () => resolve(server)));
}

const close = (s: Server) => new Promise<void>((r) => (s.close(() => r()), s.closeAllConnections()));

async function freePort(): Promise<number> {
  const s = createServer();
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", () => r()));
  const { port } = s.address() as AddressInfo;
  await close(s);
  return port;
}

describe("findRunning", () => {
  test("finds the app serving on this machine, and not a different app", async (t) => {
    const port = await freePort();
    const s = await fakeApp("127.0.0.1", port, servingHello("habits", "zagreus"));
    t.after(() => close(s));
    const hit = await findRunning({ app: "habits", port, peers: [] });
    assert.equal(hit?.name, "localhost");
    assert.equal(hit?.hello.machine, "zagreus");
    assert.equal(await findRunning({ app: "jobhunt", port, peers: [] }), null);
  });

  test("an attached instance doesn't count, so two attached machines can't point at each other", async (t) => {
    const port = await freePort();
    const s = await fakeApp("127.0.0.1", port, () => ({ app: "habits", machine: "macbook", mode: "attached", pid: 1, startedAt: "", target: "zagreus" }));
    t.after(() => close(s));
    assert.equal(await findRunning({ app: "habits", port, peers: [] }), null);
  });

  test("skips offline peers and phones", async () => {
    const port = await freePort();
    const hit = await findRunning({
      app: "habits",
      port,
      local: false,
      timeoutMs: 300,
      peers: [
        { name: "iphone", ip: "127.0.0.1", os: "iOS", online: true },
        { name: "old", ip: "127.0.0.1", os: "windows", online: false },
      ],
    });
    assert.equal(hit, null);
  });

  test("a copy with rows is found before an empty one", { skip: process.platform === "darwin" }, async (t) => {
    const port = await freePort();
    const empty = await fakeApp("127.0.0.2", port, servingHello("habits", "hermes", () => 0));
    const full = await fakeApp("127.0.0.3", port, servingHello("habits", "zagreus", () => 12));
    t.after(() => Promise.all([close(empty), close(full)]));
    const hit = await findRunning({
      app: "habits",
      port,
      local: false,
      peers: [
        { name: "hermes", ip: "127.0.0.2", os: "macOS", online: true },
        { name: "zagreus", ip: "127.0.0.3", os: "windows", online: true },
      ],
    });
    assert.equal(hit?.name, "zagreus");
    assert.equal(hit?.hello.rows, 12);
  });
});

test("servingHello: the copy's rows when counted, left out when the count throws", () => {
  assert.equal(servingHello("habits", "zagreus", () => 7309)().rows, 7309);
  assert.equal("rows" in servingHello("habits", "zagreus")(), false);
  assert.equal(
    "rows" in
      servingHello("habits", "zagreus", () => {
        throw new Error("locked");
      })(),
    false,
  );
});

describe("serveOrAttach", () => {
  // 127.0.0.2 is loopback on Windows and Linux; macOS only answers on 127.0.0.1 unless aliased.
  const otherMachine = "127.0.0.2";

  test("serves at once when nothing else is", async () => {
    const port = await freePort();
    let served = 0;
    const r = await serveOrAttach({ app: "habits", port, peers: [], serve: () => served++, log: () => {} });
    assert.equal(r.mode, "serving");
    assert.equal(served, 1);
  });

  test("proxies this machine's port to the machine serving, then takes over when it goes", { skip: process.platform === "darwin" }, async (t) => {
    const port = await freePort();
    const home = await fakeApp(otherMachine, port, servingHello("habits", "zagreus"));
    let served = 0;
    const r = await serveOrAttach({
      app: "habits",
      port,
      host: "127.0.0.1",
      machine: "macbook",
      peers: [{ name: "zagreus", ip: otherMachine, os: "windows", online: true }],
      serve: () => served++,
      checkMs: 50,
      log: () => {},
    });
    t.after(async () => r.mode === "attached" && (await r.stop()));
    assert.equal(r.mode, "attached");

    const page = await fetch(`http://127.0.0.1:${port}/today?x=1`, { method: "POST", body: "hi" });
    assert.equal(await page.text(), `${otherMachine} says hi to POST /today?x=1`);
    const hello = (await (await fetch(`http://127.0.0.1:${port}/_data-sync/hello`)).json()) as Hello;
    assert.equal(hello.mode, "attached");
    assert.equal(hello.target, "zagreus");
    assert.equal(served, 0);

    await close(home);
    for (let i = 0; i < 40 && !served; i++) await new Promise((res) => setTimeout(res, 25));
    assert.equal(served, 1);
    // The proxy let go of the port, so the app can listen on it.
    const mine = await fakeApp("127.0.0.1", port, servingHello("habits", "macbook"));
    await close(mine);
  });

  /** A sync folder that the history of each machine in `from` has reached. */
  function syncFolder(t: TestContext, from: string[] = []): string {
    const dir = mkdtempSync(join(tmpdir(), "data-sync-attach-"));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    for (const machine of from) recordHistory(dir, { at: new Date().toISOString(), app: "habits", machine, event: "pulled" });
    return dir;
  }

  /** serveOrAttach on "macbook" while zagreus serves with `hello`. */
  async function lookFromMacbook(t: TestContext, hello: () => Hello, options: Partial<ServeOrAttachOptions>) {
    const port = await freePort();
    const home = await fakeApp(otherMachine, port, hello);
    t.after(() => close(home));
    let served = 0;
    const said: string[] = [];
    const r = await serveOrAttach({
      app: "habits",
      port,
      host: "127.0.0.1",
      machine: "macbook",
      peers: [{ name: "zagreus", ip: otherMachine, os: "windows", online: true }],
      serve: () => served++,
      checkMs: 60_000,
      log: (line) => said.push(line),
      ...options,
    });
    t.after(async () => r.mode === "attached" && (await r.stop()));
    return { r, served, said: said.join("\n") };
  }

  const skip = process.platform === "darwin";

  test("a machine with rows serves its own rather than pass through to an empty copy", { skip }, async (t) => {
    const { r, served, said } = await lookFromMacbook(t, servingHello("habits", "zagreus", () => 0), { localRows: () => 7309, syncDir: syncFolder(t, ["zagreus"]) });
    assert.equal(r.mode, "serving");
    assert.equal(served, 1);
    assert.match(said, /its copy is empty: serving this machine's 7309 rows here instead/);
  });

  test("a machine with rows serves its own rather than pass through to one that never synced with it", { skip }, async (t) => {
    const { r, served, said } = await lookFromMacbook(t, servingHello("habits", "zagreus", () => 40), { localRows: async () => 7309, syncDir: syncFolder(t) });
    assert.equal(r.mode, "serving");
    assert.equal(served, 1);
    assert.match(said, /never synced with this machine/);
  });

  test("passes through to a machine whose history or snapshot has reached this one", { skip }, async (t) => {
    const byHistory = await lookFromMacbook(t, servingHello("habits", "Zagreus", () => 40), { localRows: () => 7309, syncDir: syncFolder(t, ["Zagreus"]) });
    assert.equal(byHistory.r.mode, "attached");

    const dir = syncFolder(t);
    const sql = "SELECT 1;\n";
    writeSnapshot(join(dir, "habits", snapshotName), "habits", "Zagreus", { sql, sha: shaOf(sql), rows: { habits: 40 }, total: 40, schemaVersion: 1 });
    // An older build's hello carries no count: unknown, not empty.
    const bySnapshot = await lookFromMacbook(t, servingHello("habits", "Zagreus"), { localRows: () => 7309, syncDir: dir });
    assert.equal(bySnapshot.r.mode, "attached");
  });

  test("a machine with no rows of its own passes through, even to an empty copy", { skip }, async (t) => {
    const { r, served } = await lookFromMacbook(t, servingHello("habits", "zagreus", () => 0), { localRows: () => 0, syncDir: syncFolder(t) });
    assert.equal(r.mode, "attached");
    assert.equal(served, 0);
  });
});

test("parseTailscaleStatus: this machine and its peers, IPv4 first", () => {
  const net = parseTailscaleStatus(
    JSON.stringify({
      BackendState: "Running",
      CurrentTailnet: { Name: "stallionrapscallion@gmail.com" },
      User: { "7": { LoginName: "stallionrapscallion@gmail.com" } },
      Self: { HostName: "Zagreus", TailscaleIPs: ["100.102.17.49", "fd7a::1"], OS: "windows", Online: true, UserID: 7 },
      Peer: {
        k1: { HostName: "iphone172", TailscaleIPs: ["100.92.58.81"], OS: "iOS", Online: false },
        k2: { HostName: "bens-macbook", DNSName: "bens-macbook.tail.ts.net.", TailscaleIPs: ["fd7a::2", "100.70.1.2"], OS: "macOS", Online: true },
      },
    }),
  );
  assert.deepEqual(net.self, { name: "zagreus", ip: "100.102.17.49", os: "windows", online: true });
  assert.equal(net.state, "Running");
  assert.equal(net.name, "stallionrapscallion@gmail.com");
  assert.equal(net.user, "stallionrapscallion@gmail.com");
  assert.equal(net.authUrl, undefined);
  assert.deepEqual(
    net.peers.map((p) => [p.name, p.ip, p.online]),
    [
      ["bens-macbook", "100.70.1.2", true],
      ["iphone172", "100.92.58.81", false],
    ],
  );
});
