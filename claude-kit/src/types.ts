// The chat's shapes, shared by the host (Node), the transports and the screens.
// No Node and no DOM here: every entry point imports these.

import type { ChatBlock, RawAnswer } from "@btkulka/chat-blocks";

export type { BlockAnswer, BlockSpec, BlockState, ChatBlock, RawAnswer } from "@btkulka/chat-blocks";

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

/** A file attached to a message: on the host's machine, by path (the host keeps what a screen uploads in its chat-files folder). Claude reads it there with its tools. */
export interface ChatFile {
  path: string;
  name: string;
  /** Bytes; none for a folder. */
  size?: number;
}

/** A file to send with a message: one on the host's machine by path (a folder too), or bytes a screen uploads (a phone's picker), which the host keeps. */
export type NewChatFile = { path: string; name?: string } | { data: string; name: string; type?: string };

/** A row of a conversation. */
export type ChatItem =
  | { kind: "you"; id: string; text: string; images?: ChatImage[]; files?: ChatFile[] }
  | { kind: "claude"; id: string; text: string }
  | { kind: "tool"; id: string; name: string; detail?: string; state: "running" | "done" | "error"; result?: string; images?: ChatImage[]; block?: ChatBlock }
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

/** Work Claude started in the background and carries on past (a command, an agent, a workflow, a monitor): going, or just ended. */
export interface ChatJob {
  /** Claude Code's task id. */
  id: string;
  /** What runs it, as Claude Code says: local_bash, local_agent, local_workflow, monitor, mcp_task… */
  kind: string;
  /** An agent's type ("general-purpose", "Explore"). */
  agent?: string;
  /** What it's doing ("Build the app"). */
  title: string;
  /** Its latest progress: an agent's summary or the tool it last used; once it ends, how it went. */
  line?: string;
  /** When it started (ms since 1970), for how long it's been going. */
  since: number;
  /** How it ended, for the moment it stays shown after. */
  ended?: "completed" | "failed" | "stopped";
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
  /** Blocks waiting for an answer (await_feedback, AskUserQuestion): their tool rows draw them, and these answer. */
  blocks?: ChatBlock[];
  error?: string;
  /** What the turn is doing besides writing ("Retrying, attempt 2 of 10"). */
  activity?: string;
  /** Background jobs its session is running (and ones that just ended, for a moment). Its session isn't let go while one runs. */
  jobs?: ChatJob[];
}

/**
 * What the host lets its chats do, for the screens to offer only that (the host refuses the rest whatever a
 * screen sends). Left out: everything.
 */
export interface ChatLimits {
  /** The modes a chat may be in. Left out, every one. */
  modes?: ClaudeMode[];
  /** Past chats can be listed and picked up. */
  past: boolean;
  /** Continue in terminal. */
  terminal: boolean;
}

/** Every chat, in the order of their chips. */
export interface ChatsState {
  /** The one shown. */
  current: string;
  chats: ChatState[];
  /** The models Claude Code offers this account. */
  models: { value: string; name: string }[];
  limits?: ChatLimits;
  /** The line an empty chat shows under its heading, from the host; left out, the package's own. */
  intro?: string;
  /** How much of the work a chat shows (the host's `verbosity`): every tool row, or only the conversation. */
  verbosity?: ChatVerbosity;
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
  limits?: ChatLimits;
  intro?: string;
  verbosity?: ChatVerbosity;
}

/**
 * "full": every tool Claude uses is a row (what it read, edited and ran, with the output). "conversational": only
 * what's said, both ways, and notes that something went wrong; while Claude works, one plain line says what it's
 * doing ("Making the change…"). For people who aren't programmers.
 */
export type ChatVerbosity = "full" | "conversational";

/** The "stream" event: the reply a chat is writing grew (its text from `at` on is `text`), or started again (`at` 0). */
export interface ChatStreamDelta {
  id: string;
  at: number;
  text: string;
}

