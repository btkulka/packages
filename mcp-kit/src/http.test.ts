import assert from "node:assert/strict";
import { createServer, request, type Server as NodeHttpServer } from "node:http";
import { after, before, describe, it } from "node:test";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Client } from "./index.js";
import { sameToken, serveHttp, type HttpHandle } from "./http.js";
import { createToolServer } from "./tool-server.js";

const TOKEN = "t".repeat(48);

function raw(port: number, path: string, opts: { method?: string; headers?: Record<string, string>; body?: string } = {}) {
  return new Promise<{ status: number; body: any }>((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, path, method: opts.method ?? "GET", headers: opts.headers }, (res) => {
      let data = "";
      res.on("data", (d) => (data += d));
      res.on("end", () => resolve({ status: res.statusCode!, body: data ? JSON.parse(data) : undefined }));
    });
    req.on("error", reject);
    if (opts.body) req.write(opts.body);
    req.end();
  });
}

const tools = () =>
  createToolServer({
    name: "benhaus",
    version: "9.9.9",
    tools: [{ name: "status", inputSchema: { type: "object" }, run: () => ({ up: true }) }],
  });

const occupy = () =>
  new Promise<NodeHttpServer>((resolve) => {
    const s = createServer();
    s.listen(0, "127.0.0.1", () => resolve(s));
  });
const portOf = (s: NodeHttpServer) => (s.address() as { port: number }).port;

describe("serveHttp", () => {
  let h: HttpHandle;
  let shown = 0;
  before(async () => {
    h = await serveHttp({
      createServer: tools,
      port: 0,
      token: TOKEN,
      health: () => ({ ok: true, app: "Benhäus", pid: process.pid }),
      routes: {
        "/control/show": () => (shown++, { shown: true }),
        "/control/fail": () => {
          throw new Error("no window");
        },
      },
    });
  });
  after(() => h.close());

  it("serves MCP to a client with the token", async () => {
    assert.equal(h.url, `http://127.0.0.1:${h.port}/mcp`);
    const client = new Client({ name: "t", version: "0" });
    await client.connect(new StreamableHTTPClientTransport(new URL(h.url), { requestInit: { headers: { Authorization: `Bearer ${TOKEN}` } } }));
    assert.deepEqual(
      (await client.listTools()).tools.map((t) => t.name),
      ["status"],
    );
    const r = (await client.callTool({ name: "status" })) as { content: Array<{ text: string }> };
    assert.deepEqual(JSON.parse(r.content[0].text), { up: true });
    await client.close();
  });

  it("answers /health without a token", async () => {
    assert.deepEqual(await raw(h.port, "/health"), { status: 200, body: { ok: true, app: "Benhäus", pid: process.pid } });
  });

  it("refuses browsers (an Origin header) and other Host names", async () => {
    assert.equal((await raw(h.port, "/health", { headers: { origin: "http://evil.example" } })).status, 403);
    assert.equal((await raw(h.port, "/health", { headers: { host: `evil.example:${h.port}` } })).status, 403);
    assert.equal((await raw(h.port, "/health", { headers: { host: `localhost:${h.port}` } })).status, 200);
  });

  it("needs the bearer token for the endpoint and the routes", async () => {
    const init = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
    assert.deepEqual(await raw(h.port, "/mcp", { method: "POST", body: init }), { status: 401, body: { error: "unauthorized" } });
    assert.equal((await raw(h.port, "/mcp", { method: "POST", body: init, headers: { authorization: `Bearer ${"x".repeat(48)}` } })).status, 401);
    assert.equal((await raw(h.port, "/control/show", { method: "POST" })).status, 401);
  });

  it("runs routes on POST only", async () => {
    const auth = { authorization: `Bearer ${TOKEN}` };
    assert.deepEqual(await raw(h.port, "/control/show", { method: "POST", headers: auth }), { status: 200, body: { shown: true } });
    assert.equal(shown, 1);
    assert.equal((await raw(h.port, "/control/show", { headers: auth })).status, 404);
    assert.deepEqual(await raw(h.port, "/control/fail", { method: "POST", headers: auth }), { status: 500, body: { error: "no window" } });
  });

  it("answers 404 off the endpoint and 405 for GET on it", async () => {
    const auth = { authorization: `Bearer ${TOKEN}` };
    assert.equal((await raw(h.port, "/elsewhere", { headers: auth })).status, 404);
    const get = await raw(h.port, "/mcp", { headers: auth });
    assert.equal(get.status, 405);
    assert.equal(get.body.error.message, "Method not allowed.");
  });

  it("answers 500 with a JSON-RPC error for a body that isn't JSON", async () => {
    const r = await raw(h.port, "/mcp", { method: "POST", body: "{nope", headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" } });
    assert.equal(r.status, 500);
    assert.equal(r.body.error.code, -32603);
  });
});

describe("serveHttp limits and ports", () => {
  it("refuses a body over maxBodyBytes with 413", async () => {
    const h = await serveHttp({ createServer: tools, port: 0, maxBodyBytes: 100 });
    const r = await raw(h.port, "/mcp", { method: "POST", body: JSON.stringify({ pad: "x".repeat(500) }), headers: { "content-type": "application/json" } });
    assert.equal(r.status, 413);
    await h.close();
  });

  it("works without a token and without /health", async () => {
    const h = await serveHttp({ createServer: tools, port: 0 });
    assert.equal((await raw(h.port, "/health")).status, 404);
    const client = new Client({ name: "t", version: "0" });
    await client.connect(new StreamableHTTPClientTransport(new URL(h.url)));
    assert.equal((await client.listTools()).tools.length, 1);
    await client.close();
    await h.close();
  });

  it("moves to the next port when the preferred one is taken", async () => {
    const blocker = await occupy();
    const taken = portOf(blocker);
    const h = await serveHttp({ createServer: tools, port: taken });
    assert.ok(h.port > taken && h.port < taken + 10, `bound ${h.port}`);
    assert.equal(h.url, `http://127.0.0.1:${h.port}/mcp`);
    await h.close();
    blocker.close();
  });

  it("rejects when every port it may try is taken", async () => {
    const blocker = await occupy();
    const taken = portOf(blocker);
    await assert.rejects(serveHttp({ createServer: tools, port: taken, portAttempts: 1 }), new RegExp(`Ports ${taken}–${taken} are all in use`));
    blocker.close();
  });
});

describe("sameToken", () => {
  it("compares tokens, including different lengths", () => {
    assert.equal(sameToken("abc", "abc"), true);
    assert.equal(sameToken("abc", "abd"), false);
    assert.equal(sameToken("abc", "abcd"), false);
  });
});
