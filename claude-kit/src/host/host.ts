import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import { answerFor, checkSpec, expiredOutcome, outcomeOf, outcomeText, settled, shownOutcome, withPolicy, type BlockOutcome, type BlockSpec, type ChatBlock, type PageCsp } from "@btkulka/chat-blocks";
import { diffItems } from "../patch.js";
import type {
  AppPage,
  AskDecision,
  RawAnswer,
  ChatAsk,
  ChatCommand,
  ChatFile,
  ChatImage,
  ChatItem,
  ChatJob,
  ChatPatch,
  ChatsPatch,
  ChatsState,
  ChatState,
  ChatStreamDelta,
  ClaudeEvent,
  ClaudeMode,
  FileBytesOut,
  ImageBytesOut,
  NewChatFile,
  NewChatImage,
  NewChatOptions,
  PastChat,
  ThumbSize,
  ChatLimits,
  ChatSettings,
  ChatVerbosity,
} from "../types.js";
import { fileType, MAX_FILE_BYTES, readablePath } from "./blockfiles.js";
import { FileStore } from "./files.js";
import { ImageStore, type ImageTools } from "./images.js";
import { ASK_TOOL, BLOCK_SERVER, BLOCK_TOOL, BLOCK_TOOL_DESCRIPTION, BLOCK_TOOL_NAME, blockToolShape, questionAnswers, questionsBlock, type ZodLike } from "./blocks.js";
import { contextWrapper, detailOf, firstLine, fromWrapper, MAX_ITEMS, rowMaker } from "./items.js";
import { toolLabel } from "../words.js";
import type { AgentSdk, CanUseToolLike, PermissionResultLike, QueryLike, Said, SdkMessage, SdkUserMessage, SlashCommandLike, ToolResultLike } from "./sdk.js";
import { openTerminal } from "./terminal.js";
import { transcriptTail } from "./transcript.js";

// An app's chats, each a standing Claude Code session hosted with the Agent
// SDK (lifted from the Benhäus panel, main/claude.ts). query() reads the
// person's messages from a queue, so a session stays up between them. A chat
// on screen reads its conversation so far from the tail of its transcript; its
// session starts at the first message (or as one is typed) and picks the same
// conversation back up after a restart. One that's sat off screen a while, or
// on screen with nothing said for longer, lets its process go and picks up the
// same way. Past chats picks any conversation Claude Code kept back up as a
// chat of its own. Each is the person's own Claude Code: their sign-in,
// settings, CLAUDE.md files, skills and MCP servers, plus the app's own
// servers, working in the folder it began in. Anything its mode doesn't allow
// comes to the screens as an ask.

/** User and assistant entries read back from a transcript's end: enough for MAX_ITEMS rows when most are tool calls and their results. */
const TAIL_ENTRIES = 900;

const IMAGES_NOTE =
  "This chat shows images: ones the person attaches come with their message, and to show them one, put it in your reply as markdown, ![what it is](a path or an https address), on a line of its own; they can open it large or save it.";

const BLOCKS_NOTE = `To have the person pick an image (one carousel, or a group of carousels picked together), choose between options, confirm, or fill in a few fields, call ${BLOCK_TOOL_NAME} instead of asking in words and ending your turn: the chat draws it, and their answer comes back as the tool's result.`;

type Value<T> = T | (() => T);
const val = <T>(v: Value<T>): T => (typeof v === "function" ? (v as () => T)() : v);

export interface ChatNotice {
  kind: "needs" | "info";
  title: string;
  detail?: string;
}

export interface ChatHostOptions {
  /** The Agent SDK, loaded by the app: `() => import("@anthropic-ai/claude-agent-sdk")`. Typed loosely so any version's module fits; the host uses the parts in sdk.ts. */
  sdk: () => Promise<unknown>;
  /** Where the host keeps its chats (claude-chats.json) and their images (chat-images/). */
  dataDir: string;
  /** The app, as Claude Code's client id names it: "orange-friction/0.1.0". */
  app: string;
  /** The folder new chats work in: usually the app's own repo. */
  folder: Value<string>;
  /** New chats' model (an alias or id, "" for Claude Code's default). Left out, the last one picked in a chat. */
  model?: Value<string>;
  /** New chats' mode. Left out, the last one picked in a chat, else "default" (asks before edits and commands). */
  mode?: Value<ClaudeMode>;
  /** Added to Claude Code's own system prompt: what the app is and what its tools do. */
  systemPrompt?: Value<string>;
  /** The note on showing images, added after `systemPrompt`; false leaves it out. */
  imagesNote?: string | false;
  /**
   * Embedded blocks (@btkulka/chat-blocks): each session gets the await_feedback tool (pick, choice, confirm, form,
   * an app's ui:// page), whose call waits for the person's answer, and AskUserQuestion comes as a block too.
   * false: neither (AskUserQuestion stays off, its questions coming as plain text). Default true; off by itself
   * with an SDK that can't host an in-process tool.
   */
  blocks?: boolean;
  /** The note on blocks, added after the images note; false leaves it out. */
  blocksNote?: string | false;
  /** The app's own MCP servers, beside the person's: an SDK server (createSdkMcpServer), stdio or HTTP. */
  mcpServers?: Value<Record<string, unknown>>;
  /** Anything else for query(), per chat (allowedTools, settingSources, hooks…). The host's own options win over these. */
  queryOptions?: (chat: { id: string; folder: string }) => Record<string, unknown>;
  /** The tag a new chat's page context travels in, ahead of the first message: "app-context". */
  contextTag?: string;
  /** The tag the line saying where a message was sent from travels in, ahead of its words (send's `from`): "sent-from". */
  fromTag?: string;
  /** Past chats: only the app's folder's conversations ("folder", the default) or every one on the machine ("all"). */
  pastChats?: "folder" | "all" | "none";
  /**
   * The modes a chat may be in, for a host other people use. Left out, every mode. Any other is refused
   * (configure throws), a chat saved in one starts in the first of these, and Bypass ("bypassPermissions") is
   * only possible when it's listed.
   */
  modes?: ClaudeMode[];
  /** false: no Continue in terminal (terminal() throws, and the screens don't offer it). Default true. */
  terminal?: boolean;
  /** true: every chat works in `folder`; a screen can't start one anywhere else. */
  lockFolder?: boolean;
  /** The line an empty chat shows under its heading, in place of the package's ("with your skills, CLAUDE.md files and MCP servers"). */
  intro?: string;
  /** How much of the work the screens show: "full" (every tool row, the default) or "conversational" (only what's said). */
  verbosity?: ChatVerbosity;
  /** Who answers asks, for what Claude is told when one is denied or cut short: "The user". */
  person?: string;
  /** Said after "<folder> doesn't exist." when a chat's folder is gone. */
  folderHint?: string;
  /** The file the chats are saved in, under dataDir: "claude-chats.json". */
  file?: string;
  /** An older file to read once when `file` isn't there (Benhäus's one-chat claude-chat.json). */
  legacyFile?: string;
  /** Where kept images go: dataDir/chat-images. */
  imagesDir?: string;
  /** Where files a screen uploads go: dataDir/chat-files. */
  filesDir?: string;
  /** Measuring and scaling images for thumbnails and over-size sends (electron/main's nativeImageTools). */
  imageTools?: ImageTools;
  /** Chats a screen holds open elsewhere (a tab of their own), so a blank one isn't dropped as spare. */
  held?: () => Iterable<string>;
  /** An ask or a finished reply while the person is away (undefined: clear that chat's notices). */
  notify?: (notice: ChatNotice | undefined, chat: ChatState, chats: number) => void;
  /** Continue in terminal: opens Claude Code in a terminal. Default: Windows Terminal or cmd on Windows, Terminal on a Mac. */
  openTerminal?: (folder: string, command: string) => void;
  /** The environment a session starts with; given the host's, with the app's id set and Claude Code's own session variables gone. */
  env?: (env: Record<string, string | undefined>) => Record<string, string | undefined>;
  /** A chat off screen this long, with no turn for as long, lets its process go: 5 minutes. */
  unseenMs?: number;
  /** One on screen lets it go after this long with nothing said: 30 minutes. */
  idleMs?: number;
}

