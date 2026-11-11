import { useEffect, useRef, type ReactNode } from "react";
import type { ChatsState, ChatState } from "../types.js";
import { chatWord, modelName } from "../words.js";
import { useClaude, useStore, useTransport, useUi, type ClaudeUi, type Where } from "./context.js";
import { ChatStrip, ChatView, forgetClosed } from "./chat.js";
import { MenuButton } from "./menu.js";
import { PastChats } from "./past.js";
import { ClaudeMark, HistoryIcon, MoreIcon, PlusIcon, XIcon, type MenuItem } from "./primitives.js";
import type { ClaudeTransport } from "../types.js";
import type { ClaudeStore } from "../client/index.js";

// The panel: a chip per chat across its top, the chat shown below, Past chats
// in its place on the clock button. It fills whatever holds it (the drawer,
// Benhäus's floating panel); ClaudeChat is one chat in a page of its own.

/** A chat's ⋯ menu: the package's items, then whatever the app makes of them (ui.menu). */
function panelMenu(chat: ChatState, models: ChatsState["models"], where: Where, t: ClaudeTransport, ui: ClaudeUi): MenuItem[] {
  const list = models.length ? models : [{ value: "", name: "Default" }];
  const items: MenuItem[] = [
    ...(where === "panel"
      ? [
          { id: "new", label: "New chat", icon: "plus" },
          { id: "past", label: "Past chats", icon: "search" },
        ]
      : []),
    { id: "close", label: "Close chat", icon: "close" },
    ...(t.terminal && !ui.phone ? [{ id: "terminal", label: "Continue in terminal", icon: "terminal" }] : []),
    {
      id: "model",
      label: "Model",
      icon: "sliders",
      items: list.map((m) => ({ id: `model:${m.value === "default" ? "" : m.value}`, label: m.name, checked: (m.value === "default" ? "" : m.value) === chat.pickedModel })),
    },
  ];
  return ui.menu ? ui.menu(items, chat, where) : items;
}

function onPanelMenu(item: MenuItem, chat: ChatState, where: Where, t: ClaudeTransport, ui: ClaudeUi, store: ClaudeStore) {
  const fail = (e: unknown) => ui.toast(ui.errorText(e));
  if (item.id?.startsWith("model:")) {
    const model = item.id.slice(6);
    return ui.setModel ? ui.setModel(chat, model, where) : void t.configure(chat.id, { model }).catch(fail);
  }
  if (item.id === "new") return (store.setPast(false), void t.newChat().catch(fail));
  if (item.id === "past") return store.setPast(true);
  if (item.id === "close") return void t.close(chat.id).catch(fail);
  if (item.id === "terminal" && t.terminal) return void t.terminal(chat.id).then((r) => ui.toast(`Claude Code is opening in a terminal in ${ui.showPath(r.folder)}.`), fail);
  ui.onMenu?.(item, chat, where);
}

/** A chat's ⋯ button and its menu. */
export function More({ chat, where }: { chat: ChatState; where: Where }) {
  const t = useTransport();
  const ui = useUi();
  const store = useStore();
  const models = useClaude((s) => s.chats?.models) ?? [];
  return (
    <MenuButton className="ck-iconbtn" label="More" tip="More" items={() => panelMenu(chat, models, where, t, ui)} onSelect={(item) => onPanelMenu(item, chat, where, t, ui, store)}>
      <MoreIcon />
    </MenuButton>
  );
}

/**
 * The panel: the chat shown (or Past chats), a chip per chat when there's more
 * than one. `hidden` chats are drawn somewhere else (a tab of their own) and
 * stay off its chips; `onHide` is its ×, and Esc in an idle chat.
 */
