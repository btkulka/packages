import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState, type RefObject } from "react";
import type { ChatAsk, ChatItem, ChatsState, ChatState, ClaudeMode } from "../types.js";
import { chatWord, MODES, needsSignIn, toolLabel } from "../words.js";
import { useClaude, useStore, useTransport, useUi, type Where } from "./context.js";
import { carriesFiles, Lightbox, picsIn, PicsContext, prepare, Thumb, type Pending, type Pic } from "./images.js";
import { MenuButton } from "./menu.js";
import { ChevronDown, HistoryIcon, ImageIcon, XIcon } from "./primitives.js";
import { Prose } from "./prose.js";

// One chat: its conversation (what's said, each tool call, asks), the reply
// being written, and the box to write in, with images pasted, dropped or picked.

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
  const x = a as Partial<Record<(typeof DRAWN)[number], unknown>> & { images?: { id: string }[] };
  const y = b as typeof x;
  if (DRAWN.some((k) => x[k] !== y[k])) return false;
  const xi = x.images ?? [];
  const yi = y.images ?? [];
  return xi.length === yi.length && xi.every((p, i) => p.id === yi[i].id);
}

/** A row of the conversation, drawn again only when what it shows changes. */
const Row = memo(
  function Row({ item }: { item: ChatItem }) {
    if (item.kind === "you" && item.images)
      return (
        <div className="ck-mine">
          <Thumbs pics={item.images} />
          {item.text && <div className="ck-you">{item.text}</div>}
        </div>
      );
    if (item.kind === "you") return <div className="ck-you">{item.text}</div>;
    if (item.kind === "claude") return <Prose text={item.text} />;
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

/** A chip per chat: a click shows it, its × or a middle click closes it. A dot says it's working, or waiting for an answer. */
export function ChatStrip({ list }: { list: ChatsState }) {
  const t = useTransport();
  const strip = useRef<HTMLDivElement>(null);
  // A block, not an expression: newer Chromes answer scrollIntoView with a promise, and React would call it as the effect's cleanup.
  useEffect(() => {
    strip.current?.querySelector(".is-on")?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [list.current, list.chats.length]);
  return (
    <div ref={strip} className="ck-chats" role="tablist" aria-label="Chats" onWheel={(e) => (e.currentTarget.scrollLeft += e.deltaY)}>
      {list.chats.map((c) => {
        const on = c.id === list.current;
        const dot = c.asks.length || c.status === "error" ? "alert" : c.status === "working" ? "working" : undefined;
        return (
          <div key={c.id} className={`ck-chat${on ? " is-on" : ""}`}>
            <button
              type="button"
              role="tab"
              aria-selected={on}
              className="ck-chatbtn"
              title={`${c.title} · ${chatWord(c).label}`}
              onClick={() => !on && void t.select(c.id)}
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

// What was being typed in each chat, and the images waiting to go with it, survive closing the panel and switching chats.
const drafts = new Map<string, string>();
const waiting = new Map<string, Pending[]>();
/** Images on one message, at most; the API takes more, but each then has to be smaller. */
const MAX_PICS = 10;

/** A closed chat's draft and waiting images go with it. */
export function forgetClosed(open: string[]) {
  const keep = new Set(open);
  for (const id of drafts.keys()) if (!keep.has(id)) drafts.delete(id);
  for (const [id, pics] of waiting)
    if (!keep.has(id)) {
      pics.forEach((p) => URL.revokeObjectURL(p.url));
      waiting.delete(id);
    }
}

/** How often a chat on screen says so (the host lets the session of one unseen for 5 minutes go). */
const SEEN_EVERY_MS = 60_000;

/**
 * The reply being written and the line saying what the turn is doing. Only
 * this redraws as a reply streams in; the conversation above it doesn't.
 */
function Live({ chat, log, pinned }: { chat: ChatState; log: RefObject<HTMLDivElement | null>; pinned: RefObject<boolean> }) {
  const stream = useClaude((s) => s.streams[chat.id] ?? "");
  useLayoutEffect(() => {
    const el = log.current;
    if (el && pinned.current) el.scrollTop = el.scrollHeight;
  }, [stream]);
  const last = chat.items.at(-1);
  const working = chat.status === "working" || chat.status === "starting";
  return (
    <>
      {stream && (
        <div className="is-streaming">
          <Prose text={stream} />
        </div>
      )}
      {working && !stream && !chat.asks.length && !(last?.kind === "tool" && last.state === "running") && <p className="ck-thinking">{chat.status === "starting" ? "Starting Claude Code…" : `${chat.activity ?? "Thinking"}…`}</p>}
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
  const { Button, SegmentedControl, Tooltip } = ui.c;
  const [text, setText] = useState(drafts.get(chat.id) ?? "");
  const [pics, setPics] = useState<Pending[]>(waiting.get(chat.id) ?? []);
  const [dropping, setDropping] = useState(false);
  const [box, setBox] = useState<{ pics: Pic[]; at: number }>();
  const [signing, setSigning] = useState(false);
  const log = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const picker = useRef<HTMLInputElement>(null);
  const pinned = useRef(true);
  const warmed = useRef(false);

  const { items, asks, mode } = chat;
  const working = chat.status === "working" || chat.status === "starting";
  const ready = Boolean(text.trim() || pics.length);
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
  const pictures = useMemo(
    () => ({
      folder: chat.folder,
      open: (p: Pic) => {
        const at = shown.findIndex((x) => x.ref === p.ref);
        setBox(at < 0 ? { pics: [p], at: 0 } : { pics: shown, at });
      },
    }),
    [shown, chat.folder],
  );

  /** Pasted, dropped or picked: images join the message (ready to send), anything else is turned away. */
  const attach = async (files: File[]) => {
    const images = files.filter((f) => f.type.startsWith("image/"));
    if (images.length < files.length) ui.toast(images.length ? "Only the images were attached." : "Only images can be attached here.");
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
    input.current?.focus({ preventScroll: true });
  };

  const unattach = (key: string) =>
    setPics((all) => {
      const p = all.find((x) => x.key === key);
      if (p) URL.revokeObjectURL(p.url);
      return all.filter((x) => x.key !== key);
    });

  const send = () => {
    if (!ready) return;
    pinned.current = true;
    const sending = { text, pics };
    setText("");
    setPics([]);
    const images = sending.pics.map(({ data, type, name }) => ({ data, type, name }));
    t.send(sending.text, chat.id, images.length ? images : undefined).then(
      () => sending.pics.forEach((p) => URL.revokeObjectURL(p.url)),
      (e) => {
        // Nothing went: what was written and attached comes back.
        toastError(e);
        setText((x) => x || sending.text);
        setPics((all) => [...sending.pics, ...all]);
      },
    );
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
                Claude Code in {ui.showPath(chat.folder)}, with your skills, CLAUDE.md files and MCP servers.{ui.emptyNote ? ` ${ui.emptyNote}` : ""}
              </p>
              {!chat.about && where === "panel" && (
                <button type="button" className="ck-chip ck-pastopen" onClick={() => store.setPast(true)}>
                  <HistoryIcon size={13} />
                  Pick up a past chat
                </button>
              )}
            </div>
          )}
          {items.map((it) => (
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
      </PicsContext.Provider>

      <footer className="ck-foot">
        {pics.length > 0 && (
          <div className="ck-tray" aria-label="Images to send">
            {pics.map((p) => (
              <span key={p.key} className="ck-pending" title={p.name}>
                <img src={p.url} alt={p.name} />
                <button type="button" className="ck-unpend" aria-label={`Remove ${p.name}`} onClick={() => unattach(p.key)}>
                  <XIcon size={10} />
                </button>
              </span>
            ))}
          </div>
        )}
        <textarea
          ref={input}
          className="ck-input"
          rows={1}
          placeholder={chat.about ? `Ask about ${chat.about}…` : "Ask, or ask for code…"}
          aria-label="Message Claude"
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            // Typing to a chat whose session isn't up starts it, so it's warm (or nearly) by the time it's sent.
            if (!warmed.current && chat.status === "off" && e.target.value.trim()) {
              warmed.current = true;
              void t.start(chat.id).catch(() => undefined);
            }
          }}
          onPaste={(e) => {
            // A copied image attaches; text that came with it (a spreadsheet's cells) pastes as text instead.
            const files = [...e.clipboardData.files].filter((f) => f.type.startsWith("image/"));
            if (!files.length || e.clipboardData.getData("text/plain").trim()) return;
            e.preventDefault();
            void attach(files);
          }}
          // A phone's keyboard has no Shift+Enter, so there Enter is a new line and Send sends.
          enterKeyHint={ui.phone ? "enter" : "send"}
          onKeyDown={(e) => {
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
        <div className="ck-row ck-send">
          {/* Five words across leave no room for Send on a phone: there the mode is one chip, and its menu the choice. */}
          {ui.phone ? (
            <MenuButton
              className="ck-chip ck-mode"
              label={`How Claude asks: ${MODES.find((m) => m.value === mode)?.label ?? mode}`}
              above
              items={() => MODES.map((m) => ({ id: m.value, label: m.label, checked: m.value === mode }))}
              onSelect={(item) => item.id && setMode(item.id as ClaudeMode)}
            >
              {MODES.find((m) => m.value === mode)?.label ?? mode}
              <ChevronDown />
            </MenuButton>
          ) : (
            <SegmentedControl label="How Claude asks" value={mode} onChange={(v) => setMode(v as ClaudeMode)} options={MODES.map((m) => ({ value: m.value, label: m.label }))} />
          )}
          <span className="ck-grow" />
          <Tooltip label="Attach images" sub="Or paste or drop them here">
            <button type="button" className="ck-iconbtn" aria-label="Attach images" onClick={() => picker.current?.click()}>
              <ImageIcon />
            </button>
          </Tooltip>
          <input
            ref={picker}
            type="file"
            accept="image/*"
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

      {dropping && <div className="ck-drop">Drop images to attach them</div>}
      {box && <Lightbox pics={box.pics} at={box.at} folder={chat.folder} onClose={() => setBox(undefined)} />}
    </div>
  );
}