type SavedChat = { id: string; title?: string; about?: string; context?: string; sessionId?: string; folder: string; model?: string; mode?: ClaudeMode };
type Saved = { current?: string; chats: SavedChat[]; picked?: { model?: string; mode?: ClaudeMode } };
type MediaType = "image/png" | "image/jpeg" | "image/gif" | "image/webp";

/** The person's messages, as the async iterable query() reads its prompts from. */
class Inbox implements AsyncIterable<SdkUserMessage> {
  private queued: SdkUserMessage[] = [];
  private waiting?: (r: IteratorResult<SdkUserMessage>) => void;
  private closed = false;

  push(content: Said) {
    const m: SdkUserMessage = { type: "user", message: { role: "user", content }, parent_tool_use_id: null };
    const w = this.waiting;
    this.waiting = undefined;
    if (w) w({ value: m, done: false });
    else this.queued.push(m);
  }

  close() {
    this.closed = true;
    this.waiting?.({ value: undefined, done: true });
    this.waiting = undefined;
  }

  [Symbol.asyncIterator](): AsyncIterator<SdkUserMessage> {
    return {
      next: () => {
        const m = this.queued.shift();
        if (m) return Promise.resolve({ value: m, done: false });
        if (this.closed) return Promise.resolve({ value: undefined, done: true });
        return new Promise((r) => (this.waiting = r));
      },
    };
  }
}

type Pending = { ask: ChatAsk; input: Record<string, unknown>; suggestions?: unknown[]; resolve: (r: PermissionResultLike) => void };
/**
 * A session's slash commands for the / menu: one row a name (Claude Code's own when another shares it, as /name
 * runs that one), leaving out the internal ones (__name) and those only a terminal can use.
 */
function menuCommands(list: SlashCommandLike[], terminalOnly: ReadonlySet<string>): ChatCommand[] {
  const own = new Set(list.filter((x) => x.builtin).map((x) => x.name));
  const seen = new Set<string>();
  const out: ChatCommand[] = [];
  for (const x of list) {
    if (!x.name || x.name.startsWith("_") || terminalOnly.has(x.name) || seen.has(x.name) || (own.has(x.name) && !x.builtin)) continue;
    seen.add(x.name);
    out.push({ name: x.name, description: x.description ?? "", ...(x.argumentHint ? { hint: x.argumentHint } : {}), ...(x.aliases?.length ? { aliases: x.aliases } : {}), ...(x.builtin ? { builtin: true } : {}) });
  }
  return out;
}

/** How long a background job that ended stays shown, saying how it went. */
const JOB_LINGER_MS = 8_000;

/** A block waiting for its answer: `finish` ends the call waiting on it. */
type PendingBlock = { block: ChatBlock; finish: (o: BlockOutcome) => void; timer?: ReturnType<typeof setTimeout> };

/** One chat: its conversation, and the session behind it while one is up. */
type Chat = {
  id: string;
  title?: string;
  state: Omit<ChatState, "id" | "title" | "asks" | "blocks">;
  asks: Map<string, Pending>;
  /** Blocks waiting for an answer, by their tool call's id. */
  blocks: Map<string, PendingBlock>;
  session?: { q: QueryLike; inbox: Inbox };
  starting?: Promise<void>;
  /** Bumped whenever the session is let go, so a start still on its way gives up. */
  gen: number;
  /** Messages sent before the session was up; they go in once it is. */
  early: Said[];
  /** The page it was started from, for Claude, until the first message takes it along. */
  context?: string;
  /** Stop was pressed: the turn's error result is the stop, not a failure. */
  stopping: boolean;
  /** The reply being written, as it streams. */
  stream: string;
  /** How much of it the screens have. */
  streamSent: number;
  streamTimer?: ReturnType<typeof setTimeout>;
  stderr: string[];
  /** When its last turn ended or its session came up. */
  idleSince: number;
  /** When a screen last said it shows this chat (seen(), about once a minute while it does). */
  seenAt: number;
  /** The rows the screens have: each "chat" event carries what changed since. */
  sent: ChatItem[];
  /** Its conversation so far has been read from the transcript (or it has none). */
  loaded: boolean;
  loading?: Promise<void>;
  /** A terminal had it (Continue in terminal): the transcript is read again when its session next starts. */
  stale: boolean;
  /** Its session's slash commands, as it last said; read again with its next session. */
  commands?: SlashCommandLike[];
};

export class ChatHost {
  private readonly chats = new Map<string, Chat>();
  /** The chat shown. */
  private current = "";
  private models: ChatsState["models"] = [];
  /** The commands Claude Code says only a terminal can use (its init message): left out of the / menu. */
  private terminalOnly = new Set<string>();
  private picked: Saved["picked"] = {};
  private readonly listeners = new Set<(e: ClaudeEvent) => void>();
  /** The chats the screens have had whole: a list change sends only the others. */
  private readonly announced = new Set<string>();
  private seq = 0;
  private readonly timers: ReturnType<typeof setTimeout>[] = [];
  private readonly file: string;
  private readonly context: ReturnType<typeof contextWrapper>;
  private readonly from: ReturnType<typeof fromWrapper>;
  private readonly rows: ReturnType<typeof rowMaker>;
  readonly images: ImageStore;
  readonly files: FileStore;

  constructor(private readonly opts: ChatHostOptions) {
    this.file = join(opts.dataDir, opts.file ?? "claude-chats.json");
    this.images = new ImageStore(opts.imagesDir ?? join(opts.dataDir, "chat-images"), opts.imageTools);
    this.files = new FileStore(opts.filesDir ?? join(opts.dataDir, "chat-files"));
    this.context = contextWrapper(opts.contextTag ?? "app-context");
    this.from = fromWrapper(opts.fromTag ?? "sent-from");
    this.rows = rowMaker((s) => this.images.keepBlock(s), this.context.strip, this.from.read);
    const saved = this.readSaved();
    this.picked = saved.picked ?? {};
    const d = this.defaults();
    // A chat saved before chats had their own model ran on the default one.
    for (const c of saved.chats) this.chats.set(c.id, this.makeChat({ ...c, model: c.model ?? d.model, mode: this.fitMode(c.mode ?? d.mode), folder: this.opts.lockFolder ? d.folder : c.folder }));
    this.current = saved.current && this.chats.has(saved.current) ? saved.current : ([...this.chats.keys()].at(-1) ?? "");
    if (!this.chats.size) this.addChat();
    // No screen is up yet: each reads them all whole (state()) when it is.
    for (const id of this.chats.keys()) this.announced.add(id);
    const idle = setInterval(() => this.letIdleGo(), 60_000);
    // Images no chat has shown in a month go, a while after the start.
    const prune = setTimeout(() => void this.images.prune().catch(() => undefined), 5 * 60_000);
    idle.unref?.();
    prune.unref?.();
    this.timers.push(idle, prune);
  }

  /* -------------------------------------------------------------- events */

  /** Every change the screens need: the list, one chat, a reply streaming. Returns the unsubscribe. */
  on(listener: (e: ClaudeEvent) => void): () => void {
    this.listeners.add(listener);
    return () => void this.listeners.delete(listener);
  }

  private emit(e: ClaudeEvent) {
    for (const l of this.listeners) {
      try {
        l(e);
      } catch {
        // A screen that's gone doesn't stop the others hearing.
      }
    }
  }

  /* --------------------------------------------------------------- state */

  private nextId = () => `c${Date.now().toString(36)}${(++this.seq).toString(36)}`;

  private defaults(): { folder: string; model: string; mode: ClaudeMode } {
    const o = this.opts;
    return {
      folder: val(o.folder),
      model: o.model !== undefined ? val(o.model) : (this.picked?.model ?? ""),
      mode: this.fitMode(o.mode !== undefined ? val(o.mode) : (this.picked?.mode ?? "default")),
    };
  }

