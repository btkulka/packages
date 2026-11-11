import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { diffItems } from "../patch.js";
import type {
  AskDecision,
  ChatAsk,
  ChatImage,
  ChatItem,
  ChatPatch,
  ChatsPatch,
  ChatsState,
  ChatState,
  ChatStreamDelta,
  ClaudeEvent,
  ClaudeMode,
  ImageBytesOut,
  NewChatImage,
  NewChatOptions,
  PastChat,
  ThumbSize,
} from "../types.js";
import { ImageStore, type ImageTools } from "./images.js";
import { contextWrapper, detailOf, firstLine, MAX_ITEMS, rowMaker } from "./items.js";
import type { AgentSdk, CanUseToolLike, PermissionResultLike, QueryLike, Said, SdkMessage, SdkUserMessage } from "./sdk.js";
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
  /** The app's own MCP servers, beside the person's: an SDK server (createSdkMcpServer), stdio or HTTP. */
  mcpServers?: Value<Record<string, unknown>>;
  /** Anything else for query(), per chat (allowedTools, settingSources, hooks…). The host's own options win over these. */
  queryOptions?: (chat: { id: string; folder: string }) => Record<string, unknown>;
  /** The tag a new chat's page context travels in, ahead of the first message: "app-context". */
  contextTag?: string;
  /** Past chats: only the app's folder's conversations ("folder", the default) or every one on the machine ("all"). */
  pastChats?: "folder" | "all";
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

/** One chat: its conversation, and the session behind it while one is up. */
type Chat = {
  id: string;
  title?: string;
  state: Omit<ChatState, "id" | "title" | "asks">;
  asks: Map<string, Pending>;
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
};

export class ChatHost {
  private readonly chats = new Map<string, Chat>();
  /** The chat shown. */
  private current = "";
  private models: ChatsState["models"] = [];
  private picked: Saved["picked"] = {};
  private readonly listeners = new Set<(e: ClaudeEvent) => void>();
  /** The chats the screens have had whole: a list change sends only the others. */
  private readonly announced = new Set<string>();
  private seq = 0;
  private readonly timers: ReturnType<typeof setTimeout>[] = [];
  private readonly file: string;
  private readonly context: ReturnType<typeof contextWrapper>;
  private readonly rows: ReturnType<typeof rowMaker>;
  readonly images: ImageStore;

