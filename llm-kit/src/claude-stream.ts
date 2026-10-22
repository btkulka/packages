/**
 * The claude CLI's machine-readable output.
 *
 *   --output-format stream-json (with --verbose): one JSON event per line, as it happens:
 *     {type:"system", subtype:"init", session_id, model, tools, …}
 *     {type:"stream_event", event:{type:"content_block_delta", delta:{type:"text_delta", text}}}  (--include-partial-messages)
 *     {type:"assistant", message:{content:[{type:"text"|"tool_use", …}]}, parent_tool_use_id}
 *     {type:"user", message:{content:[{type:"tool_result", …}]}}
 *     {type:"result", subtype:"success"|"error_…", is_error, result, session_id, total_cost_usd, num_turns, duration_ms, usage, …}
 *   --output-format json: the `result` event alone (or, with --verbose, an array of every event).
 *
 * Shapes are loose on purpose: fields the CLI adds later pass through untouched.
 */

export interface ClaudeContentBlock {
  type: string;
  text?: string;
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
  tool_use_id?: string;
  content?: unknown;
  is_error?: boolean;
  [key: string]: unknown;
}

export interface ClaudeStreamEvent {
  type: string;
  subtype?: string;
  session_id?: string;
  /** Set on events from a subagent the session started. */
  parent_tool_use_id?: string | null;
  // system/init
  model?: string;
  tools?: string[];
  cwd?: string;
  permissionMode?: string;
  // assistant / user
  message?: { id?: string; role?: string; model?: string; content?: ClaudeContentBlock[] | string; usage?: Record<string, unknown>; [key: string]: unknown };
  // stream_event
  event?: { type: string; index?: number; delta?: { type?: string; text?: string; [key: string]: unknown }; [key: string]: unknown };
  // result
  is_error?: boolean;
  result?: string;
  total_cost_usd?: number;
  num_turns?: number;
  duration_ms?: number;
  duration_api_ms?: number;
  usage?: { input_tokens?: number; output_tokens?: number; [key: string]: unknown };
  errors?: string[];
  permission_denials?: Array<{ tool_name?: string; [key: string]: unknown }>;
  [key: string]: unknown;
}

/** One line of stream-json as an event; null for a blank line or anything that isn't a JSON object (stderr in the same log). */
export function parseStreamJsonLine(line: string): ClaudeStreamEvent | null {
  const s = line.trim();
  if (!s.startsWith("{")) return null;
  try {
    const v = JSON.parse(s) as unknown;
    return v && typeof v === "object" && typeof (v as { type?: unknown }).type === "string" ? (v as ClaudeStreamEvent) : null;
  } catch {
    return null;
  }
}

/**
 * Cuts a stream of text chunks into lines. A line split across chunks waits for its end;
 * `\r\n` and `\n` both end a line. Feed it decoded strings (setEncoding("utf8") on the stream, so
 * a multi-byte character split across chunks stays whole).
 */
export function createLineSplitter(onLine: (line: string) => void): { push(chunk: string): void; end(): void } {
  let buf = "";
  return {
    push(chunk: string) {
      buf += chunk;
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        onLine(buf.slice(0, nl).replace(/\r$/, ""));
        buf = buf.slice(nl + 1);
      }
    },
    end() {
      if (buf) onLine(buf.replace(/\r$/, ""));
      buf = "";
    },
  };
}

/** The text blocks of a message's content, joined. */
export function contentText(content: ClaudeContentBlock[] | string | undefined): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((b) => b?.type === "text" && typeof b.text === "string")
    .map((b) => b.text as string)
    .join("");
}

/** The `result` event from `--output-format json` stdout (a single object, or with --verbose an array of events). Null when there is none. */
export function parseClaudeJsonOutput(stdout: string): ClaudeStreamEvent | null {
  const s = stdout.trim();
  const tryParse = (t: string): unknown => {
    try {
      return JSON.parse(t);
    } catch {
      return undefined;
    }
  };
  let v = tryParse(s);
  // Anything printed before the JSON (a warning) — take the last line that parses.
  if (v === undefined) {
    for (const line of s.split(/\r?\n/).reverse()) {
      v = tryParse(line.trim());
      if (v !== undefined) break;
    }
  }
  const events = Array.isArray(v) ? (v as ClaudeStreamEvent[]) : v && typeof v === "object" ? [v as ClaudeStreamEvent] : [];
  return [...events].reverse().find((e) => e?.type === "result") ?? null;
}

/** Did a result event end in failure (is_error, or an `error_…` subtype such as error_max_turns)? */
export const isErrorResult = (r: ClaudeStreamEvent): boolean => r.is_error === true || (typeof r.subtype === "string" && r.subtype.startsWith("error"));

/** What went wrong in a failed result, as one message. */
export function resultErrorMessage(r: ClaudeStreamEvent): string {
  const parts = [r.result, ...(r.errors ?? [])].filter((x): x is string => typeof x === "string" && x.trim().length > 0);
  return parts.join("\n") || `claude ended with ${r.subtype ?? "an error"}`;
}