  /** Whether a chat may be in this mode (the host's `modes`). */
  private allows = (mode: ClaudeMode) => !this.opts.modes?.length || this.opts.modes.includes(mode);
  /** The mode, or the first allowed one when it isn't. */
  private fitMode = (mode: ClaudeMode): ClaudeMode => (this.allows(mode) ? mode : this.opts.modes![0]);

  /** What the screens may offer. */
  private limits = (): ChatLimits => ({ modes: this.opts.modes?.length ? [...this.opts.modes] : undefined, past: this.opts.pastChats !== "none", terminal: this.opts.terminal !== false });

  private readJson(path: string): unknown {
    try {
      return JSON.parse(readFileSync(path, "utf8"));
    } catch {
      return undefined;
    }
  }

  private readSaved(): Saved {
    const saved = this.readJson(this.file) as Saved | undefined;
    if (saved?.chats) return saved;
    if (!this.opts.legacyFile) return { chats: [] };
    const old = this.readJson(join(this.opts.dataDir, this.opts.legacyFile)) as { sessionId?: string; folder?: string; model?: string } | undefined;
    return old?.sessionId && old.folder ? { chats: [{ id: this.nextId(), sessionId: old.sessionId, folder: old.folder, model: old.model }] } : { chats: [] };
  }

  private stateOf = (c: Chat): ChatState => ({ id: c.id, title: c.title ?? "New chat", ...c.state, asks: [...c.asks.values()].map((p) => p.ask), blocks: [...c.blocks.values()].map((p) => p.block) });

  private shown = (): Chat => this.chats.get(this.current) ?? [...this.chats.values()][0] ?? this.addChat();

  /** A chat by its id or title; the one shown without either. */
  private find(ref?: string): Chat {
    if (!ref) return this.shown();
    const c = this.chats.get(ref) ?? [...this.chats.values()].find((x) => x.title?.toLowerCase() === ref.toLowerCase());
    if (!c) throw new Error(`No chat ${ref}.`);
    return c;
  }

  chatState = (ref?: string): ChatState => this.stateOf(this.find(ref));

  /** Every chat whole, with the replies being written: what a screen reads when it comes up. */
  state(): ChatsState {
    const now = this.shown().id;
    const streams = Object.fromEntries([...this.chats.values()].filter((c) => c.stream).map((c) => [c.id, c.stream]));
    return { current: now, chats: [...this.chats.values()].map(this.stateOf), models: this.models, streams, limits: this.limits(), intro: this.opts.intro, verbosity: this.opts.verbosity };
  }

  private save() {
    const list: SavedChat[] = [...this.chats.values()].map((c) => ({ id: c.id, title: c.title, about: c.state.about, context: c.context, sessionId: c.state.sessionId, folder: c.state.folder, model: c.state.pickedModel, mode: c.state.mode }));
    try {
      mkdirSync(this.opts.dataDir, { recursive: true });
      writeFileSync(this.file, JSON.stringify({ current: this.current, chats: list, picked: this.picked } satisfies Saved, null, 2), "utf8");
    } catch {
      // Kept in memory; saved with the next change.
    }
  }

  /** One chat changed: everything but its rows, and of its rows only what changed since the screens last heard. */
  private changed(c: Chat) {
    const { items, ...rest } = this.stateOf(c);
    this.emit({ type: "chat", payload: { ...rest, ...diffItems(c.sent, items) } satisfies ChatPatch });
    c.sent = items;
  }

  /** The list as it is, with only the chats the screens haven't had yet whole. */
  private emitList() {
    const now = this.shown().id;
    const fresh = [...this.chats.values()].filter((c) => !this.announced.has(c.id));
    for (const c of fresh) {
      this.announced.add(c.id);
      c.sent = c.state.items;
    }
    this.emit({ type: "chats", payload: { current: now, ids: [...this.chats.keys()], chats: fresh.map(this.stateOf), models: this.models, limits: this.limits(), intro: this.opts.intro, verbosity: this.opts.verbosity } satisfies ChatsPatch });
  }

  /** Chats came or went, or another is shown. */
  private listChanged() {
    this.save();
    this.emitList();
  }

  private set(c: Chat, patch: Partial<Chat["state"]>) {
    c.state = { ...c.state, ...patch };
    this.changed(c);
  }

  private push(c: Chat, ...items: ChatItem[]) {
    this.set(c, { items: [...c.state.items, ...items].slice(-MAX_ITEMS) });
  }

  private note = (c: Chat, text: string, error?: boolean) => this.push(c, { kind: "note", id: this.nextId(), text, error });

  /** The reply being written, to the screens at most every 50 ms, as what it grew by since they last heard (or from its start, once it starts again). */
  private setStream(c: Chat, text: string, now = false) {
    if (!text.startsWith(c.stream)) c.streamSent = 0;
    c.stream = text;
    const send = () => {
      const at = Math.min(c.streamSent, c.stream.length);
      c.streamSent = c.stream.length;
      this.emit({ type: "stream", payload: { id: c.id, at, text: c.stream.slice(at) } satisfies ChatStreamDelta });
    };
    if (now) {
      clearTimeout(c.streamTimer);
      c.streamTimer = undefined;
      send();
    } else
      c.streamTimer ??= setTimeout(() => {
        c.streamTimer = undefined;
        send();
      }, 50);
  }

  /** A chat's name on its chip: its first message's first line, unless it was given one. */
  private titleFrom(c: Chat, text?: string) {
    if (c.title || !text) return;
    const line = firstLine(text, 60);
    if (line) c.title = line;
  }

  /** Nothing's been said in it. */
  private blank = (c: Chat) => !c.state.items.length && !c.early.length && !c.state.sessionId && c.state.status !== "working";

  /** Blank chats nothing holds: the next new one or a switch away doesn't keep them. */
  private spares(): Chat[] {
    const held = new Set(this.opts.held?.() ?? []);
    return [...this.chats.values()].filter((c) => this.blank(c) && !held.has(c.id));
  }

  private makeChat(o: SavedChat & { model: string; mode: ClaudeMode }): Chat {
    return {
      id: o.id,
      title: o.title,
      state: { status: "off", about: o.about, folder: o.folder, sessionId: o.sessionId, pickedModel: o.model, model: o.model || undefined, mode: o.mode, items: [] },
      asks: new Map(),
      blocks: new Map(),
      gen: 0,
      early: [],
      context: o.context,
      stopping: false,
      stream: "",
      streamSent: 0,
      stderr: [],
      idleSince: Date.now(),
      seenAt: 0,
      sent: [],
      loaded: !o.sessionId,
      stale: false,
    };
  }

  /** A new chat at the end of the chips, in the default folder, mode and model unless given one. It's the one shown. */
  private addChat(o: { model?: string; title?: string; about?: string; folder?: string } = {}): Chat {
    const d = this.defaults();
    const c = this.makeChat({ id: this.nextId(), title: o.title, about: o.about, folder: this.opts.lockFolder ? d.folder : (o.folder ?? d.folder), model: o.model ?? d.model, mode: d.mode });
    this.chats.set(c.id, c);
    this.current = c.id;
    return c;
  }

  /** Ends a chat's session and takes it off, with its notices. */
  private drop(c: Chat) {
    this.closeSession(c);
    this.notify(c);
    this.chats.delete(c.id);
    this.announced.delete(c.id);
  }

  /**
   * A chat whose session has sat with no turn lets its process go: off screen
   * for unseenMs, or on screen for idleMs. It picks back up from the transcript
   * at its next message. With `all` (the app is asleep or hidden), every chat
   * that isn't on a turn or waiting on an answer goes.
   */
  letIdleGo(all = false) {
    const now = Date.now();
    const unseen = this.opts.unseenMs ?? 5 * 60_000;
    const idleMs = this.opts.idleMs ?? 30 * 60_000;
    for (const c of this.chats.values()) {
      // A background job dies with its session, so a chat running one keeps it, asleep or not.
      if (!c.session || c.state.status !== "ready" || c.asks.size || c.blocks.size || c.state.jobs?.some((j) => !j.ended)) continue;
      const idle = now - c.idleSince;
      if (all || idle > idleMs || (idle > unseen && now - c.seenAt > unseen)) {
        this.closeSession(c);
        this.set(c, { status: "off" });
      }
    }
  }

