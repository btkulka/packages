/**
 * The embedding seam.
 *
 * Retrieval has two modes, ported from orson:
 *  - **Claude mode (default here):** there is NO embedding endpoint. Writes store
 *    an all-zero vector so rows still persist, and reads bypass vector search
 *    entirely — `KnowledgeStore` returns obscurity-ordered rows and lets the
 *    consuming LLM's attention handle relevance across the (small) corpus.
 *  - **Real-embedding mode (e.g. Ollama nomic-embed-text):** the consumer injects
 *    an {@link Embedder} whose `embed()` returns a real 768-dim vector, and the
 *    store performs cosine vector search.
 *
 * The package ships with {@link claudeEmbedder} as the default so it works with
 * zero infrastructure. orson can pass its Ollama-backed embedder to get real ANN
 * ranking against the same store.
 */

/** nomic-embed-text dimensionality — the on-disk vector width every row uses. */
export const EMBED_DIM = 768;

/** Tag stamped on rows written with the Claude-mode zero-vector placeholder. */
export const CLAUDE_ZERO_VECTOR_TAG = "embed:claude-zero";

/**
 * Produces query/write vectors and declares whether they're real. When
 * `hasRealEmbeddings()` is false the store skips vector search and ranks by
 * obscurity instead.
 */
export interface Embedder {
  embed(text: string): Promise<number[]>;
  hasRealEmbeddings(): boolean;
}

/**
 * The default, infrastructure-free embedder: every vector is `EMBED_DIM` zeros
 * and `hasRealEmbeddings()` is false, so the store runs entirely in Claude mode.
 */
export const claudeEmbedder: Embedder = {
  async embed() {
    return new Array(EMBED_DIM).fill(0);
  },
  hasRealEmbeddings() {
    return false;
  },
};

/**
 * A real embedder backed by an Ollama daemon's `/api/embed` endpoint
 * (default model `nomic-embed-text`, 768-dim). Use this from a consumer that
 * wants ANN ranking; vectors are compatible with orson's existing store.
 */
export function ollamaEmbedder(opts: {
  url?: string;
  model?: string;
} = {}): Embedder {
  const url = opts.url ?? "http://localhost:11434";
  const model = opts.model ?? "nomic-embed-text";
  return {
    async embed(text: string): Promise<number[]> {
      const res = await fetch(`${url}/api/embed`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model, input: text }),
      });
      if (!res.ok) {
        throw new Error(`ollama embed failed: ${res.status} ${res.statusText}`);
      }
      const json = (await res.json()) as { embeddings?: number[][] };
      const vec = json.embeddings?.[0];
      if (!vec || vec.length !== EMBED_DIM) {
        throw new Error(
          `ollama embed returned ${vec?.length ?? 0} dims; expected ${EMBED_DIM}`,
        );
      }
      return vec;
    },
    hasRealEmbeddings() {
      return true;
    },
  };
}
