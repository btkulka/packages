/**
 * Routing by model string: "ollama:rocinante-12b" names a local model, "claude-haiku-4-5" names
 * Claude. The prefix picks the backend; the rest is the id that backend knows. Only a known
 * prefix is stripped, so an Ollama tag like "qwen3:8b" survives intact.
 */

/** The prefixes starfall's config uses for a locally served model. */
export const LOCAL_MODEL_PREFIXES: readonly string[] = ["ollama", "local", "llama", "kobold"];

export interface ModelRef {
  /** The routing prefix ("ollama"), or null when the string has none of the known ones. */
  prefix: string | null;
  /** The model id without the prefix. */
  model: string;
}

/** "ollama:qwen3:8b" → { prefix: "ollama", model: "qwen3:8b" }; "qwen3:8b" → { prefix: null, model: "qwen3:8b" }. */
export function splitModelRef(ref: string, prefixes: readonly string[] = LOCAL_MODEL_PREFIXES): ModelRef {
  const i = ref.indexOf(":");
  if (i > 0) {
    const prefix = ref.slice(0, i);
    if (prefixes.includes(prefix)) return { prefix, model: ref.slice(i + 1) };
  }
  return { prefix: null, model: ref };
}
