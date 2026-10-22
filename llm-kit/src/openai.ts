/**
 * One chat completion against any OpenAI-compatible `/chat/completions` endpoint: koboldcpp,
 * llama.cpp's server, LM Studio, vLLM, Ollama's /v1. The app passes the base URL and model.
 */
import { promptChars, withEmptyRetries, withSystem } from "./chat-common.js";
import { resolveGrammar } from "./grammar.js";
import { requestJson, type FetchLike } from "./http.js";
import { LlmError } from "./errors.js";
import { estimateTokens, type ChatRequest, type ChatResult } from "./types.js";

export interface OpenAiConfig {
  /** Base URL including the API prefix, e.g. http://127.0.0.1:5001/v1. "/chat/completions" is appended. */
  baseUrl: string;
  /** Sent as a Bearer token. Most local servers ignore it. */
  apiKey?: string;
  /**
   * Output constraint: "json" sends `response_format: {type: "json_object"}`; a path ending in
   * `.gbnf` sends that file's contents as a GBNF `grammar` (llama.cpp, koboldcpp), re-read when it
   * changes; any other string is sent as an inline GBNF grammar. See resolveGrammar.
   */
  grammar?: string;
  /** Default timeout for calls that don't set their own. */
  timeoutMs?: number;
  /** Names the server in error messages. Default "LLM". */
  label?: string;
  /** Where grammar warnings go. Default console.error. */
  onWarning?: (message: string) => void;
  /** Stands in for global fetch (tests). */
  fetch?: FetchLike;
}

interface Completion {
  choices?: { message?: { content?: string | null } }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number };
  model?: string;
}

/**
 * Sends `system` + `messages` and returns the reply text, token usage (estimated when the server
 * omits it) and the model the server says it served. Throws an LlmError (`http`, `timeout`,
 * `aborted`, `unreachable`, `empty`).
 */
export async function openAiChat(cfg: OpenAiConfig, req: ChatRequest): Promise<ChatResult> {
  const label = cfg.label ?? "LLM";
  const url = `${cfg.baseUrl.replace(/\/+$/, "")}/chat/completions`;
  const messages = withSystem(req);
  const grammar = resolveGrammar(cfg.grammar, cfg.onWarning);
  return withEmptyRetries(req, label, async (temperature) => {
    const body: Record<string, unknown> = { model: req.model, messages };
    if (req.maxTokens !== undefined) body.max_tokens = req.maxTokens;
    if (temperature !== undefined) body.temperature = temperature;
    if (grammar && "json" in grammar) body.response_format = { type: "json_object" };
    else if (grammar) body.grammar = grammar.gbnf;
    const json = await requestJson<Completion>(url, {
      body,
      headers: cfg.apiKey ? { Authorization: `Bearer ${cfg.apiKey}` } : undefined,
      timeoutMs: req.timeoutMs ?? cfg.timeoutMs,
      signal: req.signal,
      label,
      fetch: cfg.fetch,
    });
    if (!json || typeof json !== "object") throw new LlmError("bad-response", `${label} sent an empty completion`);
    const text = json.choices?.[0]?.message?.content ?? "";
    return {
      text,
      usage: {
        in: json.usage?.prompt_tokens ?? estimateTokens(promptChars(messages)),
        out: json.usage?.completion_tokens ?? estimateTokens(text.length),
      },
      model: json.model,
    };
  });
}