  /**
   * A screen shows these chats: it says so as one comes into view and about
   * once a minute while it stays. Each reads its conversation so far from its
   * transcript if it hasn't, and its session, if one is up, isn't let go as unseen.
   */
  seen(ids: string | string[]): void {
    const now = Date.now();
    for (const id of [ids].flat()) {
      const c = this.chats.get(id);
      if (!c) continue;
      c.seenAt = now;
      void this.loadHistory(c);
    }
  }

  /** A chat's conversation so far, read from the end of its transcript once (and again when its session starts after a terminal had it). */
  private loadHistory(c: Chat): Promise<void> {
    const sessionId = c.state.sessionId;
    if (c.loaded || !sessionId) return Promise.resolve();
    if (!c.loading) {
      const p: Promise<void> = transcriptTail(sessionId, c.state.folder, TAIL_ENTRIES)
        .then((history) => {
          if (c.state.sessionId !== sessionId || !this.chats.has(c.id)) return;
          c.loaded = true;
          if (!history.length) return;
          // What was sent meanwhile isn't in the transcript yet.
          const sent = c.early.length ? c.state.items.filter((i) => i.kind === "you").slice(-c.early.length) : [];
          const items = [...this.rows.fromTranscript(history), ...sent];
          if (!c.title) {
            this.titleFrom(c, items.find((i) => i.kind === "you")?.text);
            this.save();
          }
          this.set(c, { items });
        })
        .catch(() => {
          c.loaded = true;
        })
        .finally(() => {
          if (c.loading === p) c.loading = undefined;
        });
      c.loading = p;
    }
    return c.loading;
  }

  /* ------------------------------------------------------------- messages */

  private take(c: Chat, m: SdkMessage) {
    switch (m.type) {
      case "system":
        if (m.subtype === "init") {
          if (Array.isArray(m.terminal_slash_commands)) this.terminalOnly = new Set(m.terminal_slash_commands);
          this.set(c, { sessionId: m.session_id, model: m.model, mode: m.permissionMode });
          this.save();
        } else if (m.subtype === "commands_changed" && Array.isArray(m.commands)) c.commands = m.commands;
        else if (m.subtype === "background_tasks_changed" && Array.isArray(m.tasks)) this.jobsNow(c, m.tasks);
        else if (m.subtype === "task_progress") this.jobProgress(c, m);
        else if (m.subtype === "task_notification") this.jobEnded(c, m.task_id, m.status, m.summary); else if (m.subtype === "status") this.set(c, { activity: m.status === "compacting" ? "Compacting the conversation" : undefined, ...(m.permissionMode ? { mode: m.permissionMode } : {}) });
        else if (m.subtype === "compact_boundary") this.note(c, "Earlier messages were compacted to make room.");
        else if (m.subtype === "api_retry") this.set(c, { activity: `Retrying, attempt ${m.attempt} of ${m.max_retries}` });
        return;
      case "stream_event": {
        if (m.parent_tool_use_id) return;
        const ev = m.event;
        if (ev?.type === "content_block_delta" && ev.delta?.type === "text_delta") this.setStream(c, c.stream + ev.delta.text);
        else if (ev?.type === "message_start") {
          // A turn Claude Code started by itself (a background job ended, and Claude carries on) is working all the same.
          if (c.state.status === "ready") this.set(c, { status: "working" });
          this.setStream(c, "", true);
        }
        return;
      }
      case "assistant": {
        if (m.parent_tool_use_id) return;
        const items = this.rows.assistantItems(m.uuid, m.message?.content, "running");
        if (items.some((i) => i.kind === "claude")) this.setStream(c, "", true);
        // Web search's results come in the same message as its call.
        if (items.length) this.set(c, { items: this.rows.withResults([...c.state.items, ...items], m.message?.content, new Date().toISOString()).slice(-MAX_ITEMS) });
        if (m.error) this.note(c, `Claude Code: ${m.error}`, true);
        return;
      }
      case "user":
        if (!m.parent_tool_use_id) this.set(c, { items: this.rows.withResults(c.state.items, m.message?.content, new Date().toISOString()) });
        return;
      case "result": {
        // A reply cut off by Stop keeps what it had written.
        if (c.stopping && c.stream.trim()) this.push(c, { kind: "claude", id: this.nextId(), text: c.stream });
        this.setStream(c, "", true);
        c.idleSince = Date.now();
        const queued: number = m.queued_turn_count ?? 0;
        this.settleBlocks(c, "The turn ended.");
        // A stopped turn leaves its tools without results, and its blocks without answers.
        const items = c.state.items.map((i) =>
          i.kind !== "tool" ? i : { ...i, state: i.state === "running" ? ("done" as const) : i.state, ...(i.block?.state === "waiting" ? { block: settled(i.block, expiredOutcome("The turn ended without an answer.")) } : {}) },
        );
        this.set(c, { status: queued ? "working" : "ready", activity: undefined, items });
        if (c.stopping) {
          c.stopping = false;
          this.note(c, "Stopped.");
        } else if (m.subtype !== "success") this.note(c, (m.errors ?? []).join("\n") || "The turn stopped early.", true);
        else if (m.is_error) this.note(c, m.result || "Claude Code hit an error.", true);
        else if (!queued) {
          const last = [...c.state.items].reverse().find((i) => i.kind === "claude");
          this.notify(c, { kind: "info", title: "Claude replied", detail: last?.kind === "claude" ? last.text.slice(0, 160) : undefined });
        }
        return;
      }
    }
  }

  /* -------------------------------------------------------------- session */

  /** The environment a session gets: the app's id set, and none of a Claude Code shell or Electron-as-Node it may have been started from. */
  env(): Record<string, string | undefined> {
    const env: Record<string, string | undefined> = { ...process.env, CLAUDE_AGENT_SDK_CLIENT_APP: this.opts.app };
    for (const k of ["ELECTRON_RUN_AS_NODE", "CLAUDECODE", "CLAUDE_CODE_ENTRYPOINT", "CLAUDE_CODE_SSE_PORT"]) delete env[k];
    return this.opts.env ? this.opts.env(env) : env;
  }

  private who = () => this.opts.person ?? "The user";

  private blocksOn = () => this.opts.blocks !== false;

  /**
   * A block waits for its answer: on its chat (the screens answer it with
   * reply(), or words typed in the box), until it's answered, the turn stops,
   * the session goes, its call is cancelled or `timeoutS` runs out.
   */
  private waitBlock(c: Chat, block: ChatBlock, signal?: AbortSignal, timeoutS?: number): Promise<BlockOutcome> {
    return new Promise((resolve) => {
      const p: PendingBlock = { block, finish: resolve };
      if (timeoutS) {
        const mins = Math.round(timeoutS / 60);
        p.timer = setTimeout(() => this.settleBlock(c, block.id, expiredOutcome(`No answer after ${timeoutS < 90 ? `${Math.round(timeoutS)} seconds` : `${mins} minute${mins === 1 ? "" : "s"}`}.`)), timeoutS * 1000);
      }
      signal?.addEventListener("abort", () => this.settleBlock(c, block.id, expiredOutcome("Cancelled.")), { once: true });
      c.blocks.set(block.id, p);
      // Its row (the call's own) carries the block as it was checked here.
      this.set(c, { items: c.state.items.map((i) => (i.kind === "tool" && i.id === block.id ? { ...i, block } : i)) });
      this.notify(c, { kind: "needs", title: "Claude is waiting for you", detail: block.title ?? "Something to answer in the chat" });
    });
  }

  /** A waiting block ends: its call gets the outcome, and its row shows it. */
  private settleBlock(c: Chat, id: string, o: BlockOutcome) {
    const p = c.blocks.get(id);
    if (!p) return;
    c.blocks.delete(id);
    clearTimeout(p.timer);
    p.finish(o);
    this.set(c, { items: c.state.items.map((i) => (i.kind === "tool" && i.id === id ? { ...i, block: settled(i.block ?? p.block, o) } : i)) });
    if (!c.asks.size && !c.blocks.size) this.notify(c);
  }

