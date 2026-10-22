/**
 * JSON stored in TEXT columns. Reading never throws: a missing, empty or malformed value
 * gives the fallback, because one bad row must not take down a list of thousands. Writing is
 * plain `JSON.stringify`.
 */

function textOf(value: unknown): string | undefined {
  if (value === null || value === undefined) return undefined;
  const text = typeof value === "string" ? value : String(value);
  return text.trim() === "" ? undefined : text;
}

/**
 * Parse a JSON column. `null`/`undefined`/`""`, malformed JSON and a stored JSON `null` all
 * give `fallback`. The type is trusted, not checked; use `parseJsonArray`/`parseJsonObject`
 * when the shape matters.
 */
export function parseJson<T>(value: unknown, fallback: T): T {
  const text = textOf(value);
  if (text === undefined) return fallback;
  try {
    const parsed: unknown = JSON.parse(text);
    return parsed === null ? fallback : (parsed as T);
  } catch {
    return fallback;
  }
}

/** Parse a JSON array column. Anything that isn't an array (missing, malformed, an object) gives `fallback`. */
export function parseJsonArray<T = unknown>(value: unknown, fallback: T[] = []): T[] {
  const parsed = parseJson<unknown>(value, undefined);
  return Array.isArray(parsed) ? (parsed as T[]) : fallback;
}

/** Parse a JSON object column. Anything that isn't a plain object (missing, malformed, an array, a number) gives `fallback`. */
export function parseJsonObject<T extends object = Record<string, unknown>>(value: unknown, fallback: T): T {
  const parsed = parseJson<unknown>(value, undefined);
  return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? (parsed as T) : fallback;
}
