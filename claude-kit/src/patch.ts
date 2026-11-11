import type { ChatItem, ChatPatch, ChatsPatch, ChatsState, ChatState, ChatStreamDelta } from "./types.js";

// A host's chats travel as changes, not whole (the host sends
// them, a screen applies them): a chat's rows as the ones that changed or came,
// its list as the chats that are new, a reply being written as what it grew by.

type Rows = Pick<ChatPatch, "items" | "upsert" | "count">;

/**
 * What took `sent` (the rows the screens have) to `now`: nothing when it's the
 * same array; else the rows that changed or came, when `now` is `sent` with its
 * oldest dropped, rows replaced in place and new ones at the end (a turn going
 * on); else all of them (a conversation read in again).
 */
export function diffItems(sent: ChatItem[], now: ChatItem[]): Rows {
  if (sent === now) return {};
  if (!now.length || !sent.length) return { items: now };
  const k = sent.findIndex((i) => i.id === now[0].id);
  if (k < 0) return { items: now };
  const kept = sent.length - k;
  if (now.length < kept) return { items: now };
  for (let j = 0; j < kept; j++) if (now[j].id !== sent[k + j].id) return { items: now };
  const was = new Set(sent.map((i) => i.id));
  for (let j = kept; j < now.length; j++) if (was.has(now[j].id)) return { items: now };
  const upsert = now.filter((it, j) => j >= kept || it !== sent[k + j]);
  return { upsert, count: now.length };
}

/** A chat with its change applied. Rows that didn't change keep their identity, so the panel draws only the ones that did. */
export function applyChat(prev: ChatState, p: ChatPatch): ChatState {
  const { items, upsert, count, ...rest } = p;
  if (items) return { ...rest, items };
  if (!upsert) return { ...rest, items: prev.items };
  let next = prev.items.slice();
  const at = new Map(next.map((it, i) => [it.id, i]));
  for (const it of upsert) {
    const i = at.get(it.id);
    if (i === undefined) {
      at.set(it.id, next.length);
      next.push(it);
    } else next[i] = it;
  }
  if (count !== undefined && next.length > count) next = next.slice(-count);
  return { ...rest, items: next };
}

/** The chats with a list change applied, or undefined when it names a chat this screen never had (read them all again). */
export function applyChats(prev: ChatsState | undefined, p: ChatsPatch): ChatsState | undefined {
  const have = new Map((prev?.chats ?? []).map((c) => [c.id, c]));
  for (const c of p.chats) have.set(c.id, c);
  const chats: ChatState[] = [];
  for (const id of p.ids) {
    const c = have.get(id);
    if (!c) return undefined;
    chats.push(c);
  }
  return { current: p.current, chats, models: p.models };
}

/** A reply being written, grown by a delta; undefined when the delta starts past what this screen has (it missed one). */
export function applyStream(prev: string | undefined, d: ChatStreamDelta): string | undefined {
  const have = prev ?? "";
  if (d.at > have.length) return undefined;
  return have.slice(0, d.at) + d.text;
}
