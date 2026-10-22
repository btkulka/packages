/**
 * Output constraints for a local OpenAI-compatible server (llama.cpp, koboldcpp). Ported from
 * starfall's localLlm, with its two silent-failure traps fixed and tested:
 *
 *   - a `.gbnf` path is ALWAYS read as a file, never sent as grammar text (a path sent as grammar
 *     makes koboldcpp drop every constraint and say nothing);
 *   - the file is re-read when its mtime or size changes, so an edited grammar takes effect
 *     without restarting the server process.
 *
 * CRLF is normalized to LF (koboldcpp's GBNF parser drops a whole grammar that contains CR).
 */
import { readFileSync, statSync } from "node:fs";

export type ResolvedGrammar = { json: true } | { gbnf: string } | null;

interface CachedGrammar {
  path: string;
  mtimeMs: number;
  size: number;
  text: string;
}

const cache = new Map<string, CachedGrammar>();
let lastResolved: CachedGrammar | null = null;
const warned = new Set<string>();

/**
 * What to send for a grammar setting: `"json"` → OpenAI `response_format: json_object`; a string
 * ending in `.gbnf` → the file's contents as a GBNF `grammar`; any other non-empty string → an
 * inline GBNF grammar; empty/undefined → nothing. Never throws. A `.gbnf` path that can't be read
 * warns once per path (through `onWarning`, default console.error) and falls back to the last
 * good text for that path, or to no grammar at all.
 */
export function resolveGrammar(grammar: string | undefined, onWarning: (message: string) => void = console.error): ResolvedGrammar {
  if (!grammar) return null;
  if (grammar === "json") return { json: true };
  if (!/\.gbnf$/i.test(grammar)) return { gbnf: grammar };

  const cached = cache.get(grammar);
  let st: { mtimeMs: number; size: number; isFile(): boolean } | undefined;
  try {
    st = statSync(grammar, { throwIfNoEntry: false });
  } catch {
    st = undefined;
  }
  if (!st?.isFile()) {
    if (!warned.has(grammar)) {
      warned.add(grammar);
      onWarning(
        `[llm-kit] the grammar points at a .gbnf that cannot be read:\n` +
          `    ${grammar}\n` +
          `  Running UNCONSTRAINED: expect malformed JSON from the local model.\n` +
          `  Fix the path (it must be absolute and exist).`,
      );
    }
    return cached ? { gbnf: cached.text } : null;
  }
  if (!cached || cached.mtimeMs !== st.mtimeMs || cached.size !== st.size) {
    try {
      const text = readFileSync(grammar, "utf8").replace(/\r\n?/g, "\n");
      const entry = { path: grammar, mtimeMs: st.mtimeMs, size: st.size, text };
      cache.set(grammar, entry);
      lastResolved = entry;
      return { gbnf: text };
    } catch {
      return cached ? { gbnf: cached.text } : null;
    }
  }
  lastResolved = cached;
  return { gbnf: cached.text };
}

/**
 * The grammar file a request last used (or the one at `path`), for diagnostics: a batch of
 * recorded runs can carry the exact grammar that produced it. Null before any file grammar loads.
 */
export function grammarInfo(path?: string): { path: string; mtimeMs: number; size: number; chars: number } | null {
  const g = path === undefined ? lastResolved : (cache.get(path) ?? null);
  return g ? { path: g.path, mtimeMs: g.mtimeMs, size: g.size, chars: g.text.length } : null;
}