/** A slash command a chat's session takes (a skill, a plugin's, one of Claude Code's own): typing / lists them. */
export interface ChatCommand {
  /** Without the slash. */
  name: string;
  description: string;
  /** What goes after it ("<file>"), when it takes something. */
  hint?: string;
  /** Other names it answers to. */
  aliases?: string[];
  /** One of Claude Code's own, not a skill, a plugin's or an MCP server's. */
  builtin?: boolean;
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

/** What configure changes on one chat: only what's given. */
export interface ChatSettings {
  mode?: ClaudeMode;
  model?: string;
  title?: string;
}

export type AskDecision = "allow" | "always" | "deny";
export type ThumbSize = "md" | "lg";

/** An image read back for a screen to draw or save. */
export interface ImageBytesOut {
  bytes: Uint8Array;
  type: string;
  name: string;
}

/** A file an app block's page asked for (a model, its textures): read back for the page. */
export interface FileBytesOut {
  bytes: Uint8Array;
  type: string;
  name: string;
  size: number;
}

/** An app block's page, ready for a sandboxed iframe's srcdoc. */
export interface AppPage {
  html: string;
  /** It asked for a border of its own (resource _meta.ui.prefersBorder). */
  prefersBorder?: boolean;
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
  /** Images go to Claude as pictures; files are listed on the message by path, and Claude reads them with its tools. */
  send(text: string, chat?: string, images?: NewChatImage[], files?: NewChatFile[]): Promise<ChatState>;
  /** A dropped or picked file's path on this machine (Electron's webUtils.getPathForFile), so it's attached by path instead of uploaded. Absent in a browser. */
  pathFor?(file: object): string | undefined;
  /** An image to draw: a kept image's id, or a path (relative to `folder`), file:, data: or http(s) address from a reply. */
  image(ref: string, folder?: string, thumb?: ThumbSize): Promise<ImageBytesOut>;
  /** Saves an image somewhere the host chooses (a Save dialog). Without it, the screen downloads it through the browser. */
  saveImage?(ref: string, o?: { folder?: string; name?: string }): Promise<string | undefined>;
  stop(chat?: string): Promise<ChatState>;
  newChat(o?: NewChatOptions): Promise<ChatState>;
  select(chat: string): Promise<ChatsState>;
  close(chat: string): Promise<ChatsState>;
  answer(id: string, decision: AskDecision): Promise<ChatState>;
  /** Answers a waiting block (its id is its tool call's): with its value, or words. Without it, blocks are drawn but can't be answered here. */
  reply?(id: string, answer: RawAnswer): Promise<ChatState>;
  /** An app block's page (an MCP Apps ui:// resource its app's server serves), read through the chat's session, its policy in place. */
  appPage?(chat: string, app: string, uri: string): Promise<AppPage>;
  /** A file an app block's page asked for: one its props name, or one in that file's folder (a model's textures, a set's parts). Refused for anything else. */
  file?(chat: string, block: string, ref: string): Promise<FileBytesOut>;
  /**
   * Stars on files (Benhäus: Gallery's star): `on` true stars them, false unstars them, left out only asks.
   * Resolves with whether each is starred now. A carousel's cards and an app block's page (files its props
   * name) show a star with it; without it, neither does.
   */
  star?(refs: string[], on?: boolean): Promise<boolean[]>;
  /** The chat's conversation in Claude Code in a terminal; it picks back up from the transcript at its next message. */
  terminal?(chat?: string): Promise<{ folder: string; command: string }>;
  /** A chat's mode, model or name (`title`; blank names it for its first message again). */
  configure(chat: string, o: ChatSettings): Promise<ChatState>;
  /** The slash commands the chat's session takes, for the box's / menu (it starts the session if it isn't up). Absent: no menu. */
  commands?(chat?: string): Promise<ChatCommand[]>;
  past(query?: string, limit?: number): Promise<{ total: number; chats: PastChat[] }>;
  load(sessionId: string): Promise<ChatsState>;
  onList(cb: (p: ChatsPatch) => void): () => void;
  onChange(cb: (p: ChatPatch) => void): () => void;
  onStream(cb: (d: ChatStreamDelta) => void): () => void;
  /** Its event stream came back after a drop (HTTP): changes may have gone by, so the screens read everything again. */
  onReconnect?(cb: () => void): () => void;
}
