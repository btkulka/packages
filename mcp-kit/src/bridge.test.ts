import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ToolListChangedNotificationSchema } from "@modelcontextprotocol/sdk/types.js";
import { createBridge, type BridgeOptions, type Upstream } from "./bridge.js";
import { serveHttp, type HttpHandle } from "./http.js";
import { text } from "./results.js";
import { connectInMemory } from "./testing.js";
import { createToolServer } from "./tool-server.js";

const TOKEN = "k".repeat(48);
const obj = { type: "object", properties: {}, additionalProperties: false };

/** The app: a token-guarded HTTP endpoint with two tools. */
async function app(label = "live"): Promise<HttpHandle> {
  return serveHttp({
    port: 0,
    token: TOKEN,
    createServer: () =>
      createToolServer({
        name: "app",
        version: "1.0.0",
        tools: [
          { name: "status", description: "app status", inputSchema: obj, run: () => ({ label }) },
          { name: "launch_app", description: "the app's own copy, hidden by the bridge's", inputSchema: obj, run: () => "upstream" },
          {
            name: "fails",
            inputSchema: obj,
            run: () => {
              throw new Error("upstream said no");
            },
          },
        ],
      }),
  });
}

const CACHED = [{ name: "status", description: "cached status", inputSchema: obj }];

async function bridge(over: Partial<BridgeOptions> & { locate: BridgeOptions["locate"] }) {
  const changed: number[] = [];
  const logs: string[] = [];
  const b = createBridge({
    name: "app",
    version: "1.0.0",
    instructions: "Start with status.",
    cachedTools: () => CACHED,
    localTools: [{ name: "launch_app", description: "Open the app.", inputSchema: obj, run: () => text("launched") }],
    log: (...p) => logs.push(p.join(" ")),
    ...over,
  });
  const conn = await connectInMemory(b.server);
  conn.client.setNotificationHandler(ToolListChangedNotificationSchema, async () => void changed.push(Date.now()));
  return { ...conn, bridge: b, changed, logs };
}

const at = (h: HttpHandle): Upstream => ({ url: h.url, headers: { Authorization: `Bearer ${TOKEN}` } });
const textOf = (r: unknown) => (r as { content: Array<{ text: string }> }).content[0].text;
const tick = () => new Promise((r) => setTimeout(r, 50));

describe("createBridge", () => {
  it("lists local tools first, then the app's, hiding app tools with a local name", async () => {
    const up = await app();
    const b = await bridge({ locate: () => at(up) });
    const { tools } = await b.client.listTools();
    assert.deepEqual(
      tools.map((t) => [t.name, t.description]),
      [
        ["launch_app", "Open the app."],
        ["status", "app status"],
        ["fails", undefined],
      ],
    );
    assert.equal(b.client.getInstructions(), "Start with status.");
    assert.ok(b.client.getServerCapabilities()?.tools?.listChanged);
    await b.close();
    await up.close();
  });

  it("relays calls, passing the app's result through as it is", async () => {
    const up = await app();
    const b = await bridge({ locate: () => at(up) });
    assert.deepEqual(JSON.parse(textOf(await b.client.callTool({ name: "status" }))), { label: "live" });
    const failed = (await b.client.callTool({ name: "fails" })) as { isError?: boolean };
    assert.equal(failed.isError, true);
    assert.equal(textOf(failed), "upstream said no");
    assert.equal(textOf(await b.client.callTool({ name: "launch_app" })), "launched");
    await b.close();
    await up.close();
  });

  it("lists the cache while the app is down", async () => {
    const b = await bridge({ locate: () => undefined });
    assert.deepEqual(
      (await b.client.listTools()).tools.map((t) => [t.name, t.description]),
      [
        ["launch_app", "Open the app."],
        ["status", "cached status"],
      ],
    );
    await b.close();
  });

  it("starts the app for a call while it's down, then tells the client the tool list changed", async () => {
    let up: HttpHandle | undefined;
    let starts = 0;
    const b = await bridge({
      locate: () => (up ? at(up) : undefined),
      start: async () => {
        starts++;
        up = await app("started");
      },
    });
    assert.deepEqual(JSON.parse(textOf(await b.client.callTool({ name: "status" }))), { label: "started" });
    assert.equal(starts, 1);
    await tick();
    assert.equal(b.changed.length, 1);
    await b.close();
    await up?.close();
  });

  it("returns start's failure as an error result", async () => {
    const b = await bridge({
      locate: () => undefined,
      start: async () => {
        throw new Error("The app didn't start (exe missing).");
      },
    });
    const r = (await b.client.callTool({ name: "status" })) as { isError?: boolean };
    assert.equal(r.isError, true);
    assert.equal(textOf(r), "The app didn't start (exe missing).");
    await b.close();
  });

  it("says the endpoint isn't answering yet when start returns but nothing is there", async () => {
    const b = await bridge({ locate: () => undefined, start: async () => {}, notReadyMessage: "Benhäus is starting. Try again." });
    const r = (await b.client.callTool({ name: "status" })) as { isError?: boolean };
    assert.equal(r.isError, true);
    assert.equal(textOf(r), "Benhäus is starting. Try again.");
    await b.close();
  });

  it("reconnects and retries once when the app restarted since the last call", async () => {
    let up = await app("first");
    const b = await bridge({ locate: () => at(up) });
    assert.deepEqual(JSON.parse(textOf(await b.client.callTool({ name: "status" }))), { label: "first" });
    await up.close();
    up = await app("second");
    assert.deepEqual(JSON.parse(textOf(await b.client.callTool({ name: "status" }))), { label: "second" });
    await b.close();
    await up.close();
  });

  it("falls back to the cache when listing fails mid-way, and logs it", async () => {
    let up: HttpHandle | undefined = await app();
    const b = await bridge({ locate: () => (up ? at(up) : undefined) });
    assert.equal((await b.client.listTools()).tools.length, 3);
    await up.close();
    up = undefined;
    assert.deepEqual(
      (await b.client.listTools()).tools.map((t) => t.description),
      ["Open the app.", "cached status"],
    );
    assert.ok(b.logs.some((l) => l.startsWith("listTools failed")));
    await b.close();
  });

  it("lets local tools announce a changed tool list", async () => {
    const b = await bridge({
      locate: () => undefined,
      localTools: [
        {
          name: "launch_app",
          inputSchema: obj,
          run: (_a, ctx) => {
            ctx.toolsChanged();
            return { content: [{ type: "text", text: "Opened." }], isError: false };
          },
        },
      ],
    });
    const r = await b.client.callTool({ name: "launch_app" });
    assert.deepEqual(r, { content: [{ type: "text", text: "Opened." }], isError: false });
    await tick();
    assert.equal(b.changed.length, 1);
    await b.close();
  });
});
