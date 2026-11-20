import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type RefObject } from "react";
import type { ChatAsk, ChatBlock, ChatCommand, ChatFile, ChatItem, ChatJob, ChatsState, ChatState, ClaudeMode, NewChatFile } from "../types.js";
import { chatWord, MODES, needsSignIn, runningJobs, toolLabel } from "../words.js";
import { BlockRow, BlocksContext } from "./blocks.js";
import { useClaude, useStore, useTransport, useUi, type ClaudeUi, type Where } from "./context.js";
import { carriesFiles, Lightbox, PicsContext, prepare, Thumb, type Pending, type Pic } from "./images.js";
import { MenuButton } from "./menu.js";
import { picksIn, picsIn } from "./picks.js";
import { ChevronDown, HistoryIcon, XIcon } from "./primitives.js";
import { PathButton, Prose } from "./prose.js";

// One chat: its conversation (what's said, each tool call, asks, blocks to
// answer), the reply being written, and the box to write in, with images and
// files pasted, dropped or picked.

/** A paperclip: the attach button. */
const ClipIcon = ({ size = 16 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M21 12.5 12.2 21.3a5.5 5.5 0 0 1-7.8-7.8l9.2-9.2a3.5 3.5 0 0 1 5 5l-9.2 9.2a1.5 1.5 0 0 1-2.1-2.1L15.6 8" />
  </svg>
);

/** "1.2 MB", "340 KB". */
const sizeWord = (n: number) => (n >= 1048576 ? `${(n / 1048576).toFixed(n >= 10485760 ? 0 : 1)} MB` : n >= 1024 ? `${Math.round(n / 1024)} KB` : `${n} bytes`);

/** The files on a message that was sent: chips that open them (through the app, as a path in a reply does). */
function FileChips({ files, ui }: { files: ChatFile[]; ui: ClaudeUi }) {
  return (
    <div className="ck-files" aria-label="Files sent">
      {files.map((f, i) =>
        ui.openPath || ui.openFolder ? (
          <PathButton key={i} text={f.name} file={f.path} ui={ui} />
        ) : (
          <span key={i} className="ck-path" title={f.path}>
            {f.name}
          </span>
        ),
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ rows */

function ToolRow({ item }: { item: Extract<ChatItem, { kind: "tool" }> }) {
  const [open, setOpen] = useState(false);
  return (
    <div className={`ck-tool is-${item.state}`}>
      <button type="button" className="ck-toolhead" aria-expanded={item.result ? open : undefined} disabled={!item.result} onClick={() => setOpen(!open)}>
        <span className="ck-tooldot" />
        <span className="ck-toolname">{toolLabel(item.name)}</span>
        {item.detail && <span className="ck-tooldetail">{item.detail}</span>}
      </button>
      {open && item.result && <pre className="ck-result">{item.result}</pre>}
      {item.images && <Thumbs pics={item.images} />}
    </div>
  );
}

/** A row's images: the person's on their message, or what a tool handed back. */
const Thumbs = ({ pics }: { pics: NonNullable<Extract<ChatItem, { kind: "you" }>["images"]> }) => (
  <div className="ck-pics">
    {pics.map((p, i) => (
      <Thumb key={`${p.id}:${i}`} pic={{ ref: p.id, name: p.name }} />
    ))}
  </div>
);

/** The fields a row draws from. */
const DRAWN = ["kind", "id", "text", "name", "detail", "state", "result", "error"] as const;

/** Two rows that draw the same: a chat's change brings new copies of the rows it carries, so they're compared by what they show. */
function sameItem(a: ChatItem, b: ChatItem): boolean {
  if (a === b) return true;
  const x = a as Partial<Record<(typeof DRAWN)[number], unknown>> & { images?: { id: string }[]; files?: { path: string }[] };
  const y = b as typeof x;
  if (DRAWN.some((k) => x[k] !== y[k])) return false;
  const xb = (a as { block?: ChatBlock }).block;
  const yb = (b as { block?: ChatBlock }).block;
  if (xb !== yb && (!xb || !yb || xb.id !== yb.id || xb.state !== yb.state || xb.reason !== yb.reason || xb.answer?.said !== yb.answer?.said || xb.answer?.text !== yb.answer?.text)) return false;
  const xi = x.images ?? [];
  const yi = y.images ?? [];
  const xf = x.files ?? [];
  const yf = y.files ?? [];
  return xi.length === yi.length && xi.every((p, i) => p.id === yi[i].id) && xf.length === yf.length && xf.every((f, i) => f.path === yf[i].path);
}

/** A row of the conversation, drawn again only when what it shows changes. */
const Row = memo(
  function Row({ item }: { item: ChatItem }) {
    const ui = useUi();
    if (item.kind === "you" && (item.images || item.files))
      return (
        <div className="ck-mine">
          {item.images && <Thumbs pics={item.images} />}
          {item.files && <FileChips files={item.files} ui={ui} />}
          {item.text && <div className="ck-you">{item.text}</div>}
        </div>
      );
    if (item.kind === "you") return <div className="ck-you">{item.text}</div>;
    if (item.kind === "claude") return <Prose text={item.text} />;
    if (item.kind === "tool" && item.block) return <BlockRow item={item as Extract<ChatItem, { kind: "tool" }> & { block: ChatBlock }} />;
    if (item.kind === "tool") return <ToolRow item={item} />;
    return <p className={`ck-note${item.error ? " is-error" : ""}`}>{item.text}</p>;
  },
  (prev, next) => sameItem(prev.item, next.item),
);

function AskCard({ ask }: { ask: ChatAsk }) {
  const t = useTransport();
  const ui = useUi();
  const Button = ui.c.Button;
  const answer = (d: "allow" | "always" | "deny") => void t.answer(ask.id, d).catch((e) => ui.toast(ui.errorText(e)));
  return (
    <div className="ck-ask" role="group" aria-label={ask.title}>
      <span className="ck-callout">{ask.title}</span>
      {ask.sub && <span className="ck-caption ck-ink2">{ask.sub}</span>}
      {ask.detail && <pre className="ck-result">{ask.detail}</pre>}
      <div className="ck-row ck-wrap ck-gap">
        <Button variant="primary" size="sm" onClick={() => answer("allow")}>
          Allow
        </Button>
        {ask.canAlways && (
          <button type="button" className="ck-chip" onClick={() => answer("always")}>
            Always allow
          </button>
        )}
        <button type="button" className="ck-chip" onClick={() => answer("deny")}>
          Deny
        </button>
      </div>
    </div>
  );
}

/* ----------------------------------------------------------------- chats */

// The chat whose name is being typed (a chip's double-click, ⋯ › Rename chat): its chip, or a chat page's heading, is the field.
let renaming: string | undefined;
const renamingSubs = new Set<() => void>();

/** Starts typing a chat's name in place of it (or stops, with none). */
export function renameChat(id?: string) {
  renaming = id;
  renamingSubs.forEach((f) => f());
}

/** The chat whose name is being typed, if any. */
export const useRenaming = () =>
  useSyncExternalStore(
    (cb) => (renamingSubs.add(cb), () => void renamingSubs.delete(cb)),
    () => renaming,
  );

/** A chat's name being typed in place of it: Enter or leaving the field keeps it, Escape doesn't; a blank name names it for its first message again. */
export function NameField({ chat, className }: { chat: ChatState; className?: string }) {
  const t = useTransport();
  const ui = useUi();
  const ended = useRef(false);
  const finish = (value: string | null) => {
    if (ended.current) return;
    ended.current = true;
    if (value !== null && value.trim() !== chat.title) void t.configure(chat.id, { title: value.trim() }).catch((e) => ui.toast(ui.errorText(e)));
    renameChat(undefined);
  };
  return (
    <input
      className={["ck-name", className].filter(Boolean).join(" ")}
      aria-label="Chat name"
      defaultValue={chat.title}
      autoFocus
      spellCheck={false}
      maxLength={60}
      onFocus={(e) => e.currentTarget.select()}
      onBlur={(e) => finish(e.currentTarget.value)}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          e.currentTarget.blur();
        } else if (e.key === "Escape") {
          e.preventDefault();
          e.stopPropagation();
          finish(null);
        }
      }}
    />
  );
}

/** A chip per chat: a click shows it, its × or a middle click closes it. A dot says it's working, or waiting for an answer. */
export function ChatStrip({ list }: { list: ChatsState }) {
  const t = useTransport();
  const strip = useRef<HTMLDivElement>(null);
  const named = useRenaming();
  // A block, not an expression: newer Chromes answer scrollIntoView with a promise, and React would call it as the effect's cleanup.
  useEffect(() => {
    strip.current?.querySelector(".is-on")?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [list.current, list.chats.length]);
  return (
    <div ref={strip} className="ck-chats" role="tablist" aria-label="Chats" onWheel={(e) => (e.currentTarget.scrollLeft += e.deltaY)}>
      {list.chats.map((c) => {
        const on = c.id === list.current;
        const dot = c.asks.length || c.status === "error" ? "alert" : c.status === "working" || runningJobs(c) ? "working" : undefined;
        if (c.id === named)
          return (
            <div key={c.id} className={`ck-chat is-naming${on ? " is-on" : ""}`}>
              <NameField chat={c} />
            </div>
          );
        return (
          <div key={c.id} className={`ck-chat${on ? " is-on" : ""}`}>
            <button
              type="button"
              role="tab"
              aria-selected={on}
              className="ck-chatbtn"
              title={`${c.title} · ${chatWord(c).label} · Double-click to rename`}
              onClick={() => !on && void t.select(c.id)}
              onDoubleClick={() => renameChat(c.id)}
              onAuxClick={(e) => e.button === 1 && void t.close(c.id)}
            >
              {dot && <span className={`ck-chatdot is-${dot}`} />}
              <span className="ck-chattitle">{c.title}</span>
            </button>
            <button type="button" className="ck-chatx" aria-label={`Close ${c.title}`} onClick={() => void t.close(c.id)}>
              <XIcon size={11} />
            </button>
          </div>
        );
      })}
    </div>
  );
}

// What was being typed in each chat, and the images and files waiting to go with it, survive closing the panel and switching chats.
const drafts = new Map<string, string>();
const waiting = new Map<string, Pending[]>();
const waitingFiles = new Map<string, PendingFile[]>();
/** Images on one message, at most; the API takes more, but each then has to be smaller. */
const MAX_PICS = 10;
/** Files on one message, at most. */
const MAX_FILES = 20;
/** A file without a path on this machine (a browser's drop) is uploaded; over this it's turned away. */
const MAX_UPLOAD = 50 * 1024 * 1024;

/** A file waiting to go with the message: by its path on this machine when the transport can say it, else the file itself, to upload. */
interface PendingFile {
  key: string;
  name: string;
  size: number;
  path?: string;
  file?: File;
}

/** A closed chat's draft and waiting images and files go with it. */
export function forgetClosed(open: string[]) {
  const keep = new Set(open);
  for (const id of drafts.keys()) if (!keep.has(id)) drafts.delete(id);
  for (const [id, pics] of waiting)
    if (!keep.has(id)) {
      pics.forEach((p) => URL.revokeObjectURL(p.url));
      waiting.delete(id);
    }
  for (const id of waitingFiles.keys()) if (!keep.has(id)) waitingFiles.delete(id);
}

/** A file's bytes as base64, to upload. */
const toBase64 = async (f: File) => {
  const bytes = new Uint8Array(await f.arrayBuffer());
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
};

/** A job's kind in a word. */
const JOB_KINDS: Record<string, string> = { local_bash: "Command", local_agent: "Agent", remote_agent: "Cloud agent", local_workflow: "Workflow", monitor: "Monitor", mcp_task: "Tool" };
const jobKind = (j: ChatJob) => (j.agent === "main-session" ? "Session" : (JOB_KINDS[j.kind] ?? "Job"));

/** "12s", "3m 05s", "1h 02m". */
function elapsed(ms: number) {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, "0")}s`;
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m`;
}

const JOB_ENDED = { completed: "Done", failed: "Failed", stopped: "Stopped" } as const;

/**
 * The background jobs a chat is waiting on (a command, an agent or a workflow Claude started and carried on past),
 * just above the box: a row each with how long it's been going and what it's on, and how it went for a moment
 * after it ends. Claude picks the work back up by itself when one does.
 */
function JobsBar({ jobs }: { jobs: ChatJob[] }) {
  const [now, setNow] = useState(() => Date.now());
  const [all, setAll] = useState(false);
  const running = jobs.filter((j) => !j.ended).length;
  useEffect(() => {
    if (!running) return;
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [running > 0]);
  const shown = all || jobs.length <= 3 ? jobs : jobs.slice(0, 2);
  return (
    <div className="ck-jobs" role="status" aria-label="Background jobs">
      <div className="ck-jobs__head">
        <span className="ck-jobs__title">{running ? `Waiting on ${running === 1 ? "a background job" : `${running} background jobs`}` : jobs.length === 1 ? "Background job ended" : "Background jobs ended"}</span>
        {jobs.length > 3 && (
          <button type="button" className="ck-jobs__more" aria-expanded={all} onClick={() => setAll(!all)}>
            {all ? "Fewer" : `All ${jobs.length}`}
          </button>
        )}
      </div>
      {shown.map((j) => (
        <div key={j.id} className={`ck-job${j.ended ? ` is-${j.ended}` : ""}`}>
          <span className="ck-job__dot" aria-hidden="true" />
          <span className="ck-job__kind">{jobKind(j)}</span>
          <span className="ck-job__title" title={j.title}>
            {j.title}
          </span>
          <span className="ck-job__time">{j.ended ? JOB_ENDED[j.ended] : elapsed(now - j.since)}</span>
          {j.line && (
            <span className="ck-job__line" title={j.line}>
              {j.line}
            </span>
          )}
        </div>
      ))}
    </div>
  );
}

/** Each chat's slash commands as its session last listed them, so the / menu opens with them while it asks again. */
const commandLists = new Map<string, ChatCommand[]>();

/**
 * The commands for what's typed after the slash: a name it starts, then an alias it starts, then one with a word it starts, then
 * one it's in, then one whose description has it; shorter names first. Nothing typed: the person's own (skills,
 * plugins) before Claude Code's, each by name.
 */
function matchCommands(all: ChatCommand[], typed: string): ChatCommand[] {
  const q = typed.toLowerCase();
  if (!q) return [...all].sort((a, b) => Number(Boolean(a.builtin)) - Number(Boolean(b.builtin)) || a.name.localeCompare(b.name));
  const rank = (c: ChatCommand) => {
    const name = c.name.toLowerCase();
    const names = [name, ...(c.aliases ?? []).map((n) => n.toLowerCase())];
    if (name.startsWith(q)) return 0;
    if (names.some((n) => n.startsWith(q))) return 1;
    if (names.some((n) => n.split(/[:\-_]/).some((w) => w.startsWith(q)))) return 2;
    if (names.some((n) => n.includes(q))) return 3;
    return c.description.toLowerCase().includes(q) ? 4 : -1;
  };
  return all
    .map((c) => ({ c, r: rank(c) }))
    .filter((x) => x.r >= 0)
    .sort((a, b) => a.r - b.r || a.c.name.length - b.c.name.length || a.c.name.localeCompare(b.c.name))
    .map((x) => x.c);
}

/** The / menu above the box: the chat's slash commands for what's typed; a click (or Tab, Enter) puts one in the box. */
function SlashMenu({ list, at, loading, onPick, onAt }: { list: ChatCommand[]; at: number; loading: boolean; onPick: (c: ChatCommand) => void; onAt: (i: number) => void }) {
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    box.current?.querySelector(".is-at")?.scrollIntoView({ block: "nearest" });
  }, [at, list]);
  return (
    <div ref={box} id="ck-slash" className="ck-slash" role="listbox" aria-label="Slash commands">
      {list.map((c, i) => (
        <button
          key={c.name}
          id={`ck-slash-${i}`}
          type="button"
          role="option"
          aria-selected={i === at}
          className={`ck-slash__row${i === at ? " is-at" : ""}`}
          // The box keeps the focus, so typing goes on.
          onMouseDown={(e) => e.preventDefault()}
          onMouseMove={() => i !== at && onAt(i)}
          onClick={() => onPick(c)}
        >
          <span className="ck-slash__name">
            /{c.name}
            {c.hint && <span className="ck-slash__hint"> {c.hint}</span>}
          </span>
          {c.description && <span className="ck-slash__desc">{c.description}</span>}
        </button>
      ))}
      {!list.length && <p className="ck-slash__none">{loading ? "Loading commands…" : "No command like that"}</p>}
    </div>
  );
}

