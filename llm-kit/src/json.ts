/**
 * Getting JSON (and clean prose) out of what a model actually writes: `<think>` blocks from
 * reasoning models, ```json fences, prose around the object, a reply truncated mid-array, raw
 * newlines and stray backslashes inside strings.
 *
 * Browser-safe: no node:* imports. Import it from "@btkulka/llm-kit/json" in a renderer.
 */

export type JsonKind = "object" | "array" | "any";

const THINK_BLOCK = /<think>[\s\S]*?<\/think>/gi;

/** Removes every closed `<think>…</think>` block (any case) and trims. An unclosed `<think>` is left alone. */
export function stripThinking(text: string): string {
  return text.replace(THINK_BLOCK, "").trim();
}

const FENCE = /```(?:json)?\s*([\s\S]*?)```/i;

/** The inside of the first ``` fenced block (with or without a `json` tag), trimmed; the trimmed text when there is none. */
export function stripCodeFences(text: string): string {
  const m = text.match(FENCE);
  return m ? m[1].trim() : text.trim();
}

export interface ThinkFilter {
  /** Feed the next streamed chunk; returns the part of it that is outside `<think>…</think>`. */
  push(chunk: string): string;
  /** End of stream: returns anything held back (a trailing "<thi" that never became a tag). */
  flush(): string;
}

/**
 * Streaming counterpart of {@link stripThinking}: passes through only text outside
 * `<think>…</think>`, so a reasoning model's chain of thought never reaches the screen. A tag split
 * across chunks ("<thi" + "nk>") is held back until it resolves. Tags match in any case.
 */
export function createThinkFilter(): ThinkFilter {
  let inThink = false;
  let held = "";
  return {
    push(chunk: string): string {
      let s = held + chunk;
      held = "";
      let out = "";
      for (;;) {
        const tag = inThink ? "</think>" : "<think>";
        const at = s.toLowerCase().indexOf(tag);
        if (at >= 0) {
          if (!inThink) out += s.slice(0, at);
          s = s.slice(at + tag.length);
          inThink = !inThink;
          continue;
        }
        const keep = partialTagSuffix(s, tag);
        if (!inThink) out += s.slice(0, s.length - keep);
        held = s.slice(s.length - keep);
        return out;
      }
    },
    flush(): string {
      const rest = inThink ? "" : held;
      held = "";
      return rest;
    },
  };
}

/** Length of the longest end of `s` that is the start of `tag` ("…<thi" against "<think>" → 4). */
function partialTagSuffix(s: string, tag: string): number {
  const lower = s.toLowerCase();
  for (let k = Math.min(tag.length - 1, s.length); k > 0; k--) {
    if (tag.startsWith(lower.slice(s.length - k))) return k;
  }
  return 0;
}

/**
 * Where the JSON value opening at `start` ('{' or '['), closes; -1 when it never does (a reply cut
 * off mid-value) or a bracket doesn't match. String-aware, so braces inside strings don't count.
 */
function closingIndex(text: string, start: number): number {
  const stack: string[] = [];
  let inStr = false;
  let esc = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === "{") stack.push("}");
    else if (ch === "[") stack.push("]");
    else if (ch === "}" || ch === "]") {
      if (stack.pop() !== ch) return -1;
      if (!stack.length) return i;
    }
  }
  return -1;
}

const openersFor = (kind: JsonKind): string => (kind === "object" ? "{" : kind === "array" ? "[" : "{[");

function parses(s: string): boolean {
  try {
    JSON.parse(s);
    return true;
  } catch {
    return false;
  }
}

function matchesKind(v: unknown, kind: JsonKind): boolean {
  if (kind === "array") return Array.isArray(v);
  if (kind === "object") return typeof v === "object" && v !== null && !Array.isArray(v);
  return true;
}

/**
 * The first complete JSON object (or array, or either) in mixed text, as a substring ready for
 * JSON.parse. Balanced and string-aware: nested objects work, a `}` inside a string doesn't end
 * one, and prose like "the {json} below" before the real object is skipped. Prefers the first
 * candidate that parses; when none parse, returns the first balanced one (so the caller's own
 * JSON.parse reports why). Null when there is no complete candidate at all.
 */