  private settleBlocks(c: Chat, reason: string) {
    for (const id of [...c.blocks.keys()]) this.settleBlock(c, id, expiredOutcome(reason));
  }

  /** The newest await_feedback row still running with no block waiting on it: whose call it is when the SDK didn't say. */
  private unclaimed(c: Chat): string | undefined {
    for (let i = c.state.items.length - 1; i >= 0; i--) {
      const it = c.state.items[i];
      if (it.kind === "tool" && it.name === BLOCK_TOOL_NAME && it.state === "running" && !c.blocks.has(it.id)) return it.id;
    }
    return undefined;
  }

  /** await_feedback's handler: the spec checked (what's wrong goes back to Claude), then the wait, then the outcome as JSON. */
  private async runBlock(c: Chat, args: Record<string, unknown>, extra: unknown): Promise<ToolResultLike> {
    let spec: BlockSpec;
    try {
      spec = checkSpec(args);
    } catch (e) {
      return { content: [{ type: "text", text: (e as Error).message }], isError: true };
    }
    const x = (extra ?? {}) as { _meta?: Record<string, unknown>; signal?: AbortSignal };
    const said = x._meta?.["claudecode/toolUseId"];
    const id = (typeof said === "string" && said) || this.unclaimed(c) || this.nextId();
    // Put up to look at: on its row as shown, and the call goes on at once.
    if (args.wait === false) {
      const block: ChatBlock = { ...spec, id, state: "shown" };
      this.set(c, { items: c.state.items.map((i) => (i.kind === "tool" && i.id === id ? { ...i, block } : i)) });
      return { content: [{ type: "text", text: outcomeText(shownOutcome) }] };
    }
    const timeoutS = typeof args.timeoutS === "number" && args.timeoutS > 0 ? args.timeoutS : undefined;
    const o = await this.waitBlock(c, { ...spec, id, state: "waiting" }, x.signal, timeoutS);
    return { content: [{ type: "text", text: outcomeText(o) }] };
  }

  /** The block tool's server, for one chat's session; undefined when the SDK can't host one (or zod isn't there). */
  private async blockServer(c: Chat, sdk: AgentSdk): Promise<unknown> {
    if (!this.blocksOn() || !sdk.createSdkMcpServer || !sdk.tool) return undefined;
    let z: ZodLike;
    try {
      z = (await import("zod")).z as unknown as ZodLike;
    } catch {
      return undefined;
    }
    const t = sdk.tool(BLOCK_TOOL, BLOCK_TOOL_DESCRIPTION, blockToolShape(z), (args: Record<string, unknown>, extra: unknown) => this.runBlock(c, args, extra), {
      alwaysLoad: true,
      annotations: { title: "Ask in the chat", readOnlyHint: true, openWorldHint: false },
    });
    return sdk.createSdkMcpServer({ name: BLOCK_SERVER, version: "1.0.0", tools: [t], alwaysLoad: true });
  }

  /** AskUserQuestion as a questions block: answered, its answers go back as the tool's input; cut short, it's denied with why. */
  private askQuestions(c: Chat, input: Record<string, unknown>, o: Parameters<CanUseToolLike>[2]): Promise<PermissionResultLike> | undefined {
    const block = questionsBlock(o.toolUseID, input);
    if (!block) return undefined;
    return this.waitBlock(c, block, o.signal).then((out): PermissionResultLike => ("answered" in out ? { behavior: "allow", updatedInput: { ...input, answers: questionAnswers(block, out) } } : { behavior: "deny", message: "expired" in out ? out.reason : "No answer." }));
  }

  private canUseTool =
    (c: Chat): CanUseToolLike =>
    (tool, input, o) =>
      (tool === ASK_TOOL && this.blocksOn() ? this.askQuestions(c, input, o) : undefined) ??
      new Promise((resolve) => {
        const id = o.toolUseID;
        const ask: ChatAsk = {
          id,
          tool,
          title: o.title ?? `Claude wants to use ${tool}`,
          sub: o.description ?? o.decisionReason,
          detail: detailOf(input, 4000),
          canAlways: !o.suppressAlwaysAllowRule,
        };
        // No rule suggested (MCP tools, mostly): Always allow is then the whole tool for the rest of the session.
        const suggestions = o.suggestions?.length ? o.suggestions : [{ type: "addRules", rules: [{ toolName: tool }], behavior: "allow", destination: "session" }];
        c.asks.set(id, { ask, input, suggestions, resolve });
        o.signal.addEventListener(
          "abort",
          () => {
            if (!c.asks.delete(id)) return;
            resolve({ behavior: "deny", message: "Cancelled." });
            this.changed(c);
          },
          { once: true },
        );
        this.changed(c);
        this.notify(c, { kind: "needs", title: "Claude is waiting for you", detail: ask.title });
      });

  /** Starts a chat's session if it isn't running: as a message is typed to a chat that's off (so it's warm by the time it's sent), and Start again. */
  async start(ref?: string): Promise<ChatState> {
    const c = this.find(ref);
    await this.startChat(c);
    return this.stateOf(c);
  }

  private startChat(c: Chat): Promise<void> {
    if (c.session) return Promise.resolve();
    if (!c.starting) {
      const p: Promise<void> = this.open(c).finally(() => {
        if (c.starting === p) c.starting = undefined;
      });
      c.starting = p;
    }
    return c.starting;
  }

  private systemAppend(): string | undefined {
    const parts = [
      this.opts.systemPrompt !== undefined ? val(this.opts.systemPrompt) : "",
      this.opts.imagesNote === false ? "" : (this.opts.imagesNote ?? IMAGES_NOTE),
      !this.blocksOn() || this.opts.blocksNote === false ? "" : (this.opts.blocksNote ?? BLOCKS_NOTE),
    ];
    const text = parts.filter((p) => p.trim()).join(" ");
    return text || undefined;
  }

  private async open(c: Chat, fresh = false) {
    const g = c.gen;
    const { folder } = c.state;
    const resume = fresh ? undefined : c.state.sessionId;
    if (!existsSync(folder)) {
      this.set(c, { status: "error", error: `${folder} doesn't exist.${this.opts.folderHint ? ` ${this.opts.folderHint}` : ""}` });
      return;
    }
    this.set(c, { status: "starting", sessionId: resume, error: undefined, activity: undefined });
    c.stderr = [];
    let sdk: AgentSdk;
    try {
      sdk = (await this.opts.sdk()) as AgentSdk;
    } catch (e) {
      this.set(c, { status: "error", error: `Claude Code didn't load: ${(e as Error).message}` });
      return;
    }
    // Picked back up after a restart: the conversation as the transcript has it (read once, when it was first shown), plus anything sent meanwhile; after a terminal had it, read again.
    if (resume) {
      if (c.stale) {
        c.stale = false;
        c.loaded = false;
      }
      await this.loadHistory(c);
    }
    if (g !== c.gen) return;
    const inbox = new Inbox();
    const extra = this.opts.queryOptions?.({ id: c.id, folder }) ?? {};
    const mcp = this.opts.mcpServers !== undefined ? val(this.opts.mcpServers) : undefined;
    const blocks = await this.blockServer(c, sdk);
    if (g !== c.gen) return;
    const servers = { ...((extra.mcpServers as Record<string, unknown> | undefined) ?? {}), ...(mcp ?? {}), ...(blocks ? { [BLOCK_SERVER]: blocks } : {}) };
    const append = this.systemAppend();
    let q: QueryLike;
    try {
      q = sdk.query({
        prompt: inbox,
        options: {
          ...extra,
          cwd: folder,
          resume,
          model: c.state.pickedModel || undefined,
          permissionMode: c.state.mode,
          allowDangerouslySkipPermissions: this.allows("bypassPermissions"),
          includePartialMessages: true,
          canUseTool: this.canUseTool(c),
          // With blocks, AskUserQuestion's questions are a block (canUseTool) and await_feedback needs no asking; without, its questions come as plain text.
          disallowedTools: [...new Set([...((extra.disallowedTools as string[] | undefined) ?? []), ...(blocks ? [] : [ASK_TOOL])])],
          ...(blocks ? { allowedTools: [...new Set([...((extra.allowedTools as string[] | undefined) ?? []), BLOCK_TOOL_NAME])] } : {}),
          ...(Object.keys(servers).length ? { mcpServers: servers } : {}),
          systemPrompt: append ? { type: "preset", preset: "claude_code", append } : { type: "preset", preset: "claude_code" },
          env: this.env(),
          stderr: (d: string) => (c.stderr = [...c.stderr, ...d.split(/\r?\n/).filter(Boolean)].slice(-20)),
        },
      });
    } catch (e) {
      this.set(c, { status: "error", error: `Claude Code didn't start: ${(e as Error).message}` });
      return;
    }
    c.session = { q, inbox };
    c.idleSince = Date.now();
    const sending = c.early;
    c.early = [];
    for (const text of sending) inbox.push(text);
    this.set(c, { status: sending.length ? "working" : "ready" });
    void q
      .initializationResult()
      .then((r) => {
        if (c.session?.q === q && !c.commands && r.commands) c.commands = r.commands;
        const next = r.models.map((m) => ({ value: m.value, name: m.displayName }));
        if (JSON.stringify(next) === JSON.stringify(this.models)) return;
        this.models = next;
        this.emitList();
      })
      .catch(() => undefined);
    void this.pump(c, q, resume ? sending : undefined);
  }

