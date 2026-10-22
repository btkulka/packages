# @btkulka/mcp-kit

The plumbing behind Ben's MCP servers. About 17 servers across benhaus, orson, clipdrift, job-searcher, candybar-manager, nhi-dashboard, starfall and lemonsqueezy-mcp each hand-rolled the same pieces. This package has one copy of each:

- one pinned `@modelcontextprotocol/sdk` and one `zod`, re-exported, so every app's schemas and servers come from the same instance;
- a tool-table server (`createToolServer`): tools/list and tools/call from an array of tools, with error wrapping, optional argument checks and progress messages;
- result helpers (`text`, `json`, `error`, `jsonError`, `image`);
- stdio serving (`serveStdio`) with a parent-process watchdog and clean shutdown, plus `runMain` for the entry point;
- a token-guarded Streamable HTTP endpoint (`serveHttp`), Benhäus's in-app server;
- a stdio-to-HTTP bridge (`createBridge`), Benhäus's `mcp/bridge.cjs`;
- stderr logging (`createLogger`) and an in-memory client for tests (`connectInMemory`).

**Plumbing only.** Tool names, descriptions, schemas and handlers stay in the apps. Benhäus's parity rules (`mcp/parity.mjs`) read its own tool list, which doesn't move.

Node only (no browser entry). ESM and CommonJS builds. Windows first, POSIX kept.

```json
"dependencies": { "@btkulka/mcp-kit": "file:../packages/mcp-kit" }
```

Build it first (`npm run build` in this folder); apps load `dist/`.

## Versions: one SDK, one zod

What the apps have today (installed version, from their `node_modules`):

| App | `@modelcontextprotocol/sdk` (range → installed) | `zod` (range → installed) |
|---|---|---|
| benhaus | ^1.30.0 → 1.30.0 | none direct (4.6.7 via the SDK) |
| orson | ^1.0.4 → 1.29.0 | ^4.3.6 → 4.3.6 |
| clipdrift | ^1.25.3 → 1.27.1 | none direct (4.3.6 via the SDK) |
| job-searcher | ^1.30.0 → 1.30.0 | ^3.25.0 → **3.25.76** |
| candybar-manager | ^1.27.1 → 1.29.0 | ^4.3.6 → 4.3.6 |
| nhi-dashboard | ^1.30.0 → 1.30.0 | none direct (4.6.5 via the SDK) |
| starfall | ^1.29.0 → 1.29.0 | 4.4.3 (transitive) |
| lemonsqueezy-mcp | ^1.25.3 → 1.26.0 | none direct (4.3.6 via the SDK) |

**The kit pins `@modelcontextprotocol/sdk` 1.32.1 exactly**, and depends on `zod` ^4.3.6 (4.6.7 installed in `packages/node_modules`, the only copy there, and the one the SDK resolves; a test checks this). 1.32.1 is the current release and the first without the advisories npm audit reports for every version below it, two of which touch what the kit does: HTTP client transports followed cross-origin redirects and re-sent custom headers (the bridge sends a bearer token), and one request inside the default size limit could exhaust server memory during validation (the HTTP endpoint). Everything the apps use (`Server`, `McpServer.registerTool`/`tool`/`registerResource`/`registerPrompt`, `ResourceTemplate`, the stdio and Streamable HTTP transports, `Client`) is in 1.32.1, and the kit's tests run on it. Bump the pin deliberately, here, for everyone.

**How apps get zod: import `z` from `@btkulka/mcp-kit`, never from their own `zod`, for any schema that reaches the SDK** (`McpServer.registerTool`, `server.tool`, `registerPrompt` argsSchema). The SDK wraps, parses and converts those schemas with its own zod functions (`z4mini.object(shape)`, `z4mini.safeParse(schema, data)`, `z4mini.toJSONSchema(schema)`), so a schema built with a second zod copy is handed to a different library's internals; a shape that mixes zod 3 and zod 4 values throws `Mixed Zod versions detected in object shape.` Schemas an app only `.parse()`s itself (orson's per-tool argument schemas, job-searcher's research/digest schemas) can stay on the app's own zod.

Likewise import `McpServer`, `Server`, `Client` and the request schemas from the kit, and drop the app's direct `@modelcontextprotocol/sdk` dependency, so the server and its schemas come from one SDK. (Benhäus keeps it as a dependency for packaging; see its notes.)

## API

```ts
import {
  // results
  text, json, error, jsonError, image, errorMessage, isToolResult, toResult,
  // servers
  createToolServer, listTools, checkArgs,
  serveStdio, runMain, installParentWatchdog, pidAlive,
  serveHttp, sameToken, createBridge,
  createLogger, connectInMemory,
  // re-exports: the one SDK and zod
  z, Server, McpServer, ResourceTemplate, Client, StdioClientTransport, getDefaultEnvironment,
  CallToolRequestSchema, ListToolsRequestSchema, ListResourcesRequestSchema, ReadResourceRequestSchema,
  type CallToolResult, type Tool,
} from "@btkulka/mcp-kit";
```

