/**
 * Ollama's native API: /api/chat (whole or streamed), /api/embed and /api/tags. Native rather
 * than Ollama's OpenAI endpoint because only the native one takes per-call `options` such as
 * num_ctx and num_gpu. The app passes the daemon URL and the model names.
 */
import { promptChars, withEmptyRetries, withSystem } from "./chat-common.js";
import { LlmError } from "./errors.js";
import { readLines, request, requestJson, type FetchLike } from "./http.js";
import { createThinkFilter } from "./json.js";
import { estimateTokens, type ChatRequest, type ChatResult } from "./types.js";

export interface OllamaConfig {
  /** The daemon, e.g. http://localhost:11434 (no /api). */
  baseUrl: string;
  /** Default timeout for calls that don't set their own. None by default: local generations can be slow. */
  timeoutMs?: number;
  /** Names the server in error messages. Default "Ollama". */
  label?: string;
  /** Stands in for global fetch (tests). */
  fetch?: FetchLike;
}

export interface OllamaChatRequest extends ChatRequest {
  /** Ollama `options`, passed through (num_ctx, num_gpu, top_p, …). `temperature` and `maxTokens` are set on top. */
  options?: Record<string, unknown>;
  /**
   * Streams the reply: called with each piece of text as it arrives, skipping `<think>…</think>`
   * so a reasoning model's chain of thought never reaches the screen. The returned text is the
   * whole reply, think blocks included (strip them with stripThinking).
   */
  onDelta?: (text: string) => void;
}

interface ChatFrame {
  message?: { content?: string };
  model?: string;
  done?: boolean;
  error?: string;
  prompt_eval_count?: number;
  eval_count?: number;
}

const base = (cfg: OllamaConfig) => cfg.baseUrl.replace(/\/+$/, "");

/**
 * One chat turn. Whole by default; streamed when `onDelta` is given. Returns the trimmed reply,
 * usage from Ollama's eval counts, and the model that answered. Throws an LlmError (`http`,
 * `timeout`, `aborted`, `unreachable`, `empty`, or `bad-response` for an error frame mid-stream).
 */
export async function ollamaChat(cfg: OllamaConfig, req: OllamaChatRequest): Promise<ChatResult> {
  const label = cfg.label ?? "Ollama";
  const url = `${base(cfg)}/api/chat`;
  const messages = withSystem(req);
  const stream = typeof req.onDelta === "function";
  return withEmptyRetries(req, label, async (temperature) => {
    const options: Record<string, unknown> = { ...req.options };
    if (temperature !== undefined) options.temperature = temperature;
    if (req.maxTokens !== undefined) options.num_predict = req.maxTokens;
    const body = { model: req.model, messages, stream, options };
    const common = { body, timeoutMs: req.timeoutMs ?? cfg.timeoutMs, signal: req.signal, label, fetch: cfg.fetch };

    let text = "";
    let last: ChatFrame = {};
    if (!stream) {
      last = await requestJson<ChatFrame>(url, common);
      if (last.error) throw new LlmError("bad-response", `${label}: ${last.error}`);
      text = last.message?.content ?? "";
    } else {
      const call = await request(url, common);
      const filter = createThinkFilter();
      await readLines(call, (line) => {
        let frame: ChatFrame;
        try {
          frame = JSON.parse(line) as ChatFrame;
        } catch {
          return;
        }
        if (frame.error) throw new LlmError("bad-response", `${label}: ${frame.error}`);
        const piece = frame.message?.content;
        if (piece) {
          text += piece;
          const visible = filter.push(piece);
          if (visible) req.onDelta!(visible);
        }
        if (frame.done) last = frame;
      });
      const rest = filter.flush();
      if (rest) req.onDelta!(rest);
    }
    text = text.trim();
    return {
      text,
      usage: {
        in: last.prompt_eval_count ?? estimateTokens(promptChars(messages)),
        out: last.eval_count ?? estimateTokens(text.length),
      },
      model: last.model,
    };
  });
}

