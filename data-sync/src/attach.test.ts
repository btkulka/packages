import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, test } from "node:test";
import { findRunning, helloRoute, parseTailscaleStatus, serveOrAttach, servingHello, type Hello } from "./index.js";

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
