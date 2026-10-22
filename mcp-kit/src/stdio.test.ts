import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { describe, it } from "node:test";
import { Client, StdioClientTransport, getDefaultEnvironment } from "./index.js";

// Each test runs a real stdio server in a child process (the built CommonJS
// entry, so this also proves the CJS build works) and talks to it over its pipes.
// Tests run from the package folder.
const KIT = `${process.cwd().replace(/\\/g, "/")}/dist/cjs/index.js`;

const FIXTURE = `
const { createToolServer, serveStdio, runMain } = require(${JSON.stringify(KIT)});
const mode = process.env.KIT_MODE;
runMain(async () => {
  if (mode === "fail") throw new Error("boom at start");
  const server = createToolServer({
    name: "fixture",
    version: "1.0.0",
    tools: [
      { name: "ping", inputSchema: { type: "object" }, run: () => ({ pong: true, pid: process.pid }) },
      { name: "signal", inputSchema: { type: "object" }, run: () => { setTimeout(() => process.emit("SIGTERM"), 20); return "ok"; } },
    ],
  });
  const h = await serveStdio(server, {
    exit: mode !== "noexit",
    shutdownTimeoutMs: mode === "hang" ? 300 : 5000,
    onShutdown: async (reason) => {
      process.stderr.write("cleanup:" + reason + "\\n");
      if (mode === "hang") await new Promise(() => {});
    },
  });
  if (mode === "noexit") h.closed.then((r) => { process.stderr.write("closed:" + r + "\\n"); process.exitCode = 3; });
});
`;

interface Child {
  proc: ChildProcess;
  stderr: () => string;
  exit: Promise<number | null>;
  request(method: string, params?: unknown): Promise<{ result?: any; error?: any }>;
  notify(method: string, params?: unknown): void;
}

function start(mode: string): Child {
  const proc = spawn(process.execPath, ["-e", FIXTURE], { env: { ...process.env, KIT_MODE: mode }, stdio: ["pipe", "pipe", "pipe"] });
  let err = "";
  proc.stderr!.on("data", (d) => (err += d));
  const exit = new Promise<number | null>((r) => proc.once("exit", (code) => r(code)));
  const pending = new Map<number, (m: any) => void>();
  let buf = "";
  proc.stdout!.on("data", (d) => {
    buf += d;
    let nl;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      const msg = JSON.parse(line);
      pending.get(msg.id)?.(msg);
      pending.delete(msg.id);
    }
  });
  let id = 0;
  return {
    proc,
    stderr: () => err,
    exit,
    request: (method, params) =>
      new Promise((resolve) => {
        const n = ++id;
        pending.set(n, resolve);
        proc.stdin!.write(JSON.stringify({ jsonrpc: "2.0", id: n, method, params }) + "\n");
      }),
    notify: (method, params) => proc.stdin!.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n"),
  };
}

async function initialized(c: Child) {
  const init = await c.request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "0" } });
  assert.equal(init.result.serverInfo.name, "fixture");
  c.notify("notifications/initialized");
}

describe("serveStdio", () => {
  it("serves tools to the kit's own stdio client", async () => {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: ["-e", FIXTURE],
      env: { ...getDefaultEnvironment(), KIT_MODE: "plain" },
      stderr: "pipe",
    });
    const client = new Client({ name: "t", version: "0" });
    await client.connect(transport);
    const tools = await client.listTools();
    assert.deepEqual(
      tools.tools.map((t) => t.name),
      ["ping", "signal"],
    );
    const r = (await client.callTool({ name: "ping" })) as { content: Array<{ text: string }> };
    assert.equal(JSON.parse(r.content[0].text).pong, true);
    await client.close();
  });

  it("shuts down on stdin EOF: runs onShutdown, logs to stderr, exits 0", async () => {
    const c = start("plain");
    await initialized(c);
    const r = await c.request("tools/call", { name: "ping", arguments: {} });
    assert.equal(JSON.parse(r.result.content[0].text).pong, true);
    c.proc.stdin!.end();
    assert.equal(await c.exit, 0);
    assert.match(c.stderr(), /\[mcp\] parent gone \(stdin EOF\); shutting down/);
    assert.match(c.stderr(), /cleanup:parent gone \(stdin EOF\)/);
  });

  it("shuts down on SIGTERM / SIGINT", async () => {
    const c = start("plain");
    await initialized(c);
    await c.request("tools/call", { name: "signal", arguments: {} });
    assert.equal(await c.exit, 0);
    assert.match(c.stderr(), /cleanup:SIGTERM/);
  });

  it("exits anyway when onShutdown hangs past shutdownTimeoutMs", async () => {
    const c = start("hang");
    await initialized(c);
    const t0 = Date.now();
    c.proc.stdin!.end();
    assert.equal(await c.exit, 0);
    assert.ok(Date.now() - t0 < 4000);
    assert.match(c.stderr(), /cleanup:parent gone/);
    assert.match(c.stderr(), /shutdown took over 300 ms; exiting anyway/);
  });

  it("with exit: false, resolves closed and leaves the exit to the caller", async () => {
    const c = start("noexit");
    await initialized(c);
    c.proc.stdin!.end();
    assert.equal(await c.exit, 3);
    assert.match(c.stderr(), /closed:parent gone \(stdin EOF\)/);
  });
});

describe("runMain", () => {
  it("logs a failed start with the error and exits 1", async () => {
    const c = start("fail");
    assert.equal(await c.exit, 1);
    assert.match(c.stderr(), /MCP server failed to start: Error: boom at start/);
  });
});
