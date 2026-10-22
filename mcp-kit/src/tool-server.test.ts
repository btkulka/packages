import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ListResourcesRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { error, image, json, text } from "./results.js";
import { connectInMemory } from "./testing.js";
import { createToolServer, type ToolContext, type ToolSpec } from "./tool-server.js";

const obj = (properties: Record<string, unknown> = {}, required: string[] = []) => ({ type: "object", properties, required, additionalProperties: false });

type Result = { content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>; isError?: boolean };

async function harness(opts: Partial<Parameters<typeof createToolServer>[0]> & { tools: ToolSpec[] }) {
  const server = createToolServer({ name: "test", version: "1.2.3", ...opts });
  const conn = await connectInMemory(server);
  const call = async (name: string, args?: Record<string, unknown>, options?: Parameters<typeof conn.client.callTool>[2]) =>
    (await conn.client.callTool({ name, arguments: args }, undefined, options)) as Result;
  return { ...conn, server, call };
}

describe("createToolServer", () => {
  it("lists every field but run, as the app wrote it", async () => {
    const h = await harness({
      tools: [
        { name: "a", title: "A", description: "first", inputSchema: obj({ x: { type: "string" } }, ["x"]), annotations: { readOnlyHint: true }, run: () => 1 },
        { name: "b", description: "second", inputSchema: { type: "object", properties: {} }, run: () => 2 },
      ],
    });
    const { tools } = await h.client.listTools();
    assert.deepEqual(tools, [
      { name: "a", title: "A", description: "first", inputSchema: obj({ x: { type: "string" } }, ["x"]), annotations: { readOnlyHint: true } },
      { name: "b", description: "second", inputSchema: { type: "object", properties: {} } },
    ]);
    await h.close();
  });

  it("sends data as JSON (indent 2), undefined as {ok:true}, and results as they are", async () => {
    const h = await harness({
      tools: [
        { name: "data", inputSchema: obj(), run: () => ({ n: 1 }) },
        { name: "nothing", inputSchema: obj(), run: async () => undefined },
        { name: "ready", inputSchema: obj(), run: () => text("plain") },
        { name: "picture", inputSchema: obj(), run: () => image("AAAA", "image/jpeg", "caption") },
      ],
    });
    assert.deepEqual(await h.call("data"), { content: [{ type: "text", text: JSON.stringify({ n: 1 }, null, 2) }] });
    assert.deepEqual(await h.call("nothing"), { content: [{ type: "text", text: JSON.stringify({ ok: true }, null, 2) }] });
    assert.deepEqual(await h.call("ready"), { content: [{ type: "text", text: "plain" }] });
    assert.deepEqual(await h.call("picture"), {
      content: [
        { type: "image", data: "AAAA", mimeType: "image/jpeg" },
        { type: "text", text: "caption" },
      ],
    });
    await h.close();
  });

  it("indent and format change how data is sent", async () => {
    const compact = await harness({ indent: 0, tools: [{ name: "d", inputSchema: obj(), run: () => ({ n: 1 }) }] });
    assert.equal((await compact.call("d")).content[0].text, '{"n":1}');
    await compact.close();

    // Benhäus's screenshot convention, without touching its tools: { image: { data, mimeType }, text? }.
    const custom = await harness({
      format: (out) => {
        const o = out as { image?: { data: string; mimeType: string }; text?: string };
        return o?.image ? image(o.image.data, o.image.mimeType, o.text) : json(out);
      },
      tools: [{ name: "shot", inputSchema: obj(), run: () => ({ image: { data: "QQ==", mimeType: "image/png" } }) }],
    });
    assert.deepEqual(await custom.call("shot"), { content: [{ type: "image", data: "QQ==", mimeType: "image/png" }] });
    await custom.close();
  });

  it("passes arguments, defaulting to {} when the call has none", async () => {
    const seen: unknown[] = [];
    const h = await harness({ tools: [{ name: "echo", inputSchema: { type: "object" }, run: (args) => (seen.push(args), args) }] });
    await h.call("echo", { a: 1 });
    await h.call("echo");
    assert.deepEqual(seen, [{ a: 1 }, {}]);
    await h.close();
  });

  it("routes tools without run to call(), like an app's switch or router", async () => {
    const h = await harness({
      tools: [
        { name: "one", inputSchema: obj() },
        { name: "two", inputSchema: obj(), run: () => "own" },
      ],
      call: (name, args) => ({ via: "call", name, args }),
    });
    assert.deepEqual(JSON.parse((await h.call("one", { k: 1 })).content[0].text!), { via: "call", name: "one", args: { k: 1 } });
    assert.equal((await h.call("two")).content[0].text, JSON.stringify("own", null, 2));
    await h.close();
  });

  it("refuses a tool with no handler at all", () => {
    assert.throws(() => createToolServer({ name: "x", version: "1", tools: [{ name: "lost", inputSchema: obj() }] }), /lost has no run\(\)/);
  });

  it("answers unknown tools with an isError result by default", async () => {
    const h = await harness({ tools: [{ name: "a", inputSchema: obj(), run: () => 1 }] });
    assert.deepEqual(await h.call("zzz"), { isError: true, content: [{ type: "text", text: "Unknown tool: zzz" }] });
    await h.close();
  });

  it("onUnknown can rename it (benhaus) or throw a JSON-RPC error (orson)", async () => {
    const renamed = await harness({ tools: [], onUnknown: (n) => error(`Benhäus has no tool called ${n}.`) });
    assert.deepEqual(await renamed.call("zzz"), { isError: true, content: [{ type: "text", text: "Benhäus has no tool called zzz." }] });
    await renamed.close();

    const throwing = await harness({
      tools: [],
      onUnknown: (n) => {
        throw new Error(`Unknown tool: ${n}`);
      },
    });
    await assert.rejects(throwing.call("zzz"), /Unknown tool: zzz/);
    await throwing.close();
  });

  it("turns a throw into an isError result with the message, unless onError rethrows", async () => {
    const boom: ToolSpec = {
      name: "boom",
      inputSchema: obj(),
      run: () => {
        throw new Error("kaput");
      },
    };
    const h = await harness({ tools: [boom] });
    assert.deepEqual(await h.call("boom"), { isError: true, content: [{ type: "text", text: "kaput" }] });
    await h.close();

    const custom = await harness({ tools: [boom], onError: (e, name) => error(`Internal error in ${name}: ${(e as Error).message}`) });
    assert.equal((await custom.call("boom")).content[0].text, "Internal error in boom: kaput");
    await custom.close();

    const rethrow = await harness({
      tools: [boom],
      onError: (e) => {
        throw e;
      },
    });
    await assert.rejects(rethrow.call("boom"), /kaput/);
    await rethrow.close();
  });

  it("validate checks arguments against the inputSchema before running", async () => {
    let ran = 0;
    const h = await harness({
      validate: true,
      tools: [{ name: "open", inputSchema: obj({ target: { type: "string" } }, ["target"]), run: () => ++ran }],
    });
    assert.deepEqual(await h.call("open", {}), { isError: true, content: [{ type: "text", text: "open: target is required." }] });
    assert.deepEqual(await h.call("open", { target: "x", extra: 1 }), {
      isError: true,
      content: [{ type: "text", text: "open: Unknown argument extra. Expected: target." }],
    });
    assert.equal(ran, 0);
    await h.call("open", { target: "home" });
    assert.equal(ran, 1);
    await h.close();
  });

  it("does not validate unless asked", async () => {
    const h = await harness({ tools: [{ name: "open", inputSchema: obj({}, ["target"]), run: (a) => a }] });
    assert.equal((await h.call("open", {})).isError, undefined);
    await h.close();
  });

  it("gives progress() only when the caller sent a progressToken, and streams messages (orson's text deltas)", async () => {
    let hadProgress: boolean | undefined;
    const h = await harness({
      tools: [
        {
          name: "narrate",
          inputSchema: obj(),
          run: async (_a, ctx: ToolContext) => {
            hadProgress = !!ctx.progress;
            ctx.progress?.("Once ");
            ctx.progress?.("upon");
            return text("Once upon");
          },
        },
      ],
    });
    await h.call("narrate");
    assert.equal(hadProgress, false);

    const deltas: Array<{ message?: string; progress: number }> = [];
    const r = await h.call("narrate", {}, { onprogress: (p) => deltas.push(p), resetTimeoutOnProgress: true });
    assert.equal(hadProgress, true);
    assert.equal(r.content[0].text, "Once upon");
    assert.deepEqual(
      deltas.map((d) => [d.message, d.progress]),
      [
        ["Once ", 0],
        ["upon", 0],
      ],
    );
    await h.close();
  });

  it("passes the tool name and the SDK extra to handlers", async () => {
    let ctx: ToolContext | undefined;
    const h = await harness({ tools: [{ name: "who", inputSchema: obj(), run: (_a, c) => ((ctx = c), null) }] });
    await h.call("who");
    assert.equal(ctx?.name, "who");
    assert.ok(ctx?.extra.signal instanceof AbortSignal);
    await h.close();
  });

  it("sends instructions, merges capabilities and lets the app add handlers (clipdrift's resources)", async () => {
    const server = createToolServer({
      name: "clipdrift-mcp",
      version: "0.1.0",
      instructions: "Use upscale_check_system first.",
      capabilities: { resources: {} },
      tools: [{ name: "a", inputSchema: obj(), run: () => 1 }],
    });
    server.setRequestHandler(ListResourcesRequestSchema, async () => ({ resources: [{ uri: "clipdrift://status", name: "Server Status" }] }));
    const { client, close } = await connectInMemory(server);
    assert.equal(client.getInstructions(), "Use upscale_check_system first.");
    assert.deepEqual(client.getServerVersion(), { name: "clipdrift-mcp", version: "0.1.0" });
    const caps = client.getServerCapabilities();
    assert.ok(caps?.tools && caps.resources);
    assert.equal((await client.listResources()).resources[0].uri, "clipdrift://status");
    await close();
  });

  it("calls the first of two tools with the same name", async () => {
    const h = await harness({
      tools: [
        { name: "dup", inputSchema: obj(), run: () => "first" },
        { name: "dup", inputSchema: obj(), run: () => "second" },
      ],
    });
    assert.equal((await h.call("dup")).content[0].text, '"first"');
    await h.close();
  });
});
