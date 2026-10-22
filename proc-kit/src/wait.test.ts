import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { probeHttp, sleep, waitFor, waitForHttp } from "./wait.js";

test("waitFor: true at once, true later, false at the deadline", async () => {
  assert.equal(await waitFor(() => true, { timeoutMs: 0 }), true);
  let n = 0;
  assert.equal(await waitFor(() => ++n >= 3, { timeoutMs: 2000, intervalMs: 10 }), true);
  assert.equal(n, 3);
  const started = Date.now();
  assert.equal(await waitFor(() => false, { timeoutMs: 150, intervalMs: 20 }), false);
  assert.ok(Date.now() - started >= 140);
});

test("waitFor: a check that throws counts as not yet; async checks work", async () => {
  let n = 0;
  const ok = await waitFor(
    async () => {
      n++;
      if (n < 3) throw new Error("not up");
      return true;
    },
    { timeoutMs: 2000, intervalMs: 10 },
  );
  assert.equal(ok, true);
});

test("waitFor: an abort ends the wait early with false", async () => {
  const ctrl = new AbortController();
  setTimeout(() => ctrl.abort(), 100);
  const started = Date.now();
  assert.equal(await waitFor(() => false, { timeoutMs: 10_000, intervalMs: 5000, signal: ctrl.signal }), false);
  assert.ok(Date.now() - started < 2000);
  assert.equal(await waitFor(() => true, { signal: AbortSignal.abort() }), false);
});

function serve(): Promise<{ server: Server; base: string; hits: Map<string, number> }> {
  const hits = new Map<string, number>();
  const server = createServer((req, res) => {
    const path = req.url ?? "/";
    hits.set(path, (hits.get(path) ?? 0) + 1);
    if (path === "/ok") return res.end("fine");
    if (path === "/fail") return res.writeHead(500).end("broken");
    if (path === "/missing") return res.writeHead(404).end();
    if (path === "/health") return res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ ok: true }));
    if (path === "/not-ours") return res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ ok: false }));
    if (path === "/later") return (hits.get(path)! >= 3 ? res.writeHead(200) : res.writeHead(503)).end();
    if (path === "/hang") return; // never answers
    res.writeHead(404).end();
  });
  return new Promise((resolve) =>
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      resolve({ server, base: `http://127.0.0.1:${port}`, hits });
    }),
  );
}

function stop(server: Server): Promise<void> {
  server.closeAllConnections();
  return new Promise((r) => server.close(() => r()));
}

test("probeHttp: 2xx by default; 5xx, 4xx, refused and hung are not up", async () => {
  const { server, base } = await serve();
  try {
    assert.equal(await probeHttp(`${base}/ok`), true);
    assert.equal(await probeHttp(`${base}/fail`), false);
    assert.equal(await probeHttp(`${base}/missing`), false);
    const started = Date.now();
    assert.equal(await probeHttp(`${base}/hang`, { timeoutMs: 200 }), false);
    assert.ok(Date.now() - started < 1500);
  } finally {
    await stop(server);
  }
  assert.equal(await probeHttp(`${base}/ok`), false); // nothing listening
});

test("probeHttp: a custom accept can take 4xx or fingerprint the body", async () => {
  const { server, base } = await serve();
  try {
    assert.equal(await probeHttp(`${base}/missing`, { accept: (r) => r.status < 500 }), true);
    const ours = async (r: Response) => r.ok && ((await r.json()) as { ok?: boolean }).ok === true;
    assert.equal(await probeHttp(`${base}/health`, { accept: ours }), true);
    assert.equal(await probeHttp(`${base}/not-ours`, { accept: ours }), false);
    assert.equal(await probeHttp(`${base}/ok`, { method: "HEAD" }), true);
  } finally {
    await stop(server);
  }
});

test("probeHttp: with several URLs any one answering is enough", async () => {
  const { server, base } = await serve();
  const dead = "http://127.0.0.1:1/ok";
  try {
    assert.equal(await probeHttp([dead, `${base}/ok`], { timeoutMs: 500 }), true);
    assert.equal(await probeHttp([dead, `${base}/fail`], { timeoutMs: 500 }), false);
    assert.equal(await probeHttp([]), false);
  } finally {
    await stop(server);
  }
});

test("waitForHttp: keeps polling until accepted, false when it never is", async () => {
  const { server, base, hits } = await serve();
  try {
    assert.equal(await waitForHttp(`${base}/later`, { timeoutMs: 5000, intervalMs: 20 }), true);
    assert.equal(hits.get("/later"), 3);
    assert.equal(await waitForHttp(`${base}/fail`, { timeoutMs: 200, intervalMs: 20 }), false);
  } finally {
    await stop(server);
  }
});

test("waitForHttp: a server that comes up later is found", async () => {
  const { server, base } = await serve();
  const port = Number(new URL(base).port);
  await stop(server);
  let late: Server | undefined;
  setTimeout(() => {
    late = createServer((_req, res) => res.end("up")).listen(port, "127.0.0.1");
  }, 300);
  try {
    assert.equal(await waitForHttp(`${base}/`, { timeoutMs: 5000, intervalMs: 50, requestTimeoutMs: 300 }), true);
  } finally {
    await sleep(10);
    if (late) await stop(late);
  }
});