### Results

The exact wire shapes the apps' own `ok()` / `err()` / `reply()` produced:

| Call | Result |
|---|---|
| `text(s)` | `{ content: [{ type: "text", text: s }] }` |
| `json(v, indent = 2)` | `text(JSON.stringify(v, null, indent))`; `indent` 0 is compact. `undefined` becomes `null`. |
| `error(msg)` | `{ isError: true, content: [{ type: "text", text: msg }] }` |
| `jsonError(msg, indent = 2)` | `{ isError: true, content: [{ type: "text", text: JSON.stringify({ error: msg }, null, indent) }] }` |
| `image(data, mimeType, caption?)` | an image block, then a text block when `caption` is given |
| `errorMessage(e)` | `e.message` for an Error, else `String(e)` |
| `isToolResult(v)` | true for a plain object whose only keys are `content` / `isError` / `structuredContent` / `_meta`, with `content` an array of blocks that each have a string `type` |
| `toResult(v, indent = 2)` | `v` if `isToolResult(v)`, `json({ ok: true })` for `undefined`, else `json(v, indent)` |

### `createToolServer(options): Server`

A low-level SDK `Server` with tools/list and tools/call wired to a tool table. Add other handlers (resources, prompts) to the returned server as usual.

```ts
const server = createToolServer({
  name: "nhi-dash",
  version: pkg.version,
  instructions: INSTRUCTIONS,                 // optional
  capabilities: { resources: {} },            // optional, merged over { tools: {} }
  tools: [
    { name: "get_overview", description: "…", inputSchema: { type: "object", properties: {} }, run: (args, ctx) => api.overview(db) },
  ],
});
```