export interface OllamaEmbedOptions {
  model: string;
  /** Throw a `bad-response` LlmError unless every vector has this many dimensions. */
  dims?: number;
  signal?: AbortSignal;
  timeoutMs?: number;
}

/**
 * Embeds one text (→ one vector) or several (→ one vector each) through /api/embed. Ollama
 * returns these L2-normalized; cosine ranking is the same as the older /api/embeddings.
 */
export async function ollamaEmbed(cfg: OllamaConfig, input: string, opts: OllamaEmbedOptions): Promise<number[]>;
export async function ollamaEmbed(cfg: OllamaConfig, input: string[], opts: OllamaEmbedOptions): Promise<number[][]>;
export async function ollamaEmbed(cfg: OllamaConfig, input: string | string[], opts: OllamaEmbedOptions): Promise<number[] | number[][]> {
  const label = cfg.label ?? "Ollama";
  const json = await requestJson<{ embeddings?: number[][]; error?: string }>(`${base(cfg)}/api/embed`, {
    body: { model: opts.model, input },
    timeoutMs: opts.timeoutMs ?? cfg.timeoutMs,
    signal: opts.signal,
    label: `${label} embed`,
    fetch: cfg.fetch,
  });
  const vectors = json.embeddings ?? [];
  const want = Array.isArray(input) ? input.length : 1;
  if (vectors.length !== want || vectors.some((v) => !Array.isArray(v) || !v.length)) {
    throw new LlmError("bad-response", `${label} returned ${vectors.length} embedding(s) for ${want} input(s)${json.error ? `: ${json.error}` : ""}`);
  }
  if (opts.dims !== undefined) {
    const bad = vectors.find((v) => v.length !== opts.dims);
    if (bad) throw new LlmError("bad-response", `${label} embed returned ${bad.length} dims from "${opts.model}"; expected ${opts.dims}`);
  }
  return Array.isArray(input) ? vectors : vectors[0];
}

/** An installed model, as /api/tags lists it. */
export interface OllamaModel {
  name: string;
  digest: string;
  sizeBytes: number;
  modifiedAt: string | null;
  family: string | null;
  parameterSize: string | null;
  quantization: string | null;
}

interface RawTag {
  name?: string;
  model?: string;
  modified_at?: string;
  size?: number;
  digest?: string;
  details?: { family?: string; parameter_size?: string; quantization_level?: string };
}

/** The installed models (/api/tags). Throws an LlmError when the daemon is down or answers badly. */
export async function ollamaListModels(cfg: OllamaConfig, opts: { signal?: AbortSignal; timeoutMs?: number } = {}): Promise<OllamaModel[]> {
  const json = await requestJson<{ models?: RawTag[] }>(`${base(cfg)}/api/tags`, {
    timeoutMs: opts.timeoutMs ?? cfg.timeoutMs,
    signal: opts.signal,
    label: `${cfg.label ?? "Ollama"} /api/tags`,
    fetch: cfg.fetch,
  });
  return (Array.isArray(json.models) ? json.models : []).map((t) => ({
    name: t.name ?? t.model ?? "(unknown)",
    digest: t.digest ?? "",
    sizeBytes: typeof t.size === "number" ? t.size : 0,
    modifiedAt: t.modified_at ?? null,
    family: t.details?.family ?? null,
    parameterSize: t.details?.parameter_size ?? null,
    quantization: t.details?.quantization_level ?? null,
  }));
}

/**
 * Whether `wanted` is among the installed model names, the way Ollama resolves it: an exact
 * match, or for an untagged name, its `:latest`. ("qwen3" matches "qwen3:latest", not "qwen3:8b".)
 */
export function ollamaHasModel(installed: readonly string[], wanted: string): boolean {
  if (installed.includes(wanted)) return true;
  return !wanted.includes(":") && installed.includes(`${wanted}:latest`);
}
