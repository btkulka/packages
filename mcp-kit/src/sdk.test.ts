import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { join } from "node:path";
import { describe, it } from "node:test";
import { McpServer, ResourceTemplate, json, z, connectInMemory, error } from "./index.js";

describe("one SDK, one zod", () => {
  it("the SDK resolves the same zod the kit re-exports", () => {
    // Tests run from the package folder.
    const here = createRequire(join(process.cwd(), "package.json"));
    const sdkPkg = here.resolve("@modelcontextprotocol/sdk/package.json");
    const fromSdk = createRequire(sdkPkg).resolve("zod");
    assert.equal(fromSdk, here.resolve("zod"));
  });

  it("McpServer.registerTool takes the kit's zod (job-searcher, candybar-manager)", async () => {
    const server = new McpServer({ name: "jobhunt", version: "1.0.0" }, { instructions: "Start with get_stats." });
    server.registerTool(
      "search",
      {
        title: "Search",
        description: "Find applications.",
        inputSchema: { query: z.string().min(1), limit: z.number().int().min(1).max(200).optional().describe("Max rows") },
        annotations: { readOnlyHint: true },
      },
      async ({ query, limit }) => json({ query, limit: limit ?? 25 }),
    );
    server.tool("check_health", "Run a health check.", { filePath: z.string().describe("Absolute path") }, async ({ filePath }) =>
      filePath.endsWith(".wav") ? json({ ok: true }) : error("not audio"),
    );
    server.registerResource("stats", "jobhunt://stats", { mimeType: "application/json" }, (uri) => ({
      contents: [{ uri: uri.href, mimeType: "application/json", text: "{}" }],
    }));
    server.registerResource("app", new ResourceTemplate("jobhunt://applications/{id}", { list: undefined }), { mimeType: "application/json" }, (uri, { id }) => ({
      contents: [{ uri: uri.href, text: String(id) }],
    }));

    const { client, close } = await connectInMemory(server);
    const { tools } = await client.listTools();
    const search = tools.find((t) => t.name === "search")!;
    assert.deepEqual(search.inputSchema.required, ["query"]);
    assert.deepEqual((search.inputSchema.properties as Record<string, { type?: string; description?: string }>).limit.description, "Max rows");
    assert.equal((search.inputSchema.properties as Record<string, { type?: string }>).limit.type, "integer");

    const ok = (await client.callTool({ name: "search", arguments: { query: "se" } })) as { content: Array<{ text: string }> };
    assert.deepEqual(JSON.parse(ok.content[0].text), { query: "se", limit: 25 });

    const bad = (await client.callTool({ name: "search", arguments: { query: "" } })) as { isError?: boolean; content: Array<{ text: string }> };
    assert.equal(bad.isError, true);
    assert.match(bad.content[0].text, /Input validation error/);

    assert.equal(((await client.callTool({ name: "check_health", arguments: { filePath: "a.mp3" } })) as { isError?: boolean }).isError, true);
    assert.equal(((await client.readResource({ uri: "jobhunt://applications/7" })).contents[0] as { text: string }).text, "7");
    await close();
  });
});
