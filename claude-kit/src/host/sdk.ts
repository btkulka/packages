// The parts of @anthropic-ai/claude-agent-sdk the host uses, as loose shapes.
// The app passes its own copy of the SDK in (it carries a ~280 MB Claude Code
// binary per platform, so the package never installs one), and the real
// module fits these.

/** A message the person sends: text, or content blocks (images then text). */
export type Said = string | Array<Record<string, unknown>>;

export interface SdkUserMessage {
  type: "user";
  message: { role: "user"; content: Said };
  parent_tool_use_id: null;
}

/** Any message a session sends back; the host reads the fields it knows. */
export interface SdkMessage {
  type: string;
  subtype?: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  [k: string]: any;
}

export interface PermissionResultLike {
  behavior: "allow" | "deny";
  message?: string;
  updatedInput?: Record<string, unknown>;
  updatedPermissions?: unknown[];
}

export interface CanUseToolOptions {
  signal: AbortSignal;
  toolUseID: string;
  title?: string;
  description?: string;
  decisionReason?: string;
  suggestions?: unknown[];
  suppressAlwaysAllowRule?: boolean;
}

export type CanUseToolLike = (tool: string, input: Record<string, unknown>, o: CanUseToolOptions) => Promise<PermissionResultLike>;

/** A slash command as the SDK lists it (supportedCommands(), the commands_changed message). */
export interface SlashCommandLike {
  name: string;
  description: string;
  argumentHint: string;
  aliases?: string[];
  /** Claude Code's own: when a row like it shares its name, /name runs this one. */
  builtin?: boolean;
}

export interface QueryLike extends AsyncIterable<SdkMessage> {
  interrupt(): Promise<void>;
  close(): void;
  setPermissionMode(mode: string): Promise<void>;
  setModel(model?: string): Promise<void>;
  initializationResult(): Promise<{ models: { value: string; displayName: string }[]; commands?: SlashCommandLike[] }>;
  /** The slash commands the session takes, as it last said (older SDKs: absent). */
  supportedCommands?(): Promise<SlashCommandLike[]>;
  /** An MCP Apps ui:// page from a server the session connected (newer SDKs). */
  readMcpResource?(serverName: string, uri: string): Promise<{ contents: { uri: string; mimeType?: string; text?: string; blob?: string; _meta?: Record<string, unknown> }[] }>;
}

export interface SessionInfoLike {
  sessionId: string;
  cwd?: string;
  customTitle?: string;
  summary?: string;
  firstPrompt?: string;
  lastModified: number | string | Date;
  gitBranch?: string;
}

/** What `await import("@anthropic-ai/claude-agent-sdk")` gives. Methods, so the real module's stricter signatures fit. */
export interface AgentSdk {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  query(params: { prompt: AsyncIterable<SdkUserMessage>; options?: any }): QueryLike;
  listSessions(o?: { dir?: string }): Promise<SessionInfoLike[]>;
  getSessionInfo(sessionId: string): Promise<SessionInfoLike | undefined>;
  /** An in-process MCP server for a session's options.mcpServers (the block tool's). */
  createSdkMcpServer?(o: { name: string; version?: string; tools?: unknown[]; alwaysLoad?: boolean }): unknown;
  /** One tool for it: a zod shape for its arguments, and its handler. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  tool?(name: string, description: string, shape: any, handler: (args: any, extra: unknown) => Promise<ToolResultLike>, extras?: Record<string, unknown>): unknown;
}

/** What an in-process tool's handler returns. */
export interface ToolResultLike {
  content: { type: "text"; text: string }[];
  isError?: boolean;
}
