import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

// Tool results. Every app had its own ok()/err()/reply() for these; the wire
// shapes below are exactly what those produced.

/** A text result: `{ content: [{ type: "text", text }] }`. */
export function text(value: string): CallToolResult {
  return { content: [{ type: "text", text: value }] };
}

/**
 * `value` as JSON text. `indent` is JSON.stringify's third argument: 2 (the
 * default) is what most apps sent, 0 gives compact JSON (orson, starfall's lore
 * server). `undefined` becomes `null`, since JSON.stringify(undefined) is not text.
 */
export function json(value: unknown, indent = 2): CallToolResult {
  return text(JSON.stringify(value === undefined ? null : value, null, indent) ?? "null");
}

/** An error result the model can read: `{ isError: true, content: [{ type: "text", text: message }] }`. */
export function error(message: string): CallToolResult {
  return { isError: true, content: [{ type: "text", text: message }] };
}

/** An error result whose text is `{"error": message}` (clipdrift: indent 2, lemonsqueezy and starfall lore: indent 0). */
export function jsonError(message: string, indent = 2): CallToolResult {
  return { isError: true, content: [{ type: "text", text: JSON.stringify({ error: message }, null, indent) }] };
}

/** An image block (base64 `data`), followed by a text block when `caption` is given. */
export function image(data: string, mimeType: string, caption?: string): CallToolResult {
  return {
    content: [{ type: "image", data, mimeType }, ...(caption ? [{ type: "text" as const, text: caption }] : [])],
  };
}

/** `e.message` for an Error, else `String(e)`. */
export function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

const RESULT_KEYS = new Set(["content", "isError", "structuredContent", "_meta"]);

/**
 * True when `value` is already a tool result: a plain object whose only keys are
 * content / isError / structuredContent / _meta, with `content` an array of
 * blocks that each have a string `type`. Handlers can return these as they are.
 */
export function isToolResult(value: unknown): value is CallToolResult {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  if (!Array.isArray(v.content)) return false;
  if (!Object.keys(v).every((k) => RESULT_KEYS.has(k))) return false;
  return v.content.every((b) => !!b && typeof b === "object" && typeof (b as { type?: unknown }).type === "string");
}

/**
 * What a tool handler returned, as a result: a tool result passes through,
 * `undefined` becomes `{ "ok": true }` (Benhäus's rule), anything else is JSON.
 */
export function toResult(value: unknown, indent = 2): CallToolResult {
  if (isToolResult(value)) return value;
  return json(value === undefined ? { ok: true } : value, indent);
}