  constructor(private readonly opts: ChatHostOptions) {
    this.file = join(opts.dataDir, opts.file ?? "claude-chats.json");
    this.images = new ImageStore(opts.imagesDir ?? join(opts.dataDir, "chat-images"), opts.imageTools);
    this.context = contextWrapper(opts.contextTag ?? "app-context");
    this.rows = rowMaker((s) => this.images.keepBlock(s), this.context.strip);
    const saved = this.readSaved();
    this.picked = saved.picked ?? {};
    const d = this.defaults();
    // A chat saved before chats had their own model ran on the default one.
    for (const c of saved.chats) this.chats.set(c.id, this.makeChat({ ...c, model: c.model ?? d.model, mode: c.mode ?? d.mode }));
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
      mode: o.mode !== undefined ? val(o.mode) : (this.picked?.mode ?? "default"),
    };
  }

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

  private stateOf = (c: Chat): ChatState => ({ id: c.id, title: c.title ?? "New chat", ...c.state, asks: [...c.asks.values()].map((p) => p.ask) });

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
    return { current: now, chats: [...this.chats.values()].map(this.stateOf), models: this.models, streams };
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
    this.emit({ type: "chats", payload: { current: now, ids: [...this.chats.keys()], chats: fresh.map(this.stateOf), models: this.models } satisfies ChatsPatch });
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
    const c = this.makeChat({ id: this.nextId(), title: o.title, about: o.about, folder: o.folder ?? d.folder, model: o.model ?? d.model, mode: d.mode });
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
      if (!c.session || c.state.status !== "ready" || c.asks.size) continue;
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
          this.set(c, { sessionId: m.session_id, model: m.model, mode: m.permissionMode });
          this.save();
        } else if (m.subtype === "status") this.set(c, { activity: m.status === "compacting" ? "Compacting the conversation" : undefined, ...(m.permissionMode ? { mode: m.permissionMode } : {}) });
        else if (m.subtype === "compact_boundary") this.note(c, "Earlier messages were compacted to make room.");
        else if (m.subtype === "api_retry") this.set(c, { activity: `Retrying, attempt ${m.attempt} of ${m.max_retries}` });
        return;
      case "stream_event": {
        if (m.parent_tool_use_id) return;
        const ev = m.event;
        if (ev?.type === "content_block_delta" && ev.delta?.type === "text_delta") this.setStream(c, c.stream + ev.delta.text);
        else if (ev?.type === "message_start") this.setStream(c, "", true);
        return;
      }
      case "assistant": {
        if (m.parent_tool_use_id) return;
        const items = this.rows.assistantItems(m.uuid, m.message?.content, "running");
        if (items.some((i) => i.kind === "claude")) this.setStream(c, "", true);
        // Web search's results come in the same message as its call.
        if (items.length) this.set(c, { items: this.rows.withResults([...c.state.items, ...items], m.message?.content).slice(-MAX_ITEMS) });
        if (m.error) this.note(c, `Claude Code: ${m.error}`, true);
        return;
      }
      case "user":
        if (!m.parent_tool_use_id) this.set(c, { items: this.rows.withResults(c.state.items, m.message?.content) });
        return;
      case "result": {
        // A reply cut off by Stop keeps what it had written.
        if (c.stopping && c.stream.trim()) this.push(c, { kind: "claude", id: this.nextId(), text: c.stream });
        this.setStream(c, "", true);
        c.idleSince = Date.now();
        const queued: number = m.queued_turn_count ?? 0;
        // A stopped turn leaves its tools without results.
        const items = c.state.items.map((i) => (i.kind === "tool" && i.state === "running" ? { ...i, state: "done" as const } : i));
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

  private canUseTool =
    (c: Chat): CanUseToolLike =>
    (tool, input, o) =>
      new Promise((resolve) => {
        const id = o.toolUseID;
        const ask: ChatAsk = {
          id,
          tool,
          title: o.title ?? `Claude wants to use ${tool}`,
          sub: o.description ?? o.decisionReason,
          detail: detailOf(input, 4000),
          canAlways: Boolean(o.suggestions?.length) && !o.suppressAlwaysAllowRule,
        };
        c.asks.set(id, { ask, input, suggestions: o.suggestions, resolve });
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
    const parts = [this.opts.systemPrompt !== undefined ? val(this.opts.systemPrompt) : "", this.opts.imagesNote === false ? "" : (this.opts.imagesNote ?? IMAGES_NOTE)];
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
          allowDangerouslySkipPermissions: true,
          includePartialMessages: true,
          canUseTool: this.canUseTool(c),
          // Its questions come as plain text instead; the chat has no form for them.
          disallowedTools: [...new Set([...((extra.disallowedTools as string[] | undefined) ?? []), "AskUserQuestion"])],
          ...(mcp ? { mcpServers: { ...((extra.mcpServers as Record<string, unknown> | undefined) ?? {}), ...mcp } } : {}),
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
    this.setStream(c, "", true);
    if (resumed && !answered) {
      // The saved conversation couldn't be picked up (its transcript is gone): start a new one with what was sent.
      this.set(c, { sessionId: undefined });
      this.save();
      this.note(c, "Couldn't pick up the last conversation, so this is a new one.");
      c.early = resumed;
      return void this.open(c, true);
    }
    this.set(c, { status: "error", activity: undefined, error: error ?? c.stderr.at(-1) ?? "Claude Code stopped." });
  }

  private settleAsks(c: Chat, message: string) {
    for (const p of c.asks.values()) p.resolve({ behavior: "deny", message });
    c.asks.clear();
  }

  private closeSession(c: Chat) {
    const s = c.session;
    c.session = undefined;
    c.gen++;
    c.starting = undefined;
    this.settleAsks(c, `${this.who()} closed the session.`);
    c.stopping = false;
    this.setStream(c, "", true);
    s?.inbox.close();
    s?.q.close();
  }

  /* --------------------------------------------------------------- actions */

  /** Sends a message to a chat (the one shown unless named), as if typed there, with any images attached. */
  async send(text: string, ref?: string, images?: NewChatImage[]): Promise<ChatState> {
    const c = this.find(ref);
    return this.say(c, text, await this.attach(c, images));
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
  private say(c: Chat, text: string, images: Awaited<ReturnType<ChatHost["attach"]>> = []): ChatState {
    const t = text.trim();
    if (!t && !images.length) throw new Error("Say something to send.");
    this.notify(c);
    const words = this.context.wrap(t, c.context);
    const sent: Said = images.length
      ? [
          ...images.map((i) => ({ type: "image", source: { type: "base64", media_type: i.type as MediaType, data: i.data } })),
          ...(words ? [{ type: "text", text: words }] : []),
        ]
      : words;
    c.context = undefined;
    if (!c.title) this.titleFrom(c, t || (images.length === 1 ? "An image" : `${images.length} images`));
    this.save();
    this.push(c, { kind: "you", id: this.nextId(), text: t, images: images.length ? images.map((i) => i.image) : undefined });
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
    if (o.text?.trim()) return this.say(c, o.text);
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

  /** What a kept conversation is called: its /rename title, Claude Code's summary or its first message, without a page's context. */
  private pastTitle = (s: { customTitle?: string; summary?: string; firstPrompt?: string }) => this.context.strip(s.customTitle || s.summary || s.firstPrompt || "");

  /**
   * Past chats: the conversations Claude Code kept on this machine, newest
   * first, the host's own and terminal sessions alike, in the default folder
   * (or every folder, with pastChats "all"; or `folder`'s). Every word of
   * `query` has to be in its title, first message or folder.
   */
  async past(o: { query?: string; folder?: string; limit?: number; offset?: number } = {}): Promise<{ total: number; chats: PastChat[] }> {
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

  /** Allow, Always allow (Claude Code's suggested rule, for the rest of the session) or Deny, in whichever chat asked. */
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

  /** Continue in terminal: a chat's conversation in Claude Code in a terminal. The host lets go of it, and picks it back up from the transcript at its next message. */
  terminal(ref?: string): { folder: string; command: string } {
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

  /** A chat's mode or model. New chats take the last ones picked, unless the app sets their defaults itself. */
  configure(ref: string | undefined, o: { mode?: ClaudeMode; model?: string }): ChatState {
    const c = this.find(ref);
    if (o.mode) {
      this.setMode(c, o.mode);
      this.picked = { ...this.picked, mode: o.mode };
    }
    if (o.model !== undefined) {
      this.setModel(c, o.model);
      this.picked = { ...this.picked, model: o.model };
    }
    this.save();
    return this.stateOf(c);
  }

  /** The app's defaults changed (its settings): mode and model apply to the chat shown too; a new folder is for new chats, or the shown one if nothing's been said in it. */
  defaultsChanged(patch: { mode?: ClaudeMode; model?: string; folder?: string }) {
    const c = this.shown();
    if (patch.mode) this.setMode(c, patch.mode);
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
