import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult,
  type ServerCapabilities,
  type ServerNotification,
  type ServerRequest,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";
import { checkArgs } from "./args.js";
import { error, errorMessage, toResult } from "./results.js";

export type RequestExtra = RequestHandlerExtra<ServerRequest, ServerNotification>;

/** What a handler gets besides its arguments. */
export interface ToolContext {
  /** The tool's name. */
  name: string;
  /** The SDK's request extra: abort signal, sendNotification, _meta, requestInfo… */
  extra: RequestExtra;
  /**
   * Set only when the caller asked for progress (sent a progressToken): sends a
   * `notifications/progress` with this message. `progress` defaults to 0, which
   * is what orson's streaming tools send with each text delta.
   */
  progress?: (message: string, progress?: number) => void;
}

/**
 * One tool: what tools/list shows (every field except `run`, passed through as
 * the app wrote it) plus, optionally, its handler.
 */
export interface ToolSpec {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
  /** Returns data (sent as JSON) or a ready tool result (sent as it is). */
  run?(args: Record<string, unknown>, ctx: ToolContext): unknown;
  [key: string]: unknown;
}

export interface ToolServerOptions {
  name: string;
  version: string;
  instructions?: string;
  /** Merged over `{ tools: {} }`, e.g. `{ resources: {} }` or `{ tools: { listChanged: true } }`. */
  capabilities?: ServerCapabilities;
  tools: ToolSpec[];
  /** The handler for tools without `run`, e.g. an app's existing switch or router. */
  call?(name: string, args: Record<string, unknown>, ctx: ToolContext): unknown;
  /** Check arguments against the tool's inputSchema first (`checkArgs`); a problem returns `error("<tool>: <problem>")`. Default false. */
  validate?: boolean;
  /** JSON indent for data results. Default 2. */
  indent?: number;
  /** Turn what a handler returned into a result. Default: `toResult(value, indent)`. */
  format?(value: unknown, tool: ToolSpec): CallToolResult;
  /** A call to a tool that isn't listed. Default: `error("Unknown tool: <name>")`. Throw to send a JSON-RPC error instead. */
  onUnknown?(name: string): CallToolResult;
  /** A handler threw. Default: `error(message)`. Throw (rethrow) to send a JSON-RPC error instead. */
  onError?(err: unknown, name: string): CallToolResult;
}

/** The tools/list entries: each spec without `run`. */
export function listTools(tools: Array<{ name: string; run?: unknown }>): Tool[] {
  return tools.map(({ run: _run, ...tool }) => tool as Tool);
}

/**
 * A low-level SDK `Server` with tools/list and tools/call wired to a tool table.
 * Add more handlers (resources, prompts) to the returned server as usual.
 */
export function createToolServer(opts: ToolServerOptions): Server {
  const byName = new Map<string, ToolSpec>();
  for (const t of opts.tools) {
    if (!t.run && !opts.call) throw new Error(`Tool ${t.name} has no run() and the server has no call().`);
    if (!byName.has(t.name)) byName.set(t.name, t);
  }
  const listed = listTools(opts.tools);
  const indent = opts.indent ?? 2;
  const format = opts.format ?? ((value: unknown) => toResult(value, indent));
  const onUnknown = opts.onUnknown ?? ((name: string) => error(`Unknown tool: ${name}`));
  const onError = opts.onError ?? ((err: unknown) => error(errorMessage(err)));

  const server = new Server(
    { name: opts.name, version: opts.version },
    { capabilities: { tools: {}, ...opts.capabilities }, ...(opts.instructions ? { instructions: opts.instructions } : {}) },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: listed }));

  server.setRequestHandler(CallToolRequestSchema, async (req, extra) => {
    const name = req.params.name;
    const spec = byName.get(name);
    if (!spec) return onUnknown(name);
    const args = (req.params.arguments ?? {}) as Record<string, unknown>;
    if (opts.validate) {
      const problem = checkArgs(spec.inputSchema, args);
      if (problem) return error(`${name}: ${problem}`);
    }
    const token = req.params._meta?.progressToken;
    const ctx: ToolContext = {
      name,
      extra,
      progress:
        token === undefined
          ? undefined
          : (message, progress = 0) => {
              extra.sendNotification({ method: "notifications/progress", params: { progressToken: token, progress, message } }).catch(() => undefined);
            },
    };
    try {
      const out = spec.run ? await spec.run(args, ctx) : await opts.call!(name, args, ctx);
      return format(out, spec);
    } catch (err) {
      return onError(err, name);
    }
  });

  return server;
}
