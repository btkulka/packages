import assert from "node:assert/strict";
import { createServer, request, type Server } from "node:http";
import { connect, type AddressInfo } from "node:net";
import { writeFileSync } from "node:fs";
import { describe, test } from "node:test";
import { createDataSync, findRunning, helloRoute, serveOrAttach, servingHello, tailnetFor, listTailnets, type Hello } from "./index.js";
import { sandbox } from "./testing/drivers.js";

/** Point the package at a tailnets.json in the sandbox (and no sync-dir override), for one test. */
function withMap(t: { after(fn: () => void): void }, file: string, map: unknown) {
  const saved = { file: process.env.BENHAUS_TAILNETS, dir: process.env.BENHAUS_SYNC_DIR };
  writeFileSync(file, JSON.stringify(map));
  process.env.BENHAUS_TAILNETS = file;
  delete process.env.BENHAUS_SYNC_DIR;
  t.after(() => {
    if (saved.file === undefined) delete process.env.BENHAUS_TAILNETS;
    else process.env.BENHAUS_TAILNETS = saved.file;
    if (saved.dir !== undefined) process.env.BENHAUS_SYNC_DIR = saved.dir;
  });
}

describe("the tailnet map", () => {
  test("each app gets its tailnet's folder and way in; unnamed apps get the primary", (t) => {
    const box = sandbox(t);
    withMap(t, box.file("tailnets.json"), {
      tailnets: {
        persona: { socket: "/tmp/ts-persona.sock", proxy: "http://127.0.0.1:41055", syncDir: box.file("sync-persona") },
        btkulka: { primary: true, syncDir: box.file("sync") },
      },
      apps: { clipdrift: "persona" },
    });
    assert.deepEqual(
      listTailnets().map((n) => n.name),
      ["btkulka", "persona"],
    );
    assert.deepEqual(tailnetFor("clipdrift"), { name: "persona", primary: false, socket: "/tmp/ts-persona.sock", proxy: "http://127.0.0.1:41055", syncDir: box.file("sync-persona") });
    assert.equal(tailnetFor("habit-tracker").name, "btkulka");
    assert.equal(createDataSync({ app: "clipdrift", dbPath: box.file("c.db"), driver: class {} as never, log: () => {} }).file, box.file("sync-persona", "clipdrift", "snapshot.sql"));
  });

  test("no map: the system Tailscale and the one folder, as before", (t) => {
    const box = sandbox(t);
    withMap(t, box.file("tailnets.json"), {});
    assert.deepEqual(listTailnets().map((n) => [n.name, n.primary]), [["default", true]]);
  });
});

/** A minimal HTTP proxy like a userspace tailscaled's: absolute-form requests and CONNECT. Counts what it carried. */
function fakeProxy(): Promise<{ url: string; carried: string[]; server: Server }> {
  const carried: string[] = [];
  const server = createServer((req, res) => {
    const target = new URL(req.url ?? "");
    carried.push(`${req.method} ${target.host}${target.pathname}`);
    const up = request({ host: target.hostname, port: target.port, path: target.pathname + target.search, method: req.method, headers: req.headers }, (r) => {
      res.writeHead(r.statusCode ?? 502, r.headers);
      r.pipe(res);
    });
    up.on("error", () => (res.writeHead(502), res.end()));
    req.pipe(up);
  });
  server.on("connect", (req, socket, head) => {
    carried.push(`CONNECT ${req.url}`);
    const [host, port] = (req.url ?? "").split(":");
    const up = connect(Number(port), host, () => {
      socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head?.length) up.write(head);
      up.pipe(socket).pipe(up);
    });
    up.on("error", () => socket.destroy());
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({ url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, carried, server })));
}

const close = (s: Server) => new Promise<void>((r) => (s.close(() => r()), s.closeAllConnections()));

test("on a userspace tailnet, finding and passing through go by its proxy", { skip: process.platform === "darwin" }, async (t) => {
  const proxy = await fakeProxy();
  t.after(() => close(proxy.server));
  // The other machine: only reachable "through the tailnet", i.e. on 127.0.0.2 via the proxy.
  const home = createServer((req, res) => {
    if (helloRoute(servingHello("clipdrift", "zagreus"))(req, res)) return;
    res.end(`zagreus has ${req.url}`);
  });
  await new Promise<void>((r) => home.listen(0, "127.0.0.2", () => r()));
  t.after(() => close(home));
  const port = (home.address() as AddressInfo).port;
  const net = { name: "persona", primary: false, proxy: proxy.url, syncDir: "unused" };
  const peers = [{ name: "zagreus", ip: "127.0.0.2", os: "windows", online: true }];

  const hit = await findRunning({ app: "clipdrift", port, local: false, peers, tailnet: net });
  assert.equal(hit?.name, "zagreus");
  assert.equal(hit?.proxy, proxy.url);
  assert.ok(proxy.carried.some((c) => c.endsWith("/_data-sync/hello")));

  const r = await serveOrAttach({ app: "clipdrift", port, host: "127.0.0.1", peers, tailnet: net, serve: () => assert.fail("shouldn't serve"), checkMs: 60_000, log: () => {} });
  t.after(async () => r.mode === "attached" && (await r.stop()));
  assert.equal(r.mode, "attached");
  const page = await fetch(`http://127.0.0.1:${port}/library`);
  assert.equal(await page.text(), "zagreus has /library");
  assert.ok(proxy.carried.includes(`GET 127.0.0.2:${port}/library`));
  const h = (await (await fetch(`http://127.0.0.1:${port}/_data-sync/hello`)).json()) as Hello;
  assert.equal(h.mode, "attached");
});
