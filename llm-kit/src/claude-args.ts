/** The `claude -p` command line, from options. Only flags Ben's apps use; anything else goes in extraArgs. */

export type ClaudeOutputFormat = "text" | "json" | "stream-json";

export interface ClaudeArgsOptions {
  /**
   * The prompt as a positional argument, right after -p. Leave it out to send the prompt over
   * stdin, which has no length limit and no quoting concerns. (An argument prompt can't start
   * with "-".)
   */
  prompt?: string;
  /** Default "text". */
  outputFormat?: ClaudeOutputFormat;
  /** --verbose. Always on for stream-json, which requires it with -p. */
  verbose?: boolean;
  /** --include-partial-messages: token-by-token text deltas in stream-json. */
  includePartialMessages?: boolean;
  model?: string;
  /** --system-prompt: replaces Claude Code's own system prompt. */
  systemPrompt?: string;
  /** --disable-slash-commands */
  disableSlashCommands?: boolean;
  /** --no-session-persistence: don't save the conversation to disk. */
  noSessionPersistence?: boolean;
  /** Inserted after the flags above and before the tool flags. */
  extraArgs?: string[];
  /** --permission-mode (default, acceptEdits, plan, bypassPermissions…). */
  permissionMode?: string;
  /** --tools: the built-in tools available at all, sent comma-joined. [] disables every tool (--tools ""). */
  tools?: string[];
  /** --disallowedTools */
  disallowedTools?: string[];
  /** --allowedTools: rules that run without asking, e.g. "Bash(git *)". */
  allowedTools?: string[];
}

/**
 * Arguments for claude, in a fixed order:
 * `-p [prompt] --output-format F [--verbose] [--include-partial-messages] [--model M]
 * [--system-prompt S] [--disable-slash-commands] [--no-session-persistence] [...extraArgs]
 * [--permission-mode P] [--tools …] [--disallowedTools …] [--allowedTools …]`.
 * The tool lists take several values each, so they come last, where nothing can be mistaken for one of them.
 */
export function claudeArgs(o: ClaudeArgsOptions = {}): string[] {
  const format = o.outputFormat ?? "text";
  const args = ["-p"];
  if (o.prompt !== undefined) args.push(o.prompt);
  args.push("--output-format", format);
  if (format === "stream-json" || o.verbose) args.push("--verbose");
  if (o.includePartialMessages) args.push("--include-partial-messages");
  if (o.model) args.push("--model", o.model);
  if (o.systemPrompt) args.push("--system-prompt", o.systemPrompt);
  if (o.disableSlashCommands) args.push("--disable-slash-commands");
  if (o.noSessionPersistence) args.push("--no-session-persistence");
  if (o.extraArgs?.length) args.push(...o.extraArgs);
  if (o.permissionMode) args.push("--permission-mode", o.permissionMode);
  if (o.tools) args.push("--tools", o.tools.join(","));
  if (o.disallowedTools?.length) args.push("--disallowedTools", ...o.disallowedTools);
  if (o.allowedTools?.length) args.push("--allowedTools", ...o.allowedTools);
  return args;
}
