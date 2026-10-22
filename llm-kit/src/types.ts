/** Shapes shared by every chat backend here (OpenAI-compatible, Ollama, the claude CLI). */

export type ChatRole = "system" | "user" | "assistant";

export interface ChatMessage {
  role: ChatRole;
  content: string;
}

/** Token counts for one call. Estimated (characters / 4) when the server doesn't report them. */
export interface Usage {
  in: number;
  out: number;
}

export interface ChatRequest {
  /** The model id the server knows. The app always passes it; nothing here has a default model. */
  model: string;
  /** System prompt. Goes in front of any system-role messages in `messages`. */
  system?: string;
  messages: ChatMessage[];
  temperature?: number;
  /** Cap on generated tokens (`max_tokens`, Ollama's `num_predict`). */
  maxTokens?: number;
  /** Cancels the call; the promise rejects with an `aborted` LlmError. */
  signal?: AbortSignal;
  /** Gives up after this long with a `timeout` LlmError. Covers the whole call, streamed body included. */
  timeoutMs?: number;
  /**
   * Extra attempts when the reply comes back empty (local models occasionally do). Each retry
   * raises the temperature by `retryTemperatureStep`. Default 0.
   */
  emptyRetries?: number;
  /** Default 0.15. */
  retryTemperatureStep?: number;
  /** Return "" instead of throwing an `empty` LlmError when the reply is still empty. Default false. */
  allowEmpty?: boolean;
}

export interface ChatResult {
  text: string;
  usage: Usage;
  /** The model the server says answered, when it says (koboldcpp reports the .gguf it actually loaded). */
  model?: string;
}

/** characters / 4, rounded up: the estimate used when a server omits token counts. */
export const estimateTokens = (chars: number): number => Math.ceil(chars / 4);