/** How often a chat on screen says so (the host lets the session of one unseen for 5 minutes go). */
const SEEN_EVERY_MS = 60_000;

/**
 * The reply being written and the line saying what the turn is doing. Only
 * this redraws as a reply streams in; the conversation above it doesn't.
 */
/** What a running tool is doing, in plain words, for a conversational chat. */
function plainly(tool: string, detail?: string): string {
  if (/^mcp__/.test(tool)) return "Updating things in the app";
  if (/^(Read|Glob|Grep|LS|NotebookRead)$/.test(tool)) return "Looking through the app";
  if (/^(Edit|Write|MultiEdit|NotebookEdit)$/.test(tool)) return "Making the change";
  if (/^(Bash|PowerShell)$/.test(tool)) return /\b(test|typecheck|tsc|build|check)\b/.test(detail ?? "") ? "Checking it works" : "Running something";
  if (/^Web(Fetch|Search)$/.test(tool)) return "Looking it up";
  if (tool === "TodoWrite") return "Planning it out";
  return "Working on it";
}

function Live({ chat, log, pinned }: { chat: ChatState; log: RefObject<HTMLDivElement | null>; pinned: RefObject<boolean> }) {
  const stream = useClaude((s) => s.streams[chat.id] ?? "");
  const quiet = useClaude((s) => s.chats?.verbosity === "conversational");
  useLayoutEffect(() => {
    const el = log.current;
    if (el && pinned.current) el.scrollTop = el.scrollHeight;
  }, [stream]);
  const last = chat.items.at(-1);
  // Waiting on the person (an ask, a block) isn't thinking.
  const working = (chat.status === "working" || chat.status === "starting") && !chat.blocks?.length;
  return (
    <>
      {stream && (
        <div className="is-streaming">
          <Prose text={stream} />
        </div>
      )}
      {working && !stream && !chat.asks.length && quiet && <p className="ck-thinking">{chat.status === "starting" ? "Starting…" : last?.kind === "tool" && last.state === "running" ? `${plainly(last.name, last.detail)}…` : `${chat.activity ?? "Thinking"}…`}</p>}
      {working && !stream && !chat.asks.length && !quiet && !(last?.kind === "tool" && last.state === "running") && <p className="ck-thinking">{chat.status === "starting" ? "Starting Claude Code…" : `${chat.activity ?? "Thinking"}…`}</p>}
    </>
  );
}