  /** Reads a session's messages until it ends. `resumed` holds what was sent to a picked-up session, to send again if picking it up failed. */
  private async pump(c: Chat, q: QueryLike, resumed?: Said[]) {
    let answered = false;
    let error: string | undefined;
    try {
      for await (const m of q) {
        if (m.type === "system" && m.subtype === "init") answered = true;
        this.take(c, m);
      }
    } catch (e) {
      error = (e as Error).message;
    }
    if (c.session?.q !== q) return; // closed on purpose: closed, idle, a terminal, quitting
    c.session = undefined;
    this.settleAsks(c, "The session ended.");
    this.settleBlocks(c, "The session ended.");
    this.setStream(c, "", true);
    if (resumed && !answered) {
      // The saved conversation couldn't be picked up (its transcript is gone): start a new one with what was sent.
      this.set(c, { sessionId: undefined });
      this.save();
      this.note(c, "Couldn't pick up the last conversation, so this is a new one.");
      c.early = resumed;
      return void this.open(c, true);
    }
    this.set(c, { status: "error", activity: undefined, jobs: undefined, error: error ?? c.stderr.at(-1) ?? "Claude Code stopped." });
  }

  private settleAsks(c: Chat, message: string) {
    for (const p of c.asks.values()) p.resolve({ behavior: "deny", message });
    c.asks.clear();
  }

  /** Claude Code's whole set of live background tasks (it sends it whenever one starts or ends): the chat's jobs, the ones that just ended kept a moment. */
  private jobsNow(c: Chat, tasks: Array<Record<string, unknown>>) {
    const was = new Map((c.state.jobs ?? []).map((j) => [j.id, j]));
    const live = tasks
      .filter((t) => typeof t.task_id === "string" && !t.ambient)
      .map((t): ChatJob => {
        const id = t.task_id as string;
        const old = was.get(id);
        const agent = typeof t.subagent_type === "string" ? t.subagent_type : old?.agent;
        return { id, kind: String(t.task_type ?? "task"), ...(agent ? { agent } : {}), title: String(t.description || old?.title || "A background job"), ...(old?.line ? { line: old.line } : {}), since: old?.since ?? Date.now() };
      });
    const ids = new Set(live.map((j) => j.id));
    // Gone from the set before its notification came (or without one): ended, which the notification then says how.
    const gone = [...was.values()].filter((j) => !ids.has(j.id)).map((j) => (j.ended ? j : (this.dropJobLater(c, j.id), { ...j, ended: "completed" as const })));
    if (!live.length && !gone.length && !was.size) return;
    this.set(c, { jobs: [...live, ...gone] });
  }

  /** A job's progress: an agent's summary, or the tool it's on. */
  private jobProgress(c: Chat, m: SdkMessage) {
    const jobs = c.state.jobs ?? [];
    if (!jobs.some((j) => j.id === m.task_id && !j.ended)) return;
    const line: string | undefined = m.summary || (m.last_tool_name ? `Using ${toolLabel(String(m.last_tool_name))}` : undefined);
    const ran = typeof m.usage?.duration_ms === "number" ? Date.now() - m.usage.duration_ms : undefined;
    this.set(c, { jobs: jobs.map((j) => (j.id === m.task_id ? { ...j, ...(line ? { line } : {}), since: ran ? Math.min(j.since, ran) : j.since } : j)) });
  }

  /** A job ended (its task_notification): how, and its summary, for a moment before it goes. */
  private jobEnded(c: Chat, id: string, status: string, summary?: string) {
    const jobs = c.state.jobs ?? [];
    const job = jobs.find((j) => j.id === id);
    if (!job) return;
    const ended = status === "failed" || status === "stopped" ? status : "completed";
    if (!job.ended) this.dropJobLater(c, id);
    this.set(c, { jobs: jobs.map((j) => (j.id === id ? { ...j, ended, ...(summary ? { line: summary } : {}) } : j)) });
  }

  private dropJobLater(c: Chat, id: string) {
    const t = setTimeout(() => {
      const jobs = c.state.jobs ?? [];
      if (this.chats.has(c.id) && jobs.some((j) => j.id === id && j.ended)) this.set(c, { jobs: jobs.filter((j) => j.id !== id) });
    }, JOB_LINGER_MS);
    t.unref?.();
  }

  private closeSession(c: Chat) {
    const s = c.session;
    // Its jobs end with its process; whoever closed it says so with the change that follows.
    if (c.state.jobs) c.state = { ...c.state, jobs: undefined };
    c.session = undefined;
    c.gen++;
    c.starting = undefined;
    this.settleAsks(c, `${this.who()} closed the session.`);
    this.settleBlocks(c, `${this.who()} closed the session.`);
    c.stopping = false;
    c.commands = undefined;
    this.setStream(c, "", true);
    s?.inbox.close();
    s?.q.close();
  }

  /* --------------------------------------------------------------- actions */

  /** Sends a message to a chat (the one shown unless named), as if typed there, with any images and files attached; `from` says where it was sent from (a tag under it, a line Claude reads). */
  async send(text: string, ref?: string, images?: NewChatImage[], files?: NewChatFile[], from?: string): Promise<ChatState> {
    const c = this.find(ref);
    return this.say(c, text, await this.attach(c, images), this.attachFiles(c, files), from);
  }

  /** Files to send: checked (or kept, when uploaded), named on the message for the screens and listed for Claude. */
  private attachFiles(c: Chat, files?: NewChatFile[] | null): ChatFile[] {
    return (files ?? []).map((f) => this.files.incoming(f, c.state.folder));
  }

  /** Images to send, kept for the screens and as the content blocks Claude reads. */
  private async attach(c: Chat, images?: NewChatImage[] | null) {
    images ??= [];
    const out: { image: ChatImage; data: string; type: string }[] = [];
    for (const i of images) {
      const { bytes, type, name } = await this.images.incoming(i, c.state.folder);
      out.push({ image: this.images.keep(bytes, type, name), data: bytes.toString("base64"), type });
    }
    return out;
  }

