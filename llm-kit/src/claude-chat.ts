/**
 * The claude CLI as a chat backend with the same request shape as ollamaChat and openAiChat, so
 * an app can switch providers per call (orson's ORSON_LLM_PROVIDER=claude runs on Ben's Claude
 * subscription instead of a local model).
 */
import { runClaude, type ClaudeProcessOptions } from "./claude-run.js";
import type { ClaudeArgsOptions } from "./claude-args.js";
import { estimateTokens, type ChatMessage, type ChatRequest, type ChatResult } from "./types.js";

/**
 * A chat history as one claude prompt. System messages (and `system`) are joined with blank
 * lines into the system prompt. The last message is the current turn; anything before it is
 * written out as "User: …" / "Assistant: …" under "=== Prior conversation ===".
 */
export function flattenForClaude(messages: ChatMessage[], system?: string): { systemPrompt: string; prompt: string } {
  const systems = system ? [system] : [];
  const turns: ChatMessage[] = [];
  for (const m of messages) {
    if (m.role === "system") systems.push(m.content);
    else turns.push(m);
  }
  const systemPrompt = systems.join("\n\n");
  if (!turns.length) return { systemPrompt, prompt: "" };
  const last = turns[turns.length - 1];
  const prior = turns.slice(0, -1);
  const priorBlock = prior.length
    ? `=== Prior conversation ===\n${prior.map((m) => (m.role === "assistant" ? `Assistant: ${m.content}` : `User: ${m.content}`)).join("\n\n")}\n\n=== Current turn ===\n`
    : "";
  return { systemPrompt, prompt: `${priorBlock}${last.content}` };
}

export interface ClaudeChatRequest
  extends Omit<ChatRequest, "model" | "emptyRetries" | "retryTemperatureStep">,
    ClaudeProcessOptions,
    Pick<ClaudeArgsOptions, "permissionMode" | "allowedTools" | "disallowedTools" | "extraArgs"> {
  /** Claude model or alias ("sonnet"). The CLI's default when left out. */
  model?: string;
  /** Streams the reply's text as it's written (stream-json with partial messages). */
  onDelta?: (text: string) => void;
  /** Built-in tools. Default [] (none): a chat turn, not an agent. */
  tools?: string[];
  /** Default true. */
  disableSlashCommands?: boolean;
  /** Default true: chat turns don't pile up in ~/.claude/projects. */
  noSessionPersistence?: boolean;
}

export interface ClaudeChatResult extends ChatResult {
  costUsd?: number;
  sessionId?: string;
}

/**
 * One chat turn through `claude -p`, prompt over stdin. `temperature` and `maxTokens` are
 * accepted and ignored (the CLI has neither). Rejects like runClaude.
 */
export async function claudeCliChat(req: ClaudeChatRequest): Promise<ClaudeChatResult> {
  const { systemPrompt, prompt } = flattenForClaude(req.messages, req.system);
  const streaming = typeof req.onDelta === "function";
  const r = await runClaude({
    bin: req.bin,
    binEnvVar: req.binEnvVar,
    cwd: req.cwd,
    env: req.env,
    keepSessionEnv: req.keepSessionEnv,
    spawn: req.spawn,
    prompt,
    outputFormat: streaming ? "stream-json" : "json",
    includePartialMessages: streaming,
    onText: req.onDelta,
    model: req.model,
    systemPrompt: systemPrompt || undefined,
    tools: req.tools ?? [],
    disableSlashCommands: req.disableSlashCommands ?? true,
    noSessionPersistence: req.noSessionPersistence ?? true,
    permissionMode: req.permissionMode,
    allowedTools: req.allowedTools,
    disallowedTools: req.disallowedTools,
    extraArgs: req.extraArgs,
    timeoutMs: req.timeoutMs,
    signal: req.signal,
    allowEmpty: req.allowEmpty,
  });
  const u = r.result?.usage;
  return {
    text: r.text,
    usage: {
      in: typeof u?.input_tokens === "number" ? u.input_tokens : estimateTokens(systemPrompt.length + prompt.length),
      out: typeof u?.output_tokens === "number" ? u.output_tokens : estimateTokens(r.text.length),
    },
    model: req.model,
    costUsd: r.costUsd,
    sessionId: r.sessionId,
  };
}
