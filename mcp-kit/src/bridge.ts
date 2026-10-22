import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema, type Tool } from "@modelcontextprotocol/sdk/types.js";
import { createLogger, type Log } from "./log.js";
import { error, errorMessage, toResult } from "./results.js";
import { listTools } from "./tool-server.js";

// A stdio MCP server that relays to an app's Streamable HTTP endpoint (Benhäus's
// mcp/bridge.cjs). Claude Desktop and Claude Code start the bridge; the app may
// or may not be running. While it's down the bridge still lists tools (from a
// cache the app writes), and calling one starts the app first. If the app
// restarted since the bridge connected, a call reconnects and retries once.

/** Where the app's endpoint is, and the headers it needs (a bearer token). */
export interface Upstream {
  url: string;
  headers?: Record<string, string>;
}

export interface BridgeContext {
  /** Tell the client the tool list changed (sends notifications/tools/list_changed). */
  toolsChanged(): void;
}

/** A tool the bridge answers itself. `run` returns data (sent as JSON) or a tool result. */
export interface BridgeToolSpec {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
  run(args: Record<string, unknown>, ctx: BridgeContext): unknown;
  [key: string]: unknown;
}

export interface BridgeOptions {
  /** The bridge's own server name and version, as the client sees them. */
  name: string;
  version: string;
  instructions?: string;
  /** The endpoint if the app is up and healthy right now, else undefined. Called before each (re)connect. */
  locate(): Upstream | undefined | Promise<Upstream | undefined>;
  /** Start the app; resolve once it should be answering, throw with the reason if it didn't start. Omit to never start it. */
  start?(): Promise<void>;
  /** What to list while the app is down (tools/list entries, e.g. parsed from a cache file). Default: nothing but the local tools. */
  cachedTools?(): Array<{ name: string; [key: string]: unknown }>;
  /** Tools the bridge answers itself (e.g. launch_benhaus), listed first. An upstream tool with the same name is hidden. */
  localTools?: BridgeToolSpec[];
  /** Timeout for each relayed call. Default 300 000 ms (some tools take minutes). */
  callTimeoutMs?: number;
  /** The error text when start() returned but the endpoint still isn't answering. */
  notReadyMessage?: string;
  /** The bridge's client name toward the app. Default `<name>-bridge`. */
  clientName?: string;
  /** Default: stderr with `[<name>]`. */
  log?: Log;
}

export interface Bridge {
  /** The stdio-facing server: pass it to serveStdio. */
  server: Server;
  /** Sends notifications/tools/list_changed (errors ignored). */
  toolsChanged(): void;
  /** Closes the upstream connection and the server. */
  close(): Promise<void>;
}

export function createBridge(opts: BridgeOptions): Bridge {
  const log = opts.log ?? createLogger(opts.name);
  const local = opts.localTools ?? [];
  const localNames = new Set(local.map((t) => t.name));
  const timeout = opts.callTimeoutMs ?? 300_000;
  const notReady = opts.notReadyMessage ?? "The app is starting but its MCP endpoint isn't answering yet. Try again in a few seconds.";

  const server = new Server(
    { name: opts.name, version: opts.version },
    { capabilities: { tools: { listChanged: true } }, ...(opts.instructions ? { instructions: opts.instructions } : {}) },
  );
  const toolsChanged = () => void server.sendToolListChanged().catch(() => undefined);

  let client: Client | undefined;
  let connecting: Promise<Client | undefined> | undefined;

  async function upstream(): Promise<Client | undefined> {
    if (client) return client;
    if (connecting) return connecting;
    connecting = (async () => {
      const target = await opts.locate();
      if (!target) return undefined;
      const c = new Client({ name: opts.clientName ?? `${opts.name}-bridge`, version: opts.version });
      const t = new StreamableHTTPClientTransport(new URL(target.url), { requestInit: { headers: target.headers ?? {} } });
      await c.connect(t);
      c.onclose = () => {
        if (client === c) client = undefined;
      };
      client = c;
      return c;
    })()
      .catch((e) => {
        log(`couldn't reach the app: ${errorMessage(e)}`);
        return undefined;
      })
      .finally(() => {
        connecting = undefined;
      });
    return connecting;
  }

  async function ensureRunning(): Promise<Client | undefined> {
    const up = await upstream();
    if (up || !opts.start) return up;
    await opts.start();
    const started = await upstream();
    if (started) toolsChanged();
    return started;
  }

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    let tools: Tool[] | undefined;
    const up = await upstream();
    if (up) {
      try {
        tools = (await up.listTools()).tools;
      } catch (e) {
        log(`listTools failed: ${errorMessage(e)}`);
        client = undefined;
      }
    }
    tools ??= (opts.cachedTools?.() ?? []) as Tool[];
    return { tools: [...listTools(local), ...tools.filter((t) => !localNames.has(t.name))] };
  });

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const { name, arguments: args = {} } = req.params;
    const own = local.find((t) => t.name === name);
    try {
      if (own) return toResult(await own.run(args, { toolsChanged }));
      const up = await ensureRunning();
      if (!up) return error(notReady);
      try {
        return await up.callTool({ name, arguments: args }, undefined, { timeout });
      } catch (e) {
        // The app may have restarted since we connected: reconnect once.
        client = undefined;
        const again = await ensureRunning();
        if (!again) throw e;
        return await again.callTool({ name, arguments: args }, undefined, { timeout });
      }
    } catch (e) {
      return error(errorMessage(e));
    }
  });

  return {
    server,
    toolsChanged,
    async close() {
      await client?.close().catch(() => undefined);
      client = undefined;
      await server.close();
    },
  };
}