- **`tools: ToolSpec[]`**: `{ name, description?, inputSchema, run?, …anything else }`. tools/list sends each spec minus `run`, exactly as written (title, annotations, outputSchema pass through). Read once, at creation. If two share a name, the first is called.
- **`run(args, ctx)`** returns data (sent through `format`, by default `toResult`: JSON with indent 2, `undefined` as `{"ok": true}`) or a ready result (`text(…)`, `json(…, 0)`, `{ content: [...] }`), sent as it is. `args` is `{}` when the call had none.
- **`call(name, args, ctx)`**: the handler for tools without `run`. Plug in an app's existing switch or router as it is.
- **`ctx`**: `{ name, extra, progress? }`. `extra` is the SDK's `RequestHandlerExtra` (abort `signal`, `sendNotification`, `_meta`, `requestInfo`). `progress(message, progress = 0)` exists only when the caller sent a `progressToken`, and sends `notifications/progress` with that message (orson's streamed text deltas); a failed send is ignored.
- **`validate: true`** runs `checkArgs(inputSchema, args)` first and answers a problem with `error("<tool>: <problem>")` (Benhäus's check: required keys present and not null, `additionalProperties: false`, `type` incl. `integer` and type arrays, `enum`, array `items` type/enum). Default off.
- **`indent`** (default 2) and **`format(value, spec)`** decide how data is sent.
- **`onUnknown(name)`**: a call to a tool that isn't listed. Default `error("Unknown tool: <name>")`. Throw instead to send a JSON-RPC error.
- **`onError(err, name)`**: a handler (or `format`) threw. Default `error(errorMessage(err))`. Rethrow to send a JSON-RPC error (`code` from the error if it has a numeric one, else -32603).
- Throws at creation if a tool has no `run` and there is no `call`.

### `serveStdio(server, options?): Promise<StdioHandle>`

Connects a `StdioServerTransport` to a `Server` or `McpServer`, then shuts down cleanly on whichever comes first:

- stdin EOF / close, or the parent pid is gone (the watchdog, polled every 2 s; on by default);
- SIGINT / SIGTERM (on by default).

Shutting down: log `[mcp] <reason>; shutting down` to stderr, `await onShutdown(reason)`, `await server.close()` (which fires the server's `onclose`), then `process.exit(0)`. The hook plus close get `shutdownTimeoutMs` (default 5000); past that it exits anyway. Runs once.

```ts
await serveStdio(server, {
  onShutdown: () => db.close(),            // close a database, a browser…
  watchdog: true,                          // or { intervalMs } or false
  signals: true,
  shutdownTimeoutMs: 5000,
  exit: true,                              // false: only resolve handle.closed, the caller exits
  log: createLogger("orson-image"),        // where the shutdown line goes
});
// → { transport, closed: Promise<reason>, shutdown(reason?) }
```

Rejects if the transport can't connect. Never writes to stdout.

### `runMain(main, { label?, log? })`

Runs an async entry point; if it rejects, logs `<label> failed to start: <error with stack>` (label default `MCP server`) and exits 1.

```ts
runMain(async () => {
  const db = openDb(process.env.NHI_DB || DEFAULT_DB);
  await serveStdio(createServer(db));
  log(`ready, ${tools(db).length} tools`);
});
```

### `installParentWatchdog(options?): stop`

The watchdog on its own (`serveStdio` installs it for you). Calls `onOrphan(reason)` once when stdin ends or closes, when `process.ppid` changes (POSIX re-parenting), or when the parent pid no longer exists (Windows keeps the old ppid, so it asks `process.kill(ppid, 0)`; `EPERM` counts as alive). The poll timer is unref'd. Default `onOrphan`: `[parent-watchdog] parent gone (<reason>); exiting` on stderr, then `exit(0)`. Options: `onOrphan`, `intervalMs` (2000), `stdin` (true), and test seams `input`, `ppid`, `alive`. `pidAlive(pid)` is exported.

Stdin EOF only fires while something reads stdin (the stdio transport does).

### `createLogger(prefix, { time?, stream? }): Log`

`createLogger("benhaus")("bridge ready")` writes `[benhaus] bridge ready` to stderr. Arguments format like `console.error` (an Error prints its stack). `time: true` gives `[upscale 12:34:56.789] …` (UTC, clipdrift's format). A closed stderr is ignored.

### `serveHttp(options): Promise<HttpHandle>`

A Streamable HTTP endpoint for a long-running app. Stateless: each POST gets a fresh server from `createServer()` and a fresh transport (JSON responses, no sessions).

```ts
const http = await serveHttp({
  createServer: () => createToolServer({ … }),
  port: 4790,                 // tries 4790…4799 (portAttempts, default 10); 0 = any free port
  host: "127.0.0.1",          // default
  path: "/mcp",               // default
  token,                      // Bearer token for /mcp and routes; omit for none
  health: () => ({ ok: true, version, pid: process.pid }),   // /health, no token
  routes: { "/control/show": () => (win.show(), { shown: true }) },  // POST, token, 200 JSON
  maxBodyBytes: 4 * 1024 * 1024,                                     // default
});
// → { url: "http://127.0.0.1:4790/mcp", port, http, close() }
```

In order: a request with an `Origin` header, or a `Host` other than `127.0.0.1:<port>` / `localhost:<port>` / `<host>:<port>`, gets 403 (browsers and DNS rebinding); `/health` answers; without the token, 401; a POST to a route runs it (a throw is a 500 `{ error }`); any other path is 404; a non-POST to the endpoint is 405. A body over the limit is 413; a body that isn't JSON is a 500 JSON-RPC error. If every port is taken it rejects with `Ports A–B are all in use.` `sameToken(a, b)` is the constant-time compare.

### `createBridge(options): Bridge`

A stdio server that relays to an app's HTTP endpoint (the app may not be running).

```ts
const bridge = createBridge({
  name: "benhaus", version: "1.0.0", instructions,
  locate: async () => (up ? { url, headers: { Authorization: `Bearer ${token}` } } : undefined),
  start: async () => { /* start the app; throw with the reason if it didn't */ },
  cachedTools: () => readToolsCache(),          // listed while the app is down
  localTools: [{ name: "launch_app", inputSchema, run: async (args, ctx) => { …; ctx.toolsChanged(); return text("Opened.") } }],
  callTimeoutMs: 300_000,                        // default
  notReadyMessage: "… isn't answering yet. Try again in a few seconds.",
  clientName: "benhaus-bridge",                  // default `<name>-bridge`
});
await serveStdio(bridge.server);
// → { server, toolsChanged(), close() }
```

- tools/list: local tools first, then the app's tools (or `cachedTools()` while it's down or listing fails), hiding app tools that share a local tool's name.
- tools/call: a local tool runs (its return goes through `toResult`). Otherwise the bridge connects (`locate()`, then a `Client` over `StreamableHTTPClientTransport` with the headers), starting the app with `start()` if `locate()` found nothing, and sends `notifications/tools/list_changed` once a start brought it up. The app's result is passed through untouched. If a call throws (the app restarted), it reconnects and retries once. Any failure, including `start()`'s, becomes `error(message)`.
- The server advertises `tools.listChanged`.

### `connectInMemory(server, clientInfo?)`

`{ client, close() }`: a `Client` linked to the server in memory. For tests.

## Replaces

| Repo | File | What | Replaced by |
|---|---|---|---|
| benhaus | `src/main/mcp/server.ts` | `sameToken` (46–50) | `sameToken` (inside `serveHttp`) |
| benhaus | `src/main/mcp/server.ts` | `invalid()` (54–75) | `checkArgs`, `validate: true` |
| benhaus | `src/main/mcp/server.ts` | `mcpServer()` list/call wiring, image and `{ok:true}` results (77–100) | `createToolServer` + `format`/`toResult`/`image` |
| benhaus | `src/main/mcp/server.ts` | `readBody`, `send`, the request handler, the port loop in `startMcp` (108–197), `http.close()` in `stopMcp` | `serveHttp`, `handle.close()` |
| benhaus | `mcp/bridge.cjs` | whole file except the Benhäus specifics (launcher calls, tools.json path, launch tool, instructions) | `createBridge` + `serveStdio` + `runMain` + `createLogger` |
| orson | `src/servers/parent-watchdog.ts` | `installParentWatchdog` | `serveStdio` (or `installParentWatchdog`); delete the file |
| orson | `src/servers/rules.ts` | `new Server` (16), list/call handlers (21, 108), stdio connect + watchdog (133–135) | `createToolServer` + `serveStdio` |
| orson | `src/servers/narrator.ts` | `new Server` (690), list/call (695, 786), progress wiring (794–815), stdio + watchdog (835–837) | `createToolServer` (`ctx.progress`) + `serveStdio` |
| orson | `src/servers/character.ts` | `new Server` (398), list/call (403, 482), progress wiring (490–511), stdio + watchdog (527–529) | `createToolServer` (`ctx.progress`) + `serveStdio` |
| orson | `src/servers/lore-gate.ts` | `new Server` (260), list/call (265, 288), stdio + watchdog (297–299) | `createToolServer` + `serveStdio` |
| orson | `src/servers/knowledge.ts` | `new Server` (23), list/call (28, 137), stdio + watchdog (168–170) | `createToolServer` + `serveStdio` |
| orson | `src/servers/dm.ts` | `new Server` (339), list/call (344, 382), stdio + watchdog (396–398) | `createToolServer` + `serveStdio` |
| orson | `src/servers/civitai-mcp.ts` | `new Server` (346), list/call + error wrapping (351–375), stdio + watchdog (377–379) | `createToolServer` + `serveStdio` |
| orson | `src/servers/image.ts` | `ok()` (26), `new Server` (461), list/call (466, 676), stdio + watchdog + SIGINT/SIGTERM db.close (784–795) | `json(…, 0)`, `createToolServer`, `serveStdio({ onShutdown })` |
| orson | `src/servers/character-state.ts` | `ok()` (17), `new Server` (21), list/call (26, 377), stdio + watchdog + SIGINT/SIGTERM db.close (538–549) | `json(…, 0)`, `createToolServer`, `serveStdio({ onShutdown })` |
| clipdrift | `src/mcp-server/index.ts` | `main()`, StdioServerTransport, SIGINT/SIGTERM, `.catch` | `runMain` + `serveStdio` |
| clipdrift | `src/mcp-server/server.ts` | `new Server` + list/call handlers (21–45) | `createToolServer({ capabilities: { resources: {} }, call })`; resource handlers and `onclose` stay |
| clipdrift | `src/mcp-server/tools/upscale.tools.ts` | `ok()` / `err()` (110–116) | `json` / `jsonError` |
| clipdrift | `src/mcp-server/tools/clip-upscale.tools.ts` | `ok()` / `err()` (104–110) | `json` / `jsonError` |
| clipdrift | `src/mcp-server/utils/realesrgan.ts` | `log()` (22–25) | `createLogger("upscale", { time: true })` |
| lemonsqueezy-mcp | `src/index.ts` | `main()`, transport, signals, `.catch` | `runMain` + `serveStdio` |
| lemonsqueezy-mcp | `src/server.ts` | `new Server` + list/call handlers | `createToolServer({ call })` |
| lemonsqueezy-mcp | `src/tools/*.tools.ts` (20 files) | `ok()` / `err()` | `json` / `jsonError(…, 0)` |
| job-searcher | `src/mcp.ts` | `reply` (133), the `isError` result in `failure()` (140–144), `startMcp` (end of file) | `json`, `error`, `serveStdio({ exit: false, onShutdown })` |
| job-searcher | `src/cli.ts` | the `mcp` command's stdin end/close + SIGINT/SIGTERM promise (≈3904–3915) | `await handle.closed` |
| job-searcher | `test/mcp.test.ts`, `test/activity.test.ts` | `Client` + `InMemoryTransport.createLinkedPair()` | `connectInMemory` |
| candybar-manager | `src/mcp-server.ts` | `{ content: [{ type: 'text', text: JSON.stringify(…) }] }` literals, `main()` + `.catch` (792–803) | `json`, `runMain` + `serveStdio` |
| nhi-dashboard | `src/mcp.js` | `createServer()` list/call + error wrapping (318–343), `main()` + `.catch` (345–355) | `createToolServer({ onError })`, `runMain` + `serveStdio` |
| starfall | `tools/lore-mcp/index.mjs` | `ok` (889), server + handlers + catch (1304–1314), `process.on("exit", closeTab)` + connect (1316–1317) | `json(…, 0)`, `createToolServer`, `serveStdio({ onShutdown: closeTab })` |
| starfall | `tools/vn-mcp/index.mjs` | server + handlers + image result (1798–1818), SIGINT/SIGTERM closeBrowser + connect (1821–1826) | `createToolServer({ format })`, `serveStdio({ onShutdown: closeBrowser })` |
| toejam | `toejam/mcp_server.py`, `mcp/` (TouchDesigner) | Python MCP servers | **not ported**: Python stays as it is |

## Not shared, and why

- **Tool definitions, instructions, discovery files.** App code. Benhäus's `~/.benhaus/mcp.json` / `tools.json`, its token reuse (`readToken`) and `launch.cjs` (`discovery`, `health`, `start`) stay in Benhäus: the paths and fields are its own. The kit takes the token, the health payload and a `locate()` function.
- **A zod tool-registration layer.** The two apps that register zod schemas (job-searcher, candybar-manager) use the SDK's `McpServer.registerTool` / `server.tool`, which already is that. The kit re-exports `McpServer` and `z` so they share one instance. Every other server uses JSON Schema tables, which `createToolServer` takes as they are; nothing derives one from the other, because that would change what tools/list advertises.
- **A data-to-result wrapper for `McpServer`.** job-searcher's `tool()` wrapper is tied to its activity log (`logged`), `UserError` and `recordError`; candybar's handlers already return results. `json`/`error` cover the shared part.
- **Orson's client side** (`src/orchestrator.ts`: spawning servers with `getDefaultEnvironment()` plus `ORSON_*` env, close-with-timeout then SIGKILL, `textFromResult`): one app. The kit re-exports `Client`, `StdioClientTransport` and `getDefaultEnvironment` so it can drop its own SDK, but the helpers stay in orson.
- **Orson's orphan sweep** (`scripts/orson/process-cleanup.ts`, argv matching over the process list): process management, proc-kit's territory. The watchdog makes orphans rarer; the sweep can stay.
- **Benhäus's Claude Desktop / Claude Code registration** (`src/main/mcp/register.ts`): one app, Benhäus-specific paths.
- **A stdout guard** (redirecting `console.log` to stderr): no app does it; they keep stdout clean by convention.

## Migration notes, per app

Common to every stdio server:

- Add `"@btkulka/mcp-kit": "file:../packages/mcp-kit"` and remove `@modelcontextprotocol/sdk` (and, where nothing else imports it, `zod`).
- `serveStdio` adds what only orson had: the server exits when its client goes away (stdin EOF or parent gone), and SIGINT/SIGTERM now run `server.close()` (so `server.onclose`) and `onShutdown` before `exit(0)`. Servers that used to linger after Claude or Electron died now don't.
- Unknown tools are decided by the `tools` list, before your handler runs. A tool your switch handles but the list doesn't name is now unknown.
- `args` is `{}` when a call sends no arguments (it used to be `undefined` in the low-level servers).

### benhaus

`src/main/mcp/server.ts` keeps `benhausHome`, `Discovery`, `readToken`, `INSTRUCTIONS`, `writeDiscovery`, `mcpInfo`, and the `mcp.json` stop marker. `startMcp` becomes:

```ts
import { createToolServer, error, image, serveHttp, toResult, type HttpHandle } from "@btkulka/mcp-kit";

let handle: HttpHandle | undefined;
const isImage = (o: unknown): o is { image: { data: string; mimeType: string }; text?: string } => !!o && typeof o === "object" && "image" in o;

export async function startMcp(host: McpHost, preferredPort: number): Promise<string | undefined> {
  const token = readToken();
  try {
    handle = await serveHttp({
      port: preferredPort,
      token,
      health: () => ({ ok: true, app: "Benhäus", version: app.getVersion(), pid: process.pid }),
      routes: {
        "/control/show": () => (host.show(), { shown: true }),
        "/control/quit": () => (setTimeout(() => host.quit(), 200), { quitting: true }),
      },
      createServer: () =>
        createToolServer({
          name: "benhaus",
          version: app.getVersion(),
          instructions: INSTRUCTIONS,
          validate: true,
          tools: TOOLS.map((t) => ({ ...t, run: (args: Record<string, unknown>) => t.run(args, host) })),
          onUnknown: (name) => error(`Benhäus has no tool called ${name}.`),
          format: (out) => (isImage(out) ? image(out.image.data, out.image.mimeType, out.text) : toResult(out)),
        }),
    });
  } catch (e) {
    lastError = (e as Error).message; // "Ports 4790–4799 are all in use.", as before
    return undefined;
  }
  current = { url: handle.url, port: handle.port, token, pid: process.pid, startedAt: new Date().toISOString(), version: app.getVersion(), appPath: app.getAppPath() };
  writeDiscovery();
  lastError = undefined;
  return current.url;
}
```

`stopMcp` calls `void handle?.close()` instead of `http?.close()`. Delete `sameToken`, `invalid`, `mcpServer`, `readBody`, `send` and the `node:http` / SDK imports. Wire output is unchanged: same results, same error texts, same status codes, except a body over 4 MiB now gets a 413 instead of a dropped socket.

`mcp/bridge.cjs` keeps `LAUNCH_TOOL`, the instructions, `cachedTools()` and the launcher calls:

```js
const { createBridge, createLogger, runMain, serveStdio } = require("@btkulka/mcp-kit");
const log = createLogger("benhaus");
const bridge = createBridge({
  name: "benhaus", version: "1.0.0", clientName: "benhaus-bridge", instructions: "…as now…", log,
  locate: async () => {
    const d = launcher.discovery();
    if (!d || !(await launcher.health(d))) return undefined;
    return { url: d.url, headers: { Authorization: `Bearer ${d.token}` } };
  },
  start: async () => {
    const r = await launcher.start({ log });
    if (!r.ok) throw new Error(`Benhäus didn't start (${r.error}). Run node ${path.join(launcher.ROOT, "scripts", "launch.cjs")} start to see why.`);
  },
  cachedTools,
  localTools: [{
    ...LAUNCH_TOOL,
    run: async (_args, ctx) => {
      const lines = [];
      const r = await launcher.start({ log: (m) => lines.push(m) });
      if (r.ok) ctx.toolsChanged();
      return { content: [{ type: "text", text: lines.join("\n") }], isError: !r.ok }; // keeps isError: false on success, as before
    },
  }],
  notReadyMessage: "Benhäus is starting but its MCP endpoint isn't answering yet. Try again in a few seconds.",
});
runMain(async () => { await serveStdio(bridge.server, { log }); log("bridge ready"); }, { label: "bridge", log });
```

Differences: the bridge now exits when Claude goes away; the connect-failure log says `couldn't reach the app:`; a startup failure logs `bridge failed to start:`.

