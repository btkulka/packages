// @btkulka/mcp-kit: the plumbing behind Ben's MCP servers. Tool
// definitions stay in the apps; this is how they get served.

export { checkArgs } from "./args.js";
export { createBridge, type Bridge, type BridgeContext, type BridgeOptions, type BridgeToolSpec, type Upstream } from "./bridge.js";
export { sameToken, serveHttp, type HttpHandle, type HttpOptions } from "./http.js";
export { createLogger, type Log, type LoggerOptions } from "./log.js";
export { error, errorMessage, image, isToolResult, json, jsonError, text, toResult } from "./results.js";
export { runMain, serveStdio, type Connectable, type StdioHandle, type StdioOptions } from "./stdio.js";
export { connectInMemory } from "./testing.js";
export { createToolServer, listTools, type RequestExtra, type ToolContext, type ToolServerOptions, type ToolSpec } from "./tool-server.js";
export { installParentWatchdog, pidAlive, type WatchdogOptions } from "./watchdog.js";

// One SDK and one zod for every app. Import these from here, not from the apps'
// own copies: the SDK converts and parses zod schemas with its own zod, so a
// schema built with a second zod copy is a schema from a different library.
export { z } from "zod";
export { Server } from "@modelcontextprotocol/sdk/server/index.js";
export { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
export { Client } from "@modelcontextprotocol/sdk/client/index.js";
export { StdioClientTransport, getDefaultEnvironment } from "@modelcontextprotocol/sdk/client/stdio.js";
export {
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
  type CallToolResult,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";