export function extractJson(text: string, kind: JsonKind = "object"): string | null {
  const openers = openersFor(kind);
  let firstBalanced: string | null = null;
  for (let i = 0; i < text.length; i++) {
    if (!openers.includes(text[i])) continue;
    const end = closingIndex(text, i);
    if (end < 0) continue;
    const candidate = text.slice(i, end + 1);
    if (parses(candidate)) return candidate;
    firstBalanced ??= candidate;
  }
  return firstBalanced;
}

/**
 * Every complete top-level JSON value of `kind` in the text, parsed, left to right. Salvages the
 * good items from a chatty, wrapped or truncated reply: `[{"a":1},{"b":2},{"c":` yields the
 * first two objects. A value that is balanced but doesn't parse is skipped, and the objects
 * inside it are still tried.
 */
export function extractJsonValues(text: string, kind: JsonKind = "object"): unknown[] {
  const openers = openersFor(kind);
  const out: unknown[] = [];
  for (let i = 0; i < text.length; i++) {
    if (!openers.includes(text[i])) continue;
    const end = closingIndex(text, i);
    if (end < 0) continue;
    try {
      out.push(JSON.parse(text.slice(i, end + 1)));
      i = end;
    } catch {
      /* not JSON; look inside it */
    }
  }
  return out;
}

const VALID_ESCAPE = new Set(['"', "\\", "/", "b", "f", "n", "r", "t", "u"]);
const CONTROL_ESCAPES: Record<string, string> = { "\n": "\\n", "\r": "\\r", "\t": "\\t", "\b": "\\b", "\f": "\\f" };

/**
 * Fixes the two things smaller models get wrong inside JSON strings: raw control characters
 * (a literal newline or tab) become escapes, and a lone backslash (`\d`, `C:\x`) becomes `\\`.
 * Outside strings, control characters other than whitespace become spaces. String-aware, so a
 * correct `\\` or `\"` is left as it is.
 */
export function repairJson(text: string): string {
  let out = "";
  let inStr = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    const code = ch.charCodeAt(0);
    if (!inStr) {
      if (ch === '"') inStr = true;
      out += code < 0x20 && ch !== "\n" && ch !== "\r" && ch !== "\t" ? " " : ch;
      continue;
    }
    if (ch === "\\") {
      const next = text[i + 1];
      if (next !== undefined && VALID_ESCAPE.has(next)) {
        out += ch + next;
        i++;
      } else out += "\\\\";
      continue;
    }
    if (ch === '"') inStr = false;
    if (code < 0x20) out += CONTROL_ESCAPES[ch] ?? `\\u${code.toString(16).padStart(4, "0")}`;
    else out += ch;
  }
  return out;
}

/**
 * Tolerantly parse a model reply as JSON of `kind` (an object unless told otherwise):
 * strips `<think>` blocks and ``` fences, takes the whole reply or the first complete value in
 * it, and retries once through {@link repairJson}. Throws the original SyntaxError when nothing
 * parses, or a SyntaxError saying no JSON `kind` was found.
 */
export function parseJsonLoose<T = unknown>(text: string, kind: JsonKind = "object"): T {
  const thoughtless = stripThinking(text);
  const fenced = stripCodeFences(thoughtless);
  const sources = fenced === thoughtless ? [fenced] : [fenced, thoughtless];
  let firstError: unknown;
  for (const repaired of [false, true]) {
    for (const src of sources) {
      const t = repaired ? repairJson(src) : src;
      try {
        const v = JSON.parse(t) as unknown;
        if (matchesKind(v, kind)) return v as T;
      } catch (e) {
        firstError ??= e;
      }
      const slice = extractJson(t, kind);
      if (slice !== null && parses(slice)) return JSON.parse(slice) as T;
    }
  }
  throw firstError ?? new SyntaxError(`No JSON ${kind === "any" ? "value" : kind} found in the model output`);
}