**Packaging (must fix, or the installed app breaks).** `scripts/package.cjs` copies runtime packages listed in `package-lock.json` into `resources/app/node_modules`. With a `file:` dependency, `node_modules/@btkulka/mcp-kit` is a junction to `D:\source\packages\mcp-kit`, and `fs.cpSync` copies the junction, not the files, so the installed app would load the kit from the source tree, and the kit would resolve the SDK from `D:\source\packages\node_modules`. Copy it with `dereference: true` (at least for `link: true` lock entries), and keep `@modelcontextprotocol/sdk` (`1.32.1`, matching the kit) plus `zod` in Benhäus's own `dependencies` so the copied kit finds them in `resources/app/node_modules`. Check by running the installed `Benhaus.exe` with `ELECTRON_RUN_AS_NODE=1` on `resources\app\mcp\bridge.cjs` after `node scripts/launch.cjs update`. The electron-vite main bundle externalizes dependencies, so `out/main/index.cjs` `require`s the kit's CommonJS build at run time.

Run `npm run check` (typecheck + parity) afterwards. No tool names or results change, so parity should be untouched.

### orson

Each of the nine servers keeps its tool array (move it out of the `ListToolsRequestSchema` handler into a `const TOOLS`) and its dispatch body:

```ts
import { createToolServer, json, serveStdio, text } from "@btkulka/mcp-kit";

const server = createToolServer({
  name: "orson-rules",
  version: "0.1.0",
  tools: TOOLS,
  call: async (name, args, ctx) => { /* the existing if-chain or switch, unchanged */ },
  onUnknown: (name) => { throw new Error(`Unknown tool: ${name}`); }, // orson threw: keep the JSON-RPC error
  onError: (e) => { throw e; },                                          // same: thrown errors stay JSON-RPC errors
});
await serveStdio(server);
```