  /**
   * The screens show what was said; Claude gets it after the page context the
   * chat was started with, if any is still waiting. Images go ahead of the
   * text, as the API suggests.
   */
  private say(c: Chat, text: string, images: Awaited<ReturnType<ChatHost["attach"]>> = [], files: ChatFile[] = [], from?: string): ChatState {
    const t = text.trim();
    if (!t && !images.length && !files.length) throw new Error("Say something to send.");
    // A block waiting: words alone answer it (the turn is waiting on it, so a message would only queue behind it); with images or files, it ends and the message goes.
    const waiting = [...c.blocks.values()].at(-1);
    if (waiting && t && !images.length && !files.length) {
      this.settleBlock(c, waiting.block.id, outcomeOf(answerFor(waiting.block, { text: t })));
      return this.stateOf(c);
    }
    this.settleBlocks(c, `${this.who()} sent a message instead.`);
    this.notify(c);
    // The files go to Claude as a list of paths after the words (it reads them with its tools); the screens show them as chips. Where it was sent from goes first, on a line of its own.
    from = from?.trim() || undefined;
    const words = this.context.wrap(this.from.wrap([t, FileStore.trailer(files)].filter(Boolean).join("\n\n"), from), c.context);
    const sent: Said = images.length
      ? [
          ...images.map((i) => ({ type: "image", source: { type: "base64", media_type: i.type as MediaType, data: i.data } })),
          ...(words ? [{ type: "text", text: words }] : []),
        ]
      : words;
    c.context = undefined;
    if (!c.title) this.titleFrom(c, t || (images.length === 1 ? "An image" : images.length ? `${images.length} images` : files.length === 1 ? files[0].name : `${files.length} files`));
    this.save();
    this.push(c, { kind: "you", id: this.nextId(), text: t, images: images.length ? images.map((i) => i.image) : undefined, files: files.length ? files : undefined, ...(from ? { from } : {}) });
    this.set(c, { status: "working", error: undefined });
    if (c.session) c.session.inbox.push(sent);
    else {
      c.early.push(sent);
      void this.startChat(c);
    }
    return this.stateOf(c);
  }

  /** Stop: ends the turn a chat is on. */
  async stop(ref?: string): Promise<ChatState> {
    const c = this.find(ref);
    if (!c.session || c.state.status !== "working") return this.stateOf(c);
    c.stopping = true;
    this.settleAsks(c, `${this.who()} stopped this turn.`);
    this.settleBlocks(c, `${this.who()} stopped this turn.`);
    await c.session.q.interrupt().catch(() => undefined);
    return this.stateOf(c);
  }

  /**
   * New chat: a fresh chat beside the others, in the default folder, which is
   * then shown. With `model` it runs on that, `text` is its first message and
   * `title` names its chip. `context` goes to Claude ahead of the first message
   * without being shown, and `about` names what it's about (an app's "Ask
   * Claude about this"). `folder` puts it somewhere other than the default.
   */
  newChat(o: NewChatOptions = {}): ChatState {
    const was = this.shown();
    // New in a chat nothing's been said in yet stays in it (unless something holds it open elsewhere).
    const spare = this.spares();
    if (!Object.values(o).some((v) => v !== undefined && v !== "") && spare.includes(was)) return this.stateOf(was);
    for (const c of spare) this.drop(c);
    const c = this.addChat(o);
    c.context = o.context?.trim() || undefined;
    this.listChanged();
    // Its session starts with its first message.
    if (o.text?.trim()) return this.say(c, o.text, [], [], o.from);
    return this.stateOf(c);
  }

  /** A chat's chip: that chat is shown, its conversation read in. A chat nothing was said in goes when it's left. */
  select(ref: string): ChatsState {
    const c = this.find(ref);
    if (c.id !== this.current) {
      for (const x of this.spares()) if (x !== c) this.drop(x);
      this.current = c.id;
      this.listChanged();
    }
    void this.loadHistory(c);
    return this.state();
  }

  /** A chip's ×: ends the chat's session and takes it off. Its transcript stays in Claude Code (claude --resume). */
  close(ref?: string): ChatsState {
    const c = this.find(ref);
    const order = [...this.chats.keys()];
    const i = order.indexOf(c.id);
    const wasShown = c.id === this.shown().id;
    this.drop(c);
    if (wasShown) {
      this.current = order[i + 1] ?? order[i - 1] ?? "";
      void this.loadHistory(this.shown());
    }
    this.listChanged();
    return this.state();
  }

  /** What a kept conversation is called: its /rename title, Claude Code's summary or its first message, without a page's context or where it was sent from. */
  private pastTitle = (s: { customTitle?: string; summary?: string; firstPrompt?: string }) => this.from.read(this.context.strip(s.customTitle || s.summary || s.firstPrompt || "")).text;

  /**
   * Past chats: the conversations Claude Code kept on this machine, newest
   * first, the host's own and terminal sessions alike, in the default folder
   * (or every folder, with pastChats "all"; or `folder`'s). Every word of
   * `query` has to be in its title, first message or folder.
   */
  async past(o: { query?: string; folder?: string; limit?: number; offset?: number } = {}): Promise<{ total: number; chats: PastChat[] }> {
    if (this.opts.pastChats === "none") return { total: 0, chats: [] };
    const sdk = (await this.opts.sdk()) as AgentSdk;
    const words = (o.query ?? "").toLowerCase().split(/\s+/).filter(Boolean);
    const open = new Map<string, string>();
    for (const c of this.chats.values()) if (c.state.sessionId) open.set(c.state.sessionId, c.id);
    const dir = o.folder ?? (this.opts.pastChats === "all" ? undefined : this.defaults().folder);
    const found = (await sdk.listSessions(dir ? { dir } : undefined)).filter(
      (s) => s.cwd && words.every((w) => `${s.customTitle ?? ""} ${s.summary ?? ""} ${s.firstPrompt ?? ""} ${s.cwd}`.toLowerCase().includes(w)),
    );
    const from = Math.max(0, o.offset ?? 0);
    return {
      total: found.length,
      chats: found.slice(from, from + (o.limit ?? 50)).map((s) => ({
        sessionId: s.sessionId,
        title: firstLine(this.pastTitle(s), 200) || "Untitled",
        folder: s.cwd!,
        updated: new Date(s.lastModified).toISOString(),
        branch: s.gitBranch,
        chat: open.get(s.sessionId),
      })),
    };
  }

  /**
   * A Past chats row: picks a kept conversation back up as a chat beside the
   * others, in the folder it worked in, which is then shown with the
   * conversation so far. One already open is just shown.
   */
  async load(sessionId: string): Promise<ChatsState> {
    if (this.opts.pastChats === "none") throw new Error("Past chats aren't open here.");
    const opened = () => [...this.chats.values()].find((c) => c.state.sessionId === sessionId);
    if (opened()) return this.select(opened()!.id);
    const sdk = (await this.opts.sdk()) as AgentSdk;
    const info = await sdk.getSessionInfo(sessionId);
    if (!info?.cwd) throw new Error(`No conversation ${sessionId}.`);
    if (!existsSync(info.cwd)) throw new Error(`${info.cwd} isn't there any more, so that conversation can't pick back up.`);
    // Opened meanwhile, by a second click.
    if (opened()) return this.select(opened()!.id);
    for (const x of this.spares()) this.drop(x);
    const d = this.defaults();
    const c = this.makeChat({ id: this.nextId(), sessionId, folder: info.cwd, model: d.model, mode: d.mode });
    this.titleFrom(c, this.pastTitle(info));
    this.chats.set(c.id, c);
    this.current = c.id;
    this.listChanged();
    void this.loadHistory(c);
    return this.state();
  }

  /** Allow, Always allow (Claude Code's suggested rule, or else the whole tool, for the rest of the session) or Deny, in whichever chat asked. */
  answer(id: string, decision: AskDecision): ChatState {
    const c = [...this.chats.values()].find((x) => x.asks.has(id));
    const p = c?.asks.get(id);
    if (!c || !p) throw new Error(`No permission prompt ${id} is waiting.`);
    c.asks.delete(id);
    p.resolve(
      decision === "deny"
        ? { behavior: "deny", message: `${this.who()} said no.` }
        : { behavior: "allow", updatedInput: p.input, updatedPermissions: decision === "always" ? p.suggestions : undefined },
    );
    if (!c.asks.size) this.notify(c);
    this.changed(c);
    return this.stateOf(c);
  }

  /**
   * Answers a waiting block, in whichever chat it's in: with its value (checked
   * against it: a pick in range, an offered choice, a form's required fields),
   * or words. Its call returns, and Claude goes on with the answer.
   */
  reply(id: string, answer: RawAnswer): ChatState {
    const c = [...this.chats.values()].find((x) => x.blocks.has(id));
    const p = c?.blocks.get(id);
    if (!c || !p) throw new Error(`No block ${id} is waiting.`);
    this.settleBlock(c, id, outcomeOf(answerFor(p.block, answer ?? {})));
    return this.stateOf(c);
  }

