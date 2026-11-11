// The chat's shapes, shared by the host (Node), the transports and the screens.
// No Node and no DOM here: every entry point imports these.

/**
 * How Claude asks before acting: default asks before edits and commands,
 * acceptEdits makes edits without asking, auto lets a classifier decide (and
 * asks when it can't), plan only reads and plans, bypassPermissions never asks,
 * dontAsk never asks and refuses what isn't already allowed.
 */
export type ClaudeMode = "default" | "acceptEdits" | "auto" | "plan" | "bypassPermissions" | "dontAsk";

/** An image in a conversation, kept by the host under its id (host/images.ts). */
export interface ChatImage {
  /** Its hash and extension: what image() and saveImage() take. */
  id: string;
  type: string;
  /** Its file name, when it came with one. */
  name?: string;
}

/** An image to send with a message: prepared by the screen (base64), or a file on the host's machine. */
export type NewChatImage = { data: string; type: string; name?: string } | { path: string; name?: string };

/** A row of a conversation. */
export type ChatItem =
  | { kind: "you"; id: string; text: string; images?: ChatImage[] }
  | { kind: "claude"; id: string; text: string }
  | { kind: "tool"; id: string; name: string; detail?: string; state: "running" | "done" | "error"; result?: string; images?: ChatImage[] }
  | { kind: "note"; id: string; text: string; error?: boolean };

/** Something Claude wants to do that its mode doesn't allow by itself, waiting for an answer. */
export interface ChatAsk {
  id: string;
  tool: string;
  /** "Claude wants to run npm run check". */
  title: string;
  sub?: string;
  /** The command, file or plan. */
  detail?: string;
  /** Claude Code offers a rule so it won't ask again this session. */
  canAlways: boolean;
}

/** A chat: its own standing Claude Code session that the host keeps. */
export interface ChatState {
  id: string;
  /** Its chip: the name it was given, or its first message's first line ("New chat" until then). */
  title: string;
  /** What it was started from, when that wasn't the chat itself: the page asked about. */
  about?: string;
  /** off: not started (it starts when a message is sent, or as one is typed); ready: waiting; working: on a turn. */
  status: "off" | "starting" | "ready" | "working" | "error";
  sessionId?: string;
  /** Where it works. */
  folder: string;
  /** The model it was asked to run on: an alias or id, or "" for Claude Code's default. */
  pickedModel: string;
  /** The model the last turn ran on, as Claude Code names it. */
  model?: string;
  mode: ClaudeMode;
  items: ChatItem[];
  asks: ChatAsk[];
  error?: string;
  /** What the turn is doing besides writing ("Retrying, attempt 2 of 10"). */
  activity?: string;
}

/** Every chat, in the order of their chips. */
export interface ChatsState {
  /** The one shown. */
  current: string;
  chats: ChatState[];
  /** The models Claude Code offers this account. */
  models: { value: string; name: string }[];
  /** The replies being written, by chat id, so a screen opening mid-reply has them (the stream event carries each as it grows). */
  streams?: Record<string, string>;
}

/**
 * The "chat" event: one chat changed. Everything but its rows comes each
 * time; its rows come whole (`items`), or as the rows that changed or are new
 * (`upsert`, each in its id's place or else at the end) with how many there
 * are now (`count`, the oldest past it dropped). Neither: its rows are as they were.
 */
export type ChatPatch = Omit<ChatState, "items"> & { items?: ChatItem[]; upsert?: ChatItem[]; count?: number };

/** The "chats" event: chats came or went, another is shown, or the models changed. `chats` holds only the chats the screens haven't had yet, whole. */
export interface ChatsPatch {
  current: string;
  /** Every chat, in the order of their chips. */
  ids: string[];
  chats: ChatState[];
  models: ChatsState["models"];
}

/** The "stream" event: the reply a chat is writing grew (its text from `at` on is `text`), or started again (`at` 0). */
export interface ChatStreamDelta {
  id: string;
  at: number;
  text: string;
}

/** A conversation Claude Code kept on this machine: Past chats picks one back up as a chat. */
export interface PastChat {
  sessionId: string;
  /** Its /rename title, Claude Code's summary of it, or its first message. */
  title: string;
  folder: string;
  updated: string;
  branch?: string;
  /** The chat it's open in, when the host has it. */
  chat?: string;
}

/** A new chat: everything optional. `context` goes to Claude ahead of the first message without being shown; `about` names what it's about. */
export interface NewChatOptions {
  text?: string;
  model?: string;
  title?: string;
  context?: string;
  about?: string;
  folder?: string;
}

export type AskDecision = "allow" | "always" | "deny";
export type ThumbSize = "md" | "lg";

/** An image read back for a screen to draw or save. */
export interface ImageBytesOut {
  bytes: Uint8Array;
  type: string;
  name: string;
}

/** The events a host sends its screens. */
export type ClaudeEvent = { type: "chats"; payload: ChatsPatch } | { type: "chat"; payload: ChatPatch } | { type: "stream"; payload: ChatStreamDelta };

/**
 * Everything a screen can ask of a host. The Electron bridge, the HTTP client
 * and Benhäus's own `window.benhaus.chat` all have this shape, so the React
 * screens take any of them. `chat` is a chat's id or title; without it, the
 * one shown.
 */
export interface ClaudeTransport {
  state(): Promise<ChatsState>;
  /** Starts a chat's session if it isn't running (as a message is typed, so it's warm by the time it's sent; and Start again). */
  start(chat?: string): Promise<ChatState>;
  /** The screen shows these chats: each reads its conversation in if it hasn't, and its session isn't let go as unseen. */
  seen(chats: string | string[]): Promise<void>;
  send(text: string, chat?: string, images?: NewChatImage[]): Promise<ChatState>;
  /** An image to draw: a kept image's id, or a path (relative to `folder`), file:, data: or http(s) address from a reply. */
  image(ref: string, folder?: string, thumb?: ThumbSize): Promise<ImageBytesOut>;
  /** Saves an image somewhere the host chooses (a Save dialog). Without it, the screen downloads it through the browser. */
  saveImage?(ref: string, o?: { folder?: string; name?: string }): Promise<string | undefined>;
  stop(chat?: string): Promise<ChatState>;
  newChat(o?: NewChatOptions): Promise<ChatState>;
  select(chat: string): Promise<ChatsState>;
  close(chat: string): Promise<ChatsState>;
  answer(id: string, decision: AskDecision): Promise<ChatState>;
  /** The chat's conversation in Claude Code in a terminal; it picks back up from the transcript at its next message. */
  terminal?(chat?: string): Promise<{ folder: string; command: string }>;
  configure(chat: string, o: { mode?: ClaudeMode; model?: string }): Promise<ChatState>;
  past(query?: string, limit?: number): Promise<{ total: number; chats: PastChat[] }>;
  load(sessionId: string): Promise<ChatsState>;
  onList(cb: (p: ChatsPatch) => void): () => void;
  onChange(cb: (p: ChatPatch) => void): () => void;
  onStream(cb: (d: ChatStreamDelta) => void): () => void;
  /** Its event stream came back after a drop (HTTP): changes may have gone by, so the screens read everything again. */
  onReconnect?(cb: () => void): () => void;
}