/**
 * One chat's conversation and its box, in the panel (`where` "panel", where Esc hides it through `onHide`) or in
 * a page or tab of its own.
 */
export function ChatView({ chat, where = "panel", onHide }: { chat: ChatState; where?: Where; onHide?: () => void }) {
  const t = useTransport();
  const ui = useUi();
  const store = useStore();
  // What the host lets chats do (ChatLimits): only its modes are offered, and Past chats only when it lists them.
  const limits = useClaude((s) => s.chats?.limits);
  const intro = useClaude((s) => s.chats?.intro);
  const modes = MODES.filter((m) => !limits?.modes || limits.modes.includes(m.value));
  // A conversational chat (the host's verbosity) shows what's said and errors, not every tool row.
  const verbosity = useClaude((s) => s.chats?.verbosity);
  const { Button, SegmentedControl, Tooltip } = ui.c;
  const [text, setText] = useState(drafts.get(chat.id) ?? "");
  const [pics, setPics] = useState<Pending[]>(waiting.get(chat.id) ?? []);
  const [files, setFiles] = useState<PendingFile[]>(waitingFiles.get(chat.id) ?? []);
  const [dropping, setDropping] = useState(false);
  // The lightbox: on the chat's images, or on a carousel's set, with its Pick (`onPick`; `toggle`, a block's several to pick).
  const [box, setBox] = useState<{ pics: Pic[]; at: number; onPick?: (i: number) => void; picked?: readonly number[]; toggle?: boolean }>();
  const [signing, setSigning] = useState(false);
  const log = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const picker = useRef<HTMLInputElement>(null);
  const pinned = useRef(true);
  const warmed = useRef(false);
  // The / menu: open while the box holds only a slash and a name, until Escape (or a pick) closes it.
  const [commands, setCommands] = useState<ChatCommand[] | undefined>(commandLists.get(chat.id));
  const [loadingCommands, setLoadingCommands] = useState(false);
  const [slashOff, setSlashOff] = useState(false);
  const [slashAt, setSlashAt] = useState(0);
  const typed = t.commands && !slashOff ? /^\/(\S*)$/.exec(text)?.[1] : undefined;
  const slashing = typed !== undefined;
  const matches = useMemo(() => (typed !== undefined ? matchCommands(commands ?? [], typed) : []), [slashing, commands, typed]);

  const { items, asks, mode } = chat;
  const working = chat.status === "working" || chat.status === "starting";
  const ready = Boolean(text.trim() || pics.length || files.length);
  const toastError = (e: unknown) => ui.toast(ui.errorText(e));

  useEffect(() => {
    if (text) drafts.set(chat.id, text);
    else drafts.delete(chat.id);
    const el = input.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 168)}px`;
  }, [text]);

  useEffect(() => {
    if (pics.length) waiting.set(chat.id, pics);
    else waiting.delete(chat.id);
  }, [pics]);
  useEffect(() => {
    if (files.length) waitingFiles.set(chat.id, files);
    else waitingFiles.delete(chat.id);
  }, [files]);

  // The menu opening asks the chat's session for its commands (starting it if it isn't up); the last list shows meanwhile.
  useEffect(() => {
    if (!slashing || !t.commands) return;
    let live = true;
    setLoadingCommands(true);
    t.commands(chat.id).then(
      (list) => {
        commandLists.set(chat.id, list);
        if (live) setCommands(list);
      },
      () => undefined,
    ).finally(() => live && setLoadingCommands(false));
    return () => void (live = false);
  }, [slashing, chat.id]);
  useEffect(() => setSlashAt(0), [typed]);

  /** A command from the menu into the box, with a space for what goes after it. */
  const pickCommand = (c: ChatCommand) => {
    setText(`/${c.name} `);
    input.current?.focus({ preventScroll: true });
  };

  // A session let go as idle starts again as the next message is typed.
  useEffect(() => void (chat.status === "off" && (warmed.current = false)), [chat.status]);

  // Not on a phone: there focus would raise the keyboard.
  useEffect(() => void (!ui.phone && input.current?.focus({ preventScroll: true })), []);

  // On screen: the host reads the conversation in if it hasn't, and keeps a running session from being let go as
  // unseen. Said as it comes into view (the window shown, a tab back) and once a minute after.
  useEffect(() => {
    const el = log.current;
    let shown = false;
    const check = () => {
      // checkVisibility is newer than some phones' browsers; without it, the page being in view has to do.
      const now = document.visibilityState === "visible" && el?.checkVisibility?.() !== false;
      if (now && !shown) void t.seen(chat.id).catch(() => undefined);
      shown = now;
    };
    check();
    const beat = setInterval(() => ((shown = false), check()), SEEN_EVERY_MS);
    const ro = new ResizeObserver(check);
    if (el) ro.observe(el);
    document.addEventListener("visibilitychange", check);
    return () => {
      clearInterval(beat);
      ro.disconnect();
      document.removeEventListener("visibilitychange", check);
    };
  }, [chat.id]);

  // Stay at the bottom as the conversation grows, unless scrolled up to read (Live does the same as a reply streams).
  const last = items.at(-1);
  useLayoutEffect(() => {
    const el = log.current;
    if (el && pinned.current) el.scrollTop = el.scrollHeight;
  }, [items.length, last, asks.length]);
  // The log appearing (a tab coming into view after being hidden at no size) or shrinking (a phone's keyboard
  // rising, the panel narrowing) keeps the bottom in view too.
  useEffect(() => {
    const el = log.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      if (pinned.current) el.scrollTop = el.scrollHeight;
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Every image in the conversation, in order: the lightbox steps through them.
  const shown = useMemo(
    () =>
      items.flatMap((it): Pic[] =>
        it.kind === "claude" ? picsIn(it.text) : (it.kind === "you" || it.kind === "tool") && it.images ? it.images.map((p) => ({ ref: p.id, name: p.name })) : [],
      ),
    [items],
  );
  // A carousel is to look at: a pick that matters is a pick block (await_feedback), which Claude waits on. The picks
  // an older chat sent from its carousels ("Picked …" messages) still show checked.
  const picks = useMemo(() => picksIn(items), [items]);
  const pictures = useMemo(
    () => ({
      folder: chat.folder,
      open: (p: Pic) => {
        const at = shown.findIndex((x) => x.ref === p.ref);
        setBox(at < 0 ? { pics: [p], at: 0 } : { pics: shown, at });
      },
      openSet: (set: Pic[], at: number, o?: { onPick?: (i: number) => void; picked?: readonly number[]; toggle?: boolean }) => setBox({ pics: set, at, ...o }),
      picks,
    }),
    [shown, chat.folder, chat.id, picks],
  );

  // The blocks waiting in this chat, and how they're answered (the host checks the answer; the row follows its change).
  const waitingBlocks = chat.blocks;
  const blocks = useMemo(
    () => ({ chat: chat.id, waiting: new Set((waitingBlocks ?? []).map((b) => b.id)), answer: t.reply ? (id: string, a: Parameters<NonNullable<typeof t.reply>>[1]) => ((pinned.current = true), t.reply!(id, a).then(() => undefined)) : undefined }),
    [chat.id, waitingBlocks, t],
  );

  /** Pasted, dropped or picked: images join the message as pictures, any other file as a file (by its path here, or uploaded). */
  const attach = async (dropped: File[]) => {
    const images = dropped.filter((f) => f.type.startsWith("image/"));
    const others = dropped.filter((f) => !f.type.startsWith("image/"));
    const room = MAX_PICS - pics.length;
    if (images.length > room) ui.toast(`Up to ${MAX_PICS} images on one message.`);
    for (const f of images.slice(0, Math.max(0, room))) {
      try {
        const p = await prepare(f);
        setPics((all) => [...all, p]);
      } catch (e) {
        toastError(e);
      }
    }
    const roomF = MAX_FILES - files.length;
    if (others.length > roomF) ui.toast(`Up to ${MAX_FILES} files on one message.`);
    for (const f of others.slice(0, Math.max(0, roomF))) {
      const path = t.pathFor?.(f) || undefined;
      if (!path && f.size > MAX_UPLOAD) {
        ui.toast(`${f.name} is ${sizeWord(f.size)}; up to ${sizeWord(MAX_UPLOAD)} can be uploaded here.`);
        continue;
      }
      const key = `${f.name}-${f.size}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
      setFiles((all) => [...all, { key, name: f.name, size: f.size, path, file: path ? undefined : f }]);
    }
    input.current?.focus({ preventScroll: true });
  };

  const unattach = (key: string) =>
    setPics((all) => {
      const p = all.find((x) => x.key === key);
      if (p) URL.revokeObjectURL(p.url);
      return all.filter((x) => x.key !== key);
    });
  const unattachFile = (key: string) => setFiles((all) => all.filter((x) => x.key !== key));

  const send = async () => {
    if (!ready) return;
    pinned.current = true;
    const sending = { text, pics, files };
    setText("");
    setPics([]);
    setFiles([]);
    const images = sending.pics.map(({ data, type, name }) => ({ data, type, name }));
    try {
      const sent: NewChatFile[] = await Promise.all(sending.files.map(async (f) => (f.path ? { path: f.path, name: f.name } : { data: await toBase64(f.file as File), name: f.name, type: f.file?.type })));
      await t.send(sending.text, chat.id, images.length ? images : undefined, sent.length ? sent : undefined);
      sending.pics.forEach((p) => URL.revokeObjectURL(p.url));
    } catch (e) {
      // Nothing went: what was written and attached comes back.
      toastError(e);
      setText((x) => x || sending.text);
      setPics((all) => [...sending.pics, ...all]);
      setFiles((all) => [...sending.files, ...all]);
    }
  };

  /** Claude Code isn't signed in: the app's Sign in, from here. Once it's in, the chat starts again by itself (or with Start again). */
  const signIn = () => {
    if (!ui.signIn) return;
    setSigning(true);
    ui.signIn()
      .then(() => ui.toast("Claude Code signed in"), toastError)
      .finally(() => setSigning(false));
  };

  const hint = MODES.find((m) => m.value === mode)?.hint;
  const setMode = (m: ClaudeMode) => (ui.setMode ? ui.setMode(chat, m, where) : void t.configure(chat.id, { mode: m }).catch(toastError));
  const signedOut = needsSignIn(chat.error);
  const slashOpen = slashing && (matches.length > 0 || loadingCommands || commands !== undefined);

  return (
    <div
      className="ck-view"
      onDragEnter={(e) => carriesFiles(e) && (e.preventDefault(), setDropping(true))}
      onDragOver={(e) => {
        if (!carriesFiles(e)) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = "copy";
      }}
      onDragLeave={(e) => !e.currentTarget.contains(e.relatedTarget as Node | null) && setDropping(false)}
      onDrop={(e) => {
        if (!carriesFiles(e)) return;
        e.preventDefault();
        setDropping(false);
        void attach([...e.dataTransfer.files]);
      }}
    >
      <PicsContext.Provider value={pictures}>
        <BlocksContext.Provider value={blocks}>
          <div
            ref={log}
            className="ck-log"
            onScroll={(e) => {
              const el = e.currentTarget;
              pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
            }}
          >
            {!items.length && chat.status !== "working" && (
              <div className="ck-empty">
                <p className="ck-headline">{chat.about ? `Ask about ${chat.about}.` : "Ask anything, or ask for code."}</p>
                <p className="ck-callout ck-ink3">
                  {intro ?? `Claude Code in ${ui.showPath(chat.folder)}, with your skills, CLAUDE.md files and MCP servers.`}{ui.emptyNote ? ` ${ui.emptyNote}` : ""}
                </p>
                {!chat.about && where === "panel" && limits?.past !== false && (
                  <button type="button" className="ck-chip ck-pastopen" onClick={() => store.setPast(true)}>
                    <HistoryIcon size={13} />
                    Pick up a past chat
                  </button>
                )}
              </div>
            )}
            {(verbosity === "conversational" ? items.filter((it) => it.kind === "you" || it.kind === "claude" || (it.kind === "tool" && it.block) || (it.kind === "note" && it.error)) : items).map((it) => (
              <Row key={it.id} item={it} />
            ))}
            <Live chat={chat} log={log} pinned={pinned} />
            {asks.map((a) => (
              <AskCard key={a.id} ask={a} />
            ))}
            {chat.status === "error" && (
              <div className="ck-ask">
                <span className="ck-callout">Claude Code stopped</span>
                {chat.error && <span className="ck-caption ck-ink2">{chat.error}</span>}
                {signedOut && (ui.phone || !ui.signIn) && (
                  <span className="ck-caption ck-ink3">
                    {ui.phone ? "Sign Claude Code in on the computer it runs on." : "Sign Claude Code in: run claude in a terminal and /login."} This chat starts again once it's in.
                  </span>
                )}
                <div className="ck-row ck-gap">
                  {!ui.phone && signedOut && ui.signIn && (
                    <Button variant="primary" size="sm" disabled={signing} onClick={signIn}>
                      {signing ? "Finishing in your browser…" : "Sign in"}
                    </Button>
                  )}
                  <button type="button" className="ck-chip" onClick={() => void t.start(chat.id).catch(toastError)}>
                    Start again
                  </button>
                </div>
              </div>
            )}
          </div>
        </BlocksContext.Provider>
      </PicsContext.Provider>

      <footer className="ck-foot">
        {chat.jobs && chat.jobs.length > 0 && <JobsBar jobs={chat.jobs} />}
        {(pics.length > 0 || files.length > 0) && (
          <div className="ck-tray" aria-label="Images and files to send">
            {pics.map((p) => (
              <span key={p.key} className="ck-pending" title={p.name}>
                <img src={p.url} alt={p.name} />
                <button type="button" className="ck-unpend" aria-label={`Remove ${p.name}`} onClick={() => unattach(p.key)}>
                  <XIcon size={10} />
                </button>
              </span>
            ))}
            {files.map((f) => (
              <span key={f.key} className="ck-pendfile" title={f.path ?? `${f.name} (uploaded when sent)`}>
                <ClipIcon size={13} />
                <span className="ck-fname">{f.name}</span>
                <span className="ck-fsize">{sizeWord(f.size)}</span>
                <button type="button" className="ck-unpend" aria-label={`Remove ${f.name}`} onClick={() => unattachFile(f.key)}>
                  <XIcon size={10} />
                </button>
              </span>
            ))}
          </div>
        )}
        {slashOpen && <SlashMenu list={matches} at={slashAt} loading={loadingCommands} onPick={pickCommand} onAt={setSlashAt} />}
        <div className={`ck-inputbox${text || pics.length || files.length ? " has-draft" : ""}`}>
        <textarea
          ref={input}
          className="ck-input"
          rows={1}
          role={t.commands ? "combobox" : undefined}
          aria-expanded={t.commands ? slashOpen : undefined}
          aria-controls={slashOpen ? "ck-slash" : undefined}
          aria-activedescendant={slashOpen && matches.length ? `ck-slash-${slashAt}` : undefined}
          placeholder={chat.blocks?.length ? "Answer above, or type your answer…" : chat.about ? `Ask about ${chat.about}…` : "Ask, or ask for code…"}
          aria-label="Message Claude"
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            // Out of a command's name (or the slash gone), Escape's close is forgotten: the next slash opens the menu again.
            if (slashOff && !/^\/\S*$/.test(e.target.value)) setSlashOff(false);
            // Typing to a chat whose session isn't up starts it, so it's warm (or nearly) by the time it's sent.
            if (!warmed.current && chat.status === "off" && e.target.value.trim()) {
              warmed.current = true;
              void t.start(chat.id).catch(() => undefined);
            }
          }}
          onPaste={(e) => {
            // A copied image or file attaches; text that came with it (a spreadsheet's cells) pastes as text instead.
            const pasted = [...e.clipboardData.files];
            if (!pasted.length || e.clipboardData.getData("text/plain").trim()) return;
            e.preventDefault();
            void attach(pasted);
          }}
          // A phone's keyboard has no Shift+Enter, so there Enter is a new line and Send sends.
          enterKeyHint={ui.phone ? "enter" : "send"}
          onKeyDown={(e) => {
            if (slashOpen && !e.nativeEvent.isComposing) {
              const n = matches.length;
              if (n && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
                e.preventDefault();
                return setSlashAt((i) => (i + (e.key === "ArrowDown" ? 1 : n - 1)) % n);
              }
              // Tab, or Enter on a desktop: the command into the box, to add to or send.
              if (n && (e.key === "Tab" || (e.key === "Enter" && !e.shiftKey && !ui.phone)) && !e.ctrlKey && !e.altKey && !e.metaKey) {
                e.preventDefault();
                return pickCommand(matches[Math.min(slashAt, n - 1)]);
              }
              if (e.key === "Escape") {
                e.preventDefault();
                e.stopPropagation();
                return setSlashOff(true);
              }
            }
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing && !ui.phone) {
              e.preventDefault();
              send();
            } else if (e.key === "Escape") {
              e.preventDefault();
              if (working) void t.stop(chat.id);
              else onHide?.();
            }
          }}
        />
        {(text || pics.length > 0 || files.length > 0) && (
          // The message being written, gone: its words and what's attached. Pressed without taking the focus, so a phone's keyboard stays up.
          <button
            type="button"
            className="ck-iconbtn ck-inputclear"
            aria-label="Clear the message"
            title="Clear the message"
            onPointerDown={(e) => e.preventDefault()}
            onClick={() => {
              setText("");
              setPics([]);
              setFiles([]);
              setSlashOff(false);
              input.current?.focus();
            }}
          >
            <XIcon size={12} />
          </button>
        )}
        </div>
        <div className="ck-row ck-send">
          {/* Five words across leave no room for Send on a phone: there the mode is one chip, and its menu the choice. */}
          {ui.phone ? (
            <MenuButton
              className="ck-chip ck-mode"
              label={`How Claude asks: ${MODES.find((m) => m.value === mode)?.label ?? mode}`}
              above
              items={() => modes.map((m) => ({ id: m.value, label: m.label, checked: m.value === mode }))}
              onSelect={(item) => item.id && setMode(item.id as ClaudeMode)}
            >
              {MODES.find((m) => m.value === mode)?.label ?? mode}
              <ChevronDown />
            </MenuButton>
          ) : (
            <SegmentedControl label="How Claude asks" value={mode} onChange={(v) => setMode(v as ClaudeMode)} options={modes.map((m) => ({ value: m.value, label: m.label }))} />
          )}
          <span className="ck-grow" />
          <Tooltip label="Attach images or files" sub="Or paste or drop them here">
            <button type="button" className="ck-iconbtn" aria-label="Attach images or files" onClick={() => picker.current?.click()}>
              <ClipIcon />
            </button>
          </Tooltip>
          <input
            ref={picker}
            type="file"
            multiple
            hidden
            onChange={(e) => {
              void attach([...(e.target.files ?? [])]);
              e.target.value = "";
            }}
          />
          {working && !ready ? (
            <Button variant="glass" size="sm" onClick={() => void t.stop(chat.id)}>
              Stop
            </Button>
          ) : (
            <Button variant="primary" size="sm" disabled={!ready} onClick={send}>
              Send
            </Button>
          )}
        </div>
        {hint && <span className="ck-caption ck-ink3">{hint}</span>}
      </footer>

      {dropping && <div className="ck-drop">Drop images or files to attach them</div>}
      {box && (
        <Lightbox
          pics={box.pics}
          at={box.at}
          folder={chat.folder}
          onClose={() => setBox(undefined)}
          onPick={
            box.onPick
              ? (i) => {
                  box.onPick!(i);
                  // Several to pick: the lightbox stays, its picks following; one: picked, it closes.
                  if (box.toggle) setBox((b) => b && { ...b, picked: b.picked?.includes(i) ? b.picked.filter((x) => x !== i) : [...(b.picked ?? []), i] });
                  else setBox(undefined);
                }
              : undefined
          }
          picked={box.picked}
          toggle={box.toggle}
        />
      )}
    </div>
  );
}
