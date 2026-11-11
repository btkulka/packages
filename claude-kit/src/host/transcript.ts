import { existsSync, readdirSync } from "node:fs";
import { open } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

// A session's conversation as Claude Code kept it, read back from the end of
// its transcript in ~/.claude/projects/<encoded folder>/<session>.jsonl (or
// under CLAUDE_CONFIG_DIR when that's set).

const ROOT = () => join(process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude"), "projects");

/** A transcript entry, as a chat reads one back (items.ts's fromTranscript). */
export interface TranscriptEntry {
  type: string;
  subtype?: string;
  uuid: string;
  parentUuid?: string | null;
  isSidechain?: boolean;
  isMeta?: boolean;
  isCompactSummary?: boolean;
  message?: unknown;
  /** A message sent while Claude was on a turn comes as one of these ("queued_command"). */
  attachment?: { type?: string; prompt?: unknown; source_uuid?: string };
}

type Block = { type?: string; id?: string; tool_use_id?: string };
const blocksOf = (e: TranscriptEntry): Block[] => {
  const c = (e.message as { content?: unknown } | undefined)?.content;
  return Array.isArray(c) ? (c as Block[]) : [];
};
const messageId = (e: TranscriptEntry) => (e.type === "assistant" ? (e.message as { id?: unknown } | undefined)?.id : undefined);

const CHUNK = 1024 * 1024;
/** How far back a conversation is read at most; a line is often a screenshot's worth of base64. */
const MAX_BACK = 24 * 1024 * 1024;

/** Claude Code's folder name for a working folder: every character but a letter or digit as "-". */
const projectDir = (folder: string) => folder.replace(/[^a-zA-Z0-9]/g, "-");

/** Where a session's transcript is: its folder's project, or any project that has it (a long path's name is hashed). */
export function transcriptPath(sessionId: string, folder: string): string | undefined {
  const name = `${sessionId}.jsonl`;
  const guess = join(ROOT(), projectDir(folder), name);
  if (existsSync(guess)) return guess;
  try {
    for (const dir of readdirSync(ROOT())) {
      const p = join(ROOT(), dir, name);
      if (existsSync(p)) return p;
    }
  } catch {
    // No projects folder yet.
  }
  return undefined;
}

/**
 * A session's conversation as it last stood, read from the end of its
 * transcript only: back until `want` user and assistant entries are in (or
 * MAX_BACK bytes, or the start), then the chain from its newest entry back by
 * parentUuid, as Claude Code links them, in the file's order. Parallel tool
 * calls branch off that chain (each call its own line, each result under its
 * call) and messages sent mid-turn hang off it as queued commands, so those
 * join it, as the Agent SDK's getSessionMessages has them. Side chains and
 * meta entries are left out; a compaction shows as its boundary, where the
 * chain starts.
 */
export async function transcriptTail(sessionId: string, folder: string, want: number): Promise<TranscriptEntry[]> {
  const file = transcriptPath(sessionId, folder);
  if (!file) return [];
  const newestFirst: TranscriptEntry[] = [];
  let turns = 0;
  const take = (raw: Buffer) => {
    const s = raw.toString("utf8").trim();
    if (!s.startsWith("{")) return;
    try {
      const e = JSON.parse(s) as TranscriptEntry;
      if (typeof e.uuid !== "string") return;
      newestFirst.push(e);
      if ((e.type === "user" || e.type === "assistant") && !e.isSidechain) turns++;
    } catch {
      // A line cut off as it was written.
    }
  };
  const fh = await open(file, "r");
  try {
    const { size } = await fh.stat();
    let pos = size;
    // The line being read, oldest piece first, while it runs across chunks.
    let pending: Buffer[] = [];
    let done = false;
    while (pos > 0 && size - pos < MAX_BACK && !done) {
      const len = Math.min(CHUNK, pos);
      pos -= len;
      const buf = Buffer.alloc(len);
      await fh.read(buf, 0, len, pos);
      let end = len;
      for (let i = len - 1; i >= 0; i--) {
        if (buf[i] !== 10) continue;
        take(pending.length ? Buffer.concat([buf.subarray(i + 1, end), ...pending]) : buf.subarray(i + 1, end));
        pending = [];
        end = i;
        if (turns >= want) {
          done = true;
          break;
        }
      }
      if (!done) pending.unshift(buf.subarray(0, end));
    }
    if (!done && pos === 0 && pending.length) take(Buffer.concat(pending));
  } finally {
    await fh.close();
  }
  const byId = new Map(newestFirst.map((e) => [e.uuid, e]));
  const leaf = newestFirst.find((e) => (e.type === "user" || e.type === "assistant") && !e.isSidechain);
  const kept = new Set<string>();
  for (let e = leaf; e && !kept.has(e.uuid); e = e.parentUuid ? byId.get(e.parentUuid) : undefined) kept.add(e.uuid);
  const main = newestFirst.filter((e) => !e.isSidechain);
  // An assistant message's other lines (one per content block), then the results of every call they made.
  const messages = new Set(main.filter((e) => kept.has(e.uuid)).map(messageId).filter(Boolean));
  for (const e of main) if (messages.has(messageId(e))) kept.add(e.uuid);
  const calls = new Set(main.filter((e) => kept.has(e.uuid) && e.type === "assistant").flatMap((e) => blocksOf(e).flatMap((b) => (b.type?.endsWith("tool_use") && b.id ? [b.id] : []))));
  for (const e of main) if (e.type === "user" && blocksOf(e).some((b) => b.tool_use_id && calls.has(b.tool_use_id))) kept.add(e.uuid);
  // A message sent mid-turn, under any entry the conversation has (a few links up), as a message of the person's, unless it went in as one too.
  const queued = (e: TranscriptEntry) => {
    if (e.type !== "attachment" || e.attachment?.type !== "queued_command" || typeof e.attachment.prompt !== "string") return false;
    let p = e.parentUuid ? byId.get(e.parentUuid) : undefined;
    for (let hops = 0; p && hops < 20; hops++, p = p.parentUuid ? byId.get(p.parentUuid) : undefined) if (kept.has(p.uuid)) return !kept.has(e.attachment.source_uuid ?? "");
    return false;
  };
  const out: TranscriptEntry[] = [];
  for (let i = main.length - 1; i >= 0; i--) {
    const e = main[i];
    if (queued(e)) out.push({ type: "user", uuid: e.attachment!.source_uuid ?? e.uuid, message: { role: "user", content: e.attachment!.prompt } });
    else if (kept.has(e.uuid) && !e.isMeta && !e.isCompactSummary && (e.type === "user" || e.type === "assistant" || (e.type === "system" && e.subtype === "compact_boundary"))) out.push(e);
  }
  return out;
}