- `return { content: [{ type: "text", text: JSON.stringify(x) }] }` and `ok(x)` → `json(x, 0)` (compact, as now); `{ content: [{ type: "text", text }] }` → `text(t)`.
- **The `onUnknown` / `onError` throws matter.** The orchestrator's `callTool` expects a rejected promise on failure; the kit's defaults would turn failures into `isError` results, which `textFromResult` would hand back as if they were answers.
- **civitai-mcp** is the exception: it already answered handler failures with `isError` + message, so keep the default `onError` and only set `onUnknown` to throw. Its handlers return strings: `call: async (name, args) => text(await handlers[name](args))`.
- **narrator, character**: replace the `progressToken` / `extra.sendNotification` blocks with `const sendDelta = args.stream ? ctx.progress : undefined`. Same notification (progress 0, message = delta); a failed send no longer risks an unhandled rejection.
- **image, character-state**: replace the SIGINT/SIGTERM handlers with `serveStdio(server, { onShutdown: () => db.close() })`; the database now also closes when the parent dies.
- **character-state**: `isKnownTool` keyed off `ToolArgs`; the kit keys off the listed tools. Check the two name sets match.
- Zod parsing of `args` stays as it is, on orson's own zod. `args` is now `{}` rather than `undefined` when a call sends none, so an all-optional schema such as narrate_opening's now parses instead of throwing.
- Delete `src/servers/parent-watchdog.ts`. Leave `scripts/orson/process-cleanup.ts` alone (server file paths don't change).
- The orchestrator, `src/desktop/main.ts` and `src/training/node-abi-launcher.ts` may import `Client`, `StdioClientTransport` and `getDefaultEnvironment` from the kit and drop the SDK dependency, or keep their own SDK (client and servers talk across processes, so versions needn't match).
- The kit has no native code, so servers spawned under `ELECTRON_RUN_AS_NODE=1` + tsx load it as before.

### clipdrift

- `server.ts`: `const server = createToolServer({ name: "clipdrift-mcp", version: "0.1.0", capabilities: { resources: {} }, tools: allTools, call: (name, args) => handleToolCall(name, args) })`, then keep the two resource handlers (import `ListResourcesRequestSchema`, `ReadResourceRequestSchema` from the kit) and `server.onclose`. Return type stays `Server` (from the kit).
- `index.ts`: `runMain(async () => { await serveStdio(createClipDriftMCPServer()) })`. SIGINT/SIGTERM now close the server, so `onclose` runs `cleanupActiveUpscales()`, `cleanupActiveClipUpscales()` and `closeDatabase()`; before, `exit(0)` skipped them.
- `tools/upscale.tools.ts`, `tools/clip-upscale.tools.ts`: delete `ok`/`err`, use `json(data)` and `jsonError(message)` (both indent 2, as now).
- `utils/realesrgan.ts`: `export const log = createLogger("upscale", { time: true })`; same output.
- `handleToolCall`'s own unknown branch becomes unreachable; the kit answers `Unknown tool: <name>` (isError) with the same text.
- The MCP server runs under system Node via tsx (`npm run mcp-server`), so Electron 28's older Node doesn't matter. Don't import the kit into clipdrift's Electron main without checking.

### lemonsqueezy-mcp

- `src/server.ts`: `createToolServer({ name: "lemonsqueezy-mcp", version: "1.0.0", tools: allTools, call: (name, args) => handleToolCall(name, args) })`.
- `src/index.ts`: `runMain(async () => { await serveStdio(createLemonSqueezyMCPServer()) })`.
- The 20 `src/tools/*.tools.ts` files: delete `ok`/`err`; `ok(x)` → `json(x)`, `err(m)` → **`jsonError(m, 0)`** (compact: lemonsqueezy's errors had no indent). `Tool` type from the kit.
- A `file:` dependency means the package can't be published as is; it has a `bin`, so check that nobody installs it from a registry.

### job-searcher

- `src/mcp.ts`: `import { McpServer, ResourceTemplate, z, json, error, serveStdio } from "@btkulka/mcp-kit"`. Every schema in an `inputSchema` / `argsSchema` must be built with this `z`, including any imported from other modules (check `research.ts`, `digest.ts`, `enums.ts`); `digest.ts` and `research.ts` can keep zod 3 for their own parsing if their schemas never reach `registerTool`.
- `reply` → `json`; `failure()` keeps its `error: ` prefix and `recordError`, returning `error(`error: ${err.message}`)`.
- The `tool()` wrapper's `z.objectOutputType<Shape, z.ZodTypeAny>` is zod 3 API. Under zod 4 write `z.infer<z.ZodObject<Shape>>` (`z.ZodRawShape` still exists).
- `startMcp`: `const handle = await serveStdio(server, { exit: false, onShutdown: () => recordActivity({ kind: "session", name: "stop", ok: true }) })`, record the start as now, return `handle` (or both). `exit: false` matters: the CLI's `run()` wrapper closes the database after the action returns.
- `src/cli.ts` `mcp` command: replace the stdin/SIGINT/SIGTERM promise with `await handle.closed`.
- Tests: `const { client, close } = await connectInMemory(createMcpServer(db, …))` in `test/mcp.test.ts` and `test/activity.test.ts`.
- **What clients see changes slightly (zod 3 → 4).** tools/list `inputSchema` is generated by zod 4's `toJSONSchema` instead of zod-to-json-schema: no `additionalProperties: false` on the object, `.int()` adds `"maximum": 9007199254740991`, keys in a different order. Argument validation behaves the same (unknown keys are still stripped), but its messages read differently (`Too small: expected string to have >=1 characters` instead of `String must contain at least 1 character(s)`). Update any test that matches those texts.

### candybar-manager

- `src/mcp-server.ts`: `import { McpServer, z, json, runMain, serveStdio } from "@btkulka/mcp-kit"` (the CommonJS build loads under `tsconfig.mcp.json`'s `module: CommonJS`, `moduleResolution: Node`; the types resolve there too).
- `{ content: [{ type: 'text', text: JSON.stringify(x, null, 2) }] }` → `json(x)`. The error literals `JSON.stringify({ error: … })` without `isError` → `json({ error: … }, 0)`, to keep them non-errors as now (switching them to `jsonError` would be a behaviour change).
- `main()` + `.catch` → `runMain(async () => { await serveStdio(server) })`; same log text, `MCP server failed to start:`.
- Keep the app's own zod for anything outside `mcp-server.ts`. `server.tool(...)` is deprecated in the SDK but works; leave it (tool definitions are app code).

### nhi-dashboard

- `src/mcp.js` (CommonJS): `const { createToolServer, createLogger, error, runMain, serveStdio } = require('@btkulka/mcp-kit')`.
- `createServer(db)` →

  ```js
  const log = createLogger('nhi-dash mcp');
  return createToolServer({
    name: 'nhi-dash', version: pkg.version, instructions: INSTRUCTIONS, tools: tools(db),
    onError: (e, name) => {
      if (e instanceof api.ApiError) {
        const detail = Object.keys(e.errors || {}).length ? `\n${JSON.stringify(e.errors)}` : '';
        return error(`${e.message}${detail}`);
      }
      log(`${name} failed:`, e);
      return error(`Internal error: ${e.message}`);
    },
  });
  ```

  Tool entries are `{ name, description, inputSchema, run }`, so tools/list is unchanged. `run(args)` still gets `args` (now `{}`-defaulted by the kit) and ignores the second `ctx` argument.
- `main()` → `runMain(async () => { …; await serveStdio(server); log(`ready, ${tools(db).length} tools, db ${db.name || ':memory:'}`) })`. Keep `module.exports = { createServer, tools }` and the `require.main === module` guard.
- `tests/mcp.test.js` drives the real process over stdio and keeps working.

### starfall

Root `package.json`: add the kit, drop `@modelcontextprotocol/sdk` (only these two files use it).

- `tools/lore-mcp/index.mjs`:

  ```js
  const server = createToolServer({
    name: "starfall-lore", version: "0.1.0", tools: TOOLS,
    call: (name, args) => call(name, args),
    onUnknown: (name) => jsonError(`Unknown tool: ${name}`, 0),
    onError: (err) => jsonError(String(err?.message ?? err), 0),
  });
  await serveStdio(server, { onShutdown: closeTab });
  ```

  `ok` → `json(obj, 0)`. Delete `process.on("exit", () => void closeTab())`: an async close in an exit handler never finished; `onShutdown` awaits it.
- `tools/vn-mcp/index.mjs`:

  ```js
  const server = createToolServer({
    name: "starfall-vn", version: "0.1.0", tools: TOOLS,
    call: (name, args) => HANDLERS[name](args),
    format: (r) => (r && typeof r === "object" && "image" in r ? image(r.image, "image/png") : toResult(r)),
  });
  await serveStdio(server, { onShutdown: closeBrowser });
  ```

  Delete the SIGINT/SIGTERM loop. A handler returning `undefined` now sends `{"ok": true}` (it used to send a text block with no text, which the SDK rejects).

### toejam

Python (`toejam/mcp_server.py` on the Python MCP SDK, and the TouchDesigner MCP web server under `mcp/`). Not ported; nothing to do.

## Working on it

```sh
npm run build      # ESM (dist/esm) + CommonJS (dist/cjs)
npm run typecheck
npm test           # builds, then node --test; spawns real child processes for the stdio and watchdog tests
```

Tests run from this folder (they locate `dist/` from the working directory). No network beyond 127.0.0.1, no external binaries.
