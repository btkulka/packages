// @btkulka/llm-kit: the plumbing under Ben's LLM calls. Node entry; the JSON helpers are
// also at "@btkulka/llm-kit/json" with no node:* imports, for renderers.

export { LlmError, isLlmError, type LlmErrorKind, type LlmErrorDetails } from "./errors.js";
export { estimateTokens, type ChatMessage, type ChatRequest, type ChatResult, type ChatRole, type Usage } from "./types.js";

// JSON and prose out of model output
export {
  stripThinking,
  stripCodeFences,
  createThinkFilter,
  extractJson,
  extractJsonValues,
  repairJson,
  parseJsonLoose,
  type JsonKind,
  type ThinkFilter,
} from "./json.js";

// OpenAI-compatible servers (koboldcpp, llama.cpp, LM Studio)
export { openAiChat, type OpenAiConfig } from "./openai.js";
export { grammarInfo } from "./grammar.js";

// Ollama's native API
export {
  ollamaChat,
  ollamaEmbed,
  ollamaListModels,
  ollamaHasModel,
  type OllamaConfig,
  type OllamaChatRequest,
  type OllamaEmbedOptions,
  type OllamaModel,
} from "./ollama.js";

// Routing by model string
export { splitModelRef, LOCAL_MODEL_PREFIXES, type ModelRef } from "./models.js";

// The claude CLI
export { claudeArgs, type ClaudeArgsOptions, type ClaudeOutputFormat } from "./claude-args.js";
export { claudeEnv, INHERITED_SESSION_ENV_KEYS, type ClaudeEnvOptions } from "./claude-env.js";
export { resolveClaudeCommand, resolveCmdShim, type ClaudeCommand, type ResolveClaudeOptions } from "./claude-resolve.js";
export {
  parseStreamJsonLine,
  parseClaudeJsonOutput,
  createLineSplitter,
  contentText,
  isErrorResult,
  resultErrorMessage,
  type ClaudeStreamEvent,
  type ClaudeContentBlock,
} from "./claude-stream.js";
export {
  runClaude,
  launchClaude,
  probeClaude,
  type ClaudeRunOptions,
  type ClaudeRunResult,
  type ClaudeLaunchOptions,
  type ClaudeProcessOptions,
  type SpawnLike,
} from "./claude-run.js";
export { claudeCliChat, flattenForClaude, type ClaudeChatRequest, type ClaudeChatResult } from "./claude-chat.js";
