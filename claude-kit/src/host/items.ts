import type { ChatImage, ChatItem } from "../types.js";
import type { TranscriptEntry } from "./transcript.js";

// Claude Code's messages as a chat's rows: what's said, each tool call with
// its result, notes. Used for live turns and for a transcript read back.

export const MAX_ITEMS = 300;

export type Block = {
  type: string;
  id?: string;
  name?: string;
  input?: unknown;
  text?: string;
  tool_use_id?: string;
  content?: unknown;
  is_error?: boolean;
  source?: { type?: string; media_type?: string; data?: string };
};
export const blocks = (content: unknown): Block[] => (Array.isArray(content) ? (content as Block[]) : typeof content === "string" ? [{ type: "text", text: content }] : []);

/** Keeps an image block's bytes and names it for a row (host/images.ts's keepBlock). */
export type KeepBlock = (source: Block["source"]) => ChatImage | undefined;

/** The line a tool row shows: its command, file, pattern or address. */
export function detailOf(input: unknown, max = 300): string | undefined {
  const i = (input ?? {}) as Record<string, unknown>;
  const v = ["command", "file_path", "notebook_path", "path", "pattern", "url", "query", "description", "prompt", "plan"].map((k) => i[k]).find((x) => typeof x === "string" && x.trim());
  if (typeof v === "string") return v.length > max ? `${v.slice(0, max)}…` : v;
  const json = Object.keys(i).length ? JSON.stringify(i) : undefined;
  return json && json.length > max ? `${json.slice(0, max)}…` : json;
}

/** A text's first line that says something, on one line, cut at `max`. */
export function firstLine(text: string, max: number) {
  const line = text.split("\n").find((l) => l.trim())?.trim().replace(/\s+/g, " ") ?? "";
  return line.length > max ? `${line.slice(0, max)}…` : line;
}

/** A result's text; its images show as images. */
const textOf = (content: unknown) =>
  blocks(content)
    .map((b) => (b.type === "text" ? b.text : ""))
    .join("\n")
    .trim();

/** What the CLI puts in the transcript as the user that the person didn't type: command output, interrupts, reminders, messages from other sessions. */
const typed = (text?: string) => Boolean(text?.trim()) && !/^\s*(<[\w-]+(\s[^>]*)?>|\[Request interrupted|Caveat: )/.test(text!);

const isToolUse = (b: Block) => (b.type === "tool_use" || b.type === "server_tool_use" || b.type === "mcp_tool_use") && Boolean(b.id && b.name);

/** The context a chat started from a page tells Claude, wrapped in `tag`, ahead of the first message; and how to take it back off. */
export function contextWrapper(tag: string) {
  const strip = new RegExp(`^\\s*<${tag}>[\\s\\S]*?<\\/${tag}>\\s*`);
  return {
    wrap: (text: string, context?: string) => (context?.trim() ? `<${tag}>\n${context.trim()}\n</${tag}>\n\n${text}` : text),
    strip: (text: string) => text.replace(strip, ""),
  };
}

export function rowMaker(keep: KeepBlock, stripContext: (text: string) => string) {
  /** The images in a message or a tool's result, kept so the screens can draw them. */
  function imagesOf(content: unknown): ChatImage[] | undefined {
    const found = blocks(content)
      .filter((b) => b.type === "image")
      .map((b) => keep(b.source))
      .filter((i): i is ChatImage => Boolean(i));
    return found.length ? found : undefined;
  }

  function assistantItems(id: string, content: unknown, toolState: "running" | "done"): ChatItem[] {
    return blocks(content).flatMap((b, i): ChatItem[] => {
      if (b.type === "text" && b.text?.trim()) return [{ kind: "claude", id: `${id}:${i}`, text: b.text }];
      if (isToolUse(b)) return [{ kind: "tool", id: b.id!, name: b.name!, detail: detailOf(b.input), state: toolState }];
      return [];
    });
  }

  /** Tool results land on their tool rows. */
  function withResults(items: ChatItem[], content: unknown): ChatItem[] {
    const results = new Map(blocks(content).filter((b) => b.type === "tool_result" || b.type.endsWith("_tool_result")).map((b) => [b.tool_use_id, b]));
    if (!results.size) return items;
    return items.map((it) => {
      const r = it.kind === "tool" ? results.get(it.id) : undefined;
      if (!r || it.kind !== "tool") return it;
      const text = textOf(r.content);
      return { ...it, state: r.is_error ? "error" : "done", result: text.length > 800 ? `${text.slice(0, 800)}…` : text || undefined, images: imagesOf(r.content) };
    });
  }

  /** The conversation so far, from the end of the session's transcript (transcript.ts's transcriptTail), when it's shown or picked back up. */
  function fromTranscript(msgs: TranscriptEntry[]): ChatItem[] {
    let items: ChatItem[] = [];
    for (const m of msgs) {
      const content = (m.message as { content?: unknown } | undefined)?.content;
      if (m.type === "system") items.push({ kind: "note", id: m.uuid, text: "Earlier messages were compacted to make room." });
      else if (m.type === "assistant") items.push(...assistantItems(m.uuid, content, "done"));
      else if (m.type === "user") {
        const said = blocks(content)
          .filter((b) => b.type === "text")
          .map((b) => (b.text === undefined ? undefined : stripContext(b.text)))
          .filter(typed);
        const images = imagesOf(content);
        if (said.length || images) items.push({ kind: "you", id: m.uuid, text: said.join("\n"), images });
        items = withResults(items, content);
      }
    }
    return items.slice(-MAX_ITEMS);
  }

  return { imagesOf, assistantItems, withResults, fromTranscript };
}