export function ClaudePanel({ hidden = [], onHide, className, mark }: { hidden?: string[]; onHide?: () => void; className?: string; mark?: ReactNode }) {
  const t = useTransport();
  const ui = useUi();
  const store = useStore();
  const { Tooltip } = ui.c;
  const list = useClaude((s) => s.chats);
  const past = useClaude((s) => s.past);

  // Chats drawn elsewhere aren't the panel's: it shows another one, or a new one once every chat is elsewhere.
  const free = list?.chats.filter((c) => !hidden.includes(c.id)) ?? [];
  const chat = free.find((c) => c.id === list?.current) ?? free[0];
  useEffect(() => {
    if (!list || chat?.id === list.current) return;
    if (chat) void t.select(chat.id);
    else void t.newChat();
  }, [list?.current, chat?.id]);

  const ids = list?.chats.map((c) => c.id).join(" ");
  useEffect(() => void (ids !== undefined && forgetClosed(ids.split(" "))), [ids]);

  // Another chat coming into view (a past one picked up, a chip, Claude over MCP) leaves Past chats.
  const shownId = useRef(list?.current);
  useEffect(() => {
    if (shownId.current === list?.current) return;
    shownId.current = list?.current;
    store.setPast(false);
  }, [list?.current]);

  if (!list || !chat)
    return (
      <div className={["ck-root ck-panel", className].filter(Boolean).join(" ")} aria-busy="true">
        <p className="ck-thinking ck-panel__wait">Connecting to Claude…</p>
      </div>
    );
  const word = chatWord(chat);

  return (
    <div className={["ck-root ck-panel", className].filter(Boolean).join(" ")} role="region" aria-label={ui.title}>
      <header className="ck-head">
        {mark ?? <ClaudeMark size={22} />}
        <span className="ck-col ck-grow">
          <span className="ck-headline">{past ? "Past chats" : ui.title}</span>
          {past ? (
            <span className="ck-caption ck-ink3 ck-where">Pick one back up where it left off</span>
          ) : (
            <span className="ck-caption ck-ink3 ck-where" title={ui.showPath(chat.folder)}>
              {ui.showPath(chat.folder)} · {modelName(chat, list.models)}
            </span>
          )}
        </span>
        {!past && <span className={`ck-sig ${word.cls}`}>{word.label}</span>}
        <Tooltip label="Past chats" sub={past ? "Back to the chat" : "Pick up an earlier conversation"}>
          <button type="button" className="ck-iconbtn" aria-label="Past chats" aria-pressed={past} onClick={() => store.setPast(!past)}>
            <HistoryIcon />
          </button>
        </Tooltip>
        <Tooltip label="New chat" sub="Beside this one">
          <button type="button" className="ck-iconbtn" aria-label="New chat" onClick={() => (store.setPast(false), void t.newChat())}>
            <PlusIcon />
          </button>
        </Tooltip>
        {!past && ui.headerActions?.(chat, "panel")}
        <More chat={chat} where="panel" />
        {onHide && (
          <Tooltip label="Hide">
            <button type="button" className="ck-iconbtn" aria-label={`Hide ${ui.title}`} onClick={onHide}>
              <XIcon />
            </button>
          </Tooltip>
        )}
      </header>

      {past ? (
        <PastChats />
      ) : (
        <>
          {free.length > 1 && <ChatStrip list={{ ...list, chats: free }} />}
          <ChatView key={chat.id} chat={chat} where="panel" onHide={onHide} />
        </>
      )}
    </div>
  );
}

/**
 * One chat in a page or tab of its own (the one shown, unless `id` names
 * another), at a readable width, with its own header. `where` "window" when
 * it's a window of its own.
 */
export function ClaudeChat({ id, where = "tab", className, mark, gone }: { id?: string; where?: Where; className?: string; mark?: ReactNode; gone?: ReactNode }) {
  const list = useClaude((s) => s.chats);
  const ui = useUi();
  const chat = list?.chats.find((c) => c.id === (id ?? list.current));
  const cls = ["ck-root ck-page", className].filter(Boolean).join(" ");

  if (!list) return <div className={cls} aria-busy="true" />;
  if (!chat)
    return (
      <div className={cls}>
        <div className="ck-empty ck-page__gone">
          {gone ?? (
            <>
              <p className="ck-headline">This chat is closed.</p>
              <p className="ck-callout ck-ink3">Its conversation stays in Claude Code. Past chats picks it back up.</p>
            </>
          )}
        </div>
      </div>
    );
  const word = chatWord(chat);

  return (
    <section className={cls} aria-label={`${ui.title}: ${chat.title}`} onDragOver={(e) => e.dataTransfer?.types.includes("Files") && e.preventDefault()} onDrop={(e) => e.dataTransfer?.types.includes("Files") && e.preventDefault()}>
      <header className="ck-head ck-page__head">
        {mark ?? <ClaudeMark size={22} />}
        <span className="ck-col ck-grow">
          <span className="ck-headline ck-where">{chat.title}</span>
          <span className="ck-caption ck-ink3 ck-where" title={ui.showPath(chat.folder)}>
            {ui.showPath(chat.folder)} · {modelName(chat, list.models)}
          </span>
        </span>
        <span className={`ck-sig ${word.cls}`}>{word.label}</span>
        {ui.headerActions?.(chat, where)}
        <More chat={chat} where={where} />
      </header>
      <ChatView key={chat.id} chat={chat} where={where} />
    </section>
  );
}