  /**
   * An app block's page: the ui:// resource its app's MCP server serves (MCP
   * Apps), read through the chat's session, with its policy put first in its
   * head (the spec's defaults and the domains it declared). Only a page a block
   * in this chat asked for, and only while the session is up.
   */
  async appPage(ref: string, app: string, uri: string): Promise<AppPage> {
    const c = this.find(ref);
    if (!uri.startsWith("ui://")) throw new Error(`${uri} isn't an app page's address (ui://…).`);
    const asks = (b?: ChatBlock) => b?.kind === uri && b.app === app;
    if (![...c.blocks.values()].some((p) => asks(p.block)) && !c.state.items.some((i) => i.kind === "tool" && asks(i.block))) throw new Error(`Claude didn't ask for ${uri} in this chat.`);
    const q = c.session?.q;
    if (!q) throw new Error("This chat's session isn't running, so the app's page can't be read.");
    if (!q.readMcpResource) throw new Error("This Claude Code can't read app pages; update @anthropic-ai/claude-agent-sdk.");
    const r = await q.readMcpResource(app, uri);
    const item = r.contents.find((x) => x.uri === uri) ?? r.contents[0];
    const html = item?.text ?? (item?.blob ? Buffer.from(item.blob, "base64").toString("utf8") : undefined);
    if (!html) throw new Error(`${app} sent no page for ${uri}.`);
    const ui = (item._meta?.ui ?? {}) as { csp?: PageCsp; prefersBorder?: boolean };
    return { html: withPolicy(html, ui.csp), prefersBorder: ui.prefersBorder };
  }

  /**
   * A file an app block's page asked for (the bridge's file()): a path the
   * block's props name, or a file in that path's folder or below it (a .gltf's
   * .bin, an .obj's .mtl and textures, the parts a set's sidecar lists). Only
   * for an app block in this chat, waiting or on its row; anything else is
   * refused. Up to 512 MB.
   */
  async blockFile(ref: string, blockId: string, file: string): Promise<FileBytesOut> {
    const c = this.find(ref);
    const block = c.blocks.get(blockId)?.block ?? c.state.items.flatMap((i) => (i.kind === "tool" && i.block?.id === blockId ? [i.block] : []))[0];
    if (!block) throw new Error(`No block ${blockId} in this chat.`);
    if (!block.kind.startsWith("ui://")) throw new Error("Only an app's page reads files.");
    const path = readablePath(file, block.props);
    const st = await stat(path).catch(() => undefined);
    if (!st?.isFile()) throw new Error(`${basename(path)} isn't there.`);
    if (st.size > MAX_FILE_BYTES) throw new Error(`${basename(path)} is ${Math.round(st.size / 1024 / 1024)} MB, over the 512 MB a page reads.`);
    const bytes = await readFile(path);
    return { bytes, type: fileType(path), name: basename(path), size: bytes.length };
  }

  /** Continue in terminal: a chat's conversation in Claude Code in a terminal. The host lets go of it, and picks it back up from the transcript at its next message. */
  terminal(ref?: string): { folder: string; command: string } {
    if (this.opts.terminal === false) throw new Error("Continue in terminal isn't open here.");
    const c = this.find(ref);
    const { folder, sessionId, pickedModel } = c.state;
    const command = `${sessionId ? `claude --resume ${sessionId}` : "claude"}${pickedModel ? ` --model ${pickedModel}` : ""}`;
    if (c.session) {
      this.closeSession(c);
      this.set(c, { status: "off", activity: undefined });
      this.note(c, "Continued in a terminal. Send a message here to pick it back up.");
    }
    // What the terminal adds comes in when it's picked back up.
    if (sessionId) c.stale = true;
    (this.opts.openTerminal ?? openTerminal)(folder, command);
    return { folder, command };
  }

  private setMode(c: Chat, mode: ClaudeMode) {
    this.set(c, { mode });
    this.save();
    void c.session?.q.setPermissionMode(mode).catch((e: Error) => this.note(c, `Couldn't change the mode: ${e.message}`, true));
  }

  /** An alias or id, or "" for Claude Code's default. */
  private setModel(c: Chat, model: string) {
    this.set(c, { pickedModel: model, model: model || undefined });
    this.save();
    void c.session?.q.setModel(model || undefined).catch((e: Error) => this.note(c, `Couldn't change the model: ${e.message}`, true));
  }

  /** A chat's mode, model or name. New chats take the last mode and model picked, unless the app sets their defaults itself; a blank name names it for its first message again. */
  configure(ref: string | undefined, o: ChatSettings): ChatState {
    if (o.mode && !this.allows(o.mode)) throw new Error(`Chats here can't be put in ${o.mode} mode.`);
    const c = this.find(ref);
    if (o.mode) {
      this.setMode(c, o.mode);
      this.picked = { ...this.picked, mode: o.mode };
    }
    if (o.model !== undefined) {
      this.setModel(c, o.model);
      this.picked = { ...this.picked, model: o.model };
    }
    if (o.title !== undefined) {
      c.title = firstLine(o.title, 60) || undefined;
      this.titleFrom(c, c.state.items.find((i) => i.kind === "you")?.text);
      this.changed(c);
    }
    this.save();
    return this.stateOf(c);
  }

  /** The slash commands a chat's session takes, for the box's / menu. Its session starts if it isn't up (typing starts it anyway). */
  async commands(ref?: string): Promise<ChatCommand[]> {
    const c = this.find(ref);
    await this.startChat(c);
    const q = c.session?.q;
    if (q && !c.commands && q.supportedCommands) {
      const list = await q.supportedCommands().catch(() => undefined);
      if (c.session?.q === q && !c.commands) c.commands = list;
    }
    return menuCommands(c.commands ?? [], this.terminalOnly);
  }

  /** The app's defaults changed (its settings): mode and model apply to the chat shown too; a new folder is for new chats, or the shown one if nothing's been said in it. */
  defaultsChanged(patch: { mode?: ClaudeMode; model?: string; folder?: string }) {
    const c = this.shown();
    if (patch.mode && this.allows(patch.mode)) this.setMode(c, patch.mode);
    if (patch.model !== undefined) this.setModel(c, patch.model);
    if (patch.folder && patch.folder !== c.state.folder) {
      if (!this.blank(c)) this.note(c, `New chats work in ${patch.folder}.`);
      else {
        // Its session starts there with its first message.
        this.closeSession(c);
        this.set(c, { folder: patch.folder, status: "off", sessionId: undefined });
        this.save();
      }
    }
  }

  /** An image to draw: a kept id, or a path, file:, data: or http(s) address from a reply. */
  async image(ref: string, folder?: string, thumb?: ThumbSize): Promise<ImageBytesOut> {
    return this.images.read(ref, folder, thumb);
  }

  /** The app is quitting: every chat's session ends. They pick back up at the next start. */
  end() {
    this.chats.forEach((c) => this.closeSession(c));
  }

  /** Stops the host's timers and every session: for a host that's being replaced. */
  dispose() {
    this.end();
    this.timers.forEach((t) => clearTimeout(t as ReturnType<typeof setTimeout>));
    this.listeners.clear();
  }

  /** Claude Code signed in: every chat that had stopped is ready again, and picks its conversation back up at its next message. */
  restartStopped() {
    for (const c of this.chats.values()) if (c.state.status === "error" && !c.session) this.set(c, { status: "off", error: undefined });
  }

  /** Claude Code signed out: every session goes, so a chat's next turn starts a fresh one with whatever sign-in there is then. */
  dropSessions() {
    for (const c of this.chats.values())
      if (c.session) {
        this.closeSession(c);
        this.set(c, { status: "off" });
      }
  }

  private notify(c: Chat, n?: ChatNotice) {
    this.opts.notify?.(n, this.stateOf(c), this.chats.size);
  }
}
