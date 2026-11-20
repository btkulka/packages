import { createContext, useContext, useEffect, useMemo, useRef, useState, type ComponentType, type ReactNode } from "react";
import { APPS_PROTOCOL, BLOCKS_EXT, CK_VARIABLES, M, isRpc, styleVariables, type ChoiceOption, type FormField, type HostContext, type JsonRpcId, type PickGroup, type PickImage, type Question, type RpcMessage } from "@btkulka/chat-blocks";
import type { AppPage, ChatBlock, ChatItem, RawAnswer } from "../types.js";
import { asBytes } from "../bytes.js";
import { useTransport, useUi } from "./context.js";
import { CarouselView, PicsContext } from "./images.js";

// Embedded blocks in a conversation (@btkulka/chat-blocks): something Claude
// asked the person to answer, drawn on its tool row in one frame (title, the
// kind's body, its answer said back), waiting until it's answered, then
// answered or expired. Each kind draws its body with a component from the
// registry: pick, choice, confirm, form and questions are built in, an app
// adds its own with registerBlock, and an app page (a ui:// kind) is drawn by
// the app's own MCP server in a sandboxed iframe. A block put up to look at
// (shown: await_feedback with wait: false) has nothing to answer; its page stays.

/** What a kind's component gets. */
export interface BlockProps {
  block: ChatBlock;
  /** It's waiting and can be answered here. */
  live: boolean;
  /** Answers it: with its value, or words. Resolves once the host has it (and throws what it refused). */
  answer: (a: RawAnswer) => Promise<void>;
}

export type BlockComponent = ComponentType<BlockProps>;

const registry = new Map<string, BlockComponent>();

/** A kind of block an app draws itself, in the app's own bundle: its component, for every chat on the page. Returns the undo. */
export function registerBlock(kind: string, component: BlockComponent): () => void {
  const was = registry.get(kind);
  registry.set(kind, component);
  return () => void (was ? registry.set(kind, was) : registry.delete(kind));
}

/** The component that draws a kind: one registered, an app page, or the fallback (words only). */
export function blockComponent(block: Pick<ChatBlock, "kind" | "app">): BlockComponent {
  return registry.get(block.kind) ?? (block.kind.startsWith("ui://") ? AppBlock : Fallback);
}

/** The chat the blocks are in: which are waiting, and how to answer them. */
export const BlocksContext = createContext<{ chat: string; waiting: ReadonlySet<string>; answer?: (id: string, a: RawAnswer) => Promise<void> }>({ chat: "", waiting: new Set() });

/* ----------------------------------------------------------------- frame */

const SOURCE: Record<string, string> = { questions: "Question", pick: "Pick", choice: "Choose", confirm: "Confirm", form: "Form" };

/**
 * The frame every block sits in: a title (and where it's from), a line or
 * two, the kind's body, actions, and once it's over the answer said back (or
 * why it ended). States: is-waiting, is-answered, is-expired.
 */
export function BlockFrame({ block, live, children, actions }: { block: ChatBlock; live?: boolean; children?: ReactNode; actions?: ReactNode }) {
  const said = block.answer?.value === undefined && block.answer?.text ? `“${block.answer.text}”` : block.answer?.said;
  const source = block.app ? block.app : SOURCE[block.kind];
  return (
    <section className={`cb-frame is-${block.state}${live ? " is-live" : ""}`} aria-label={block.title ?? source ?? "Claude asks"} aria-busy={block.state === "waiting" && !live ? true : undefined}>
      {(block.title || source) && (
        <header className="cb-head">
          <h3 className="cb-title">{block.title ?? "Claude asks"}</h3>
          {source && <span className="cb-source">{source}</span>}
        </header>
      )}
      {block.body && <p className="cb-text">{block.body}</p>}
      {children && <div className="cb-body">{children}</div>}
      {actions && <div className="cb-actions">{actions}</div>}
      {block.state === "answered" && said && <p className="cb-said">{said}</p>}
      {block.state === "expired" && <p className="cb-said is-expired">{block.reason ?? "It ended without an answer."}</p>}
    </section>
  );
}

/** A block's row: its frame and its kind's body, live while the host holds it waiting. One left waiting without the host (a turn that ended, a transcript read back) shows as ended. */
export function BlockRow({ item }: { item: Extract<ChatItem, { kind: "tool" }> & { block: ChatBlock } }) {
  const { waiting, answer } = useContext(BlocksContext);
  const ui = useUi();
  const held = waiting.has(item.id);
  const live = held && Boolean(answer);
  const block: ChatBlock = item.block.state === "waiting" && !held && item.state !== "running" ? { ...item.block, state: "expired", reason: "It ended without an answer." } : item.block;
  const Body = blockComponent(block);
  const send = async (a: RawAnswer) => {
    if (!answer) return;
    try {
      await answer(item.id, a);
    } catch (e) {
      ui.toast(ui.errorText(e));
      throw e;
    }
  };
  return <Body block={block} live={live} answer={send} />;
}

/* ------------------------------------------------------------- built-ins */

/** A kind the chat doesn't know: its words, answered in the chat's box. */
function Fallback({ block, live }: BlockProps) {
  return <BlockFrame block={block} live={live}>{live && <p className="cb-hint">Answer in the box below.</p>}</BlockFrame>;
}

const quietly = (p: Promise<void>) => void p.catch(() => undefined);

/** Picks, by group: which images are picked in each (an index list). */
type Picks = number[][];

/** What a pick's answer picked, read back onto its groups. */
function pickedFrom(block: ChatBlock, groups: PickGroup[]): Picks {
  const v = block.answer?.value;
  if (v === undefined) return groups.map(() => []);
  const at = (x: unknown) => (typeof x === "object" && x !== null && typeof (x as { index?: unknown }).index === "number" ? [(x as { index: number }).index] : []);
  if (Array.isArray(block.props?.groups))
    return groups.map((_, gi) => {
      const e = (v as unknown[])[gi] as { picks?: unknown[] } | undefined;
      return e?.picks ? e.picks.flatMap(at) : at(e);
    });
  return [Array.isArray(v) ? v.flatMap(at) : at(v)];
}

/**
 * Pick: one carousel, or a carousel per group. One carousel with one pick
 * answers as Pick is pressed; several to pick, or groups, are picked one at a
 * time (each group's pick checked, a pick in a group replacing the last) and
 * sent together with Submit.
 */
function PickBlock({ block, live, answer }: BlockProps) {
  const p = block.props as { images?: PickImage[]; groups?: PickGroup[]; multi?: boolean };
  const grouped = Array.isArray(p.groups);
  const groups: PickGroup[] = useMemo(() => (grouped ? p.groups! : [{ label: "", images: p.images ?? [], multi: p.multi }]), [block.props]);
  const [mine, setMine] = useState<Picks>(() => groups.map(() => []));
  const [sending, setSending] = useState(false);
  const picks = live ? mine : pickedFrom(block, groups);
  const instant = !grouped && !groups[0].multi;
  const count = picks.filter((g) => g.length).length;
  const submit = (value: unknown) => {
    setSending(true);
    quietly(answer({ value }).finally(() => setSending(false)));
  };
  const choose = (gi: number, i: number) => {
    if (instant) return submit(i);
    setMine((all) => all.map((g, j) => (j !== gi ? g : groups[gi].multi ? (g.includes(i) ? g.filter((x) => x !== i) : [...g, i]) : g[0] === i ? [] : [i])));
  };
  const value = () => (grouped ? picks.map((g, gi) => (groups[gi].multi ? g : (g[0] ?? null))) : picks[0]);
  return (
    <BlockFrame
      block={block}
      live={live}
      actions={
        live && !instant ? (
          <>
            <span className="cb-hint">{grouped ? `${count} of ${groups.length} group${groups.length === 1 ? "" : "s"} picked` : `${picks[0].length} picked`}</span>
            <span className="cb-grow" />
            <button type="button" className="cb-btn is-primary" disabled={!count || sending} onClick={() => submit(value())}>
              {grouped && count < groups.length ? "Submit, skip the rest" : "Submit"}
            </button>
          </>
        ) : undefined
      }
    >
      {groups.map((g, gi) => (
        <div key={gi} className={`cb-group${grouped ? " is-compact" : ""}`}>
          {grouped && (
            <div className="cb-grouphead">
              <span className="cb-qhead">{g.label}</span>
              <span className="cb-hint">{picks[gi].length ? (g.multi ? `${picks[gi].length} picked` : `#${picks[gi][0] + 1}`) : live ? (g.multi ? "pick any" : "pick one") : "skipped"}</span>
            </div>
          )}
          <CarouselView pics={g.images.map((x) => ({ ref: x.ref, alt: x.alt, name: x.name }))} picked={picks[gi]} onPick={live && !sending ? (i) => choose(gi, i) : undefined} toggle={!instant} label={g.label || undefined} />
        </div>
      ))}
    </BlockFrame>
  );
}

/** Options to choose from, round marks for one and square for several; with `onChoose`, each a button. */
function Options({ options, chosen, multi, onChoose, label }: { options: ChoiceOption[]; chosen: readonly string[]; multi?: boolean; onChoose?: (label: string) => void; label?: string }) {
  return (
    <div className={`cb-options${multi ? " is-multi" : ""}`} role={multi ? "group" : "radiogroup"} aria-label={label}>
      {options.map((o) => {
        const on = chosen.includes(o.label);
        return (
          <button key={o.label} type="button" className={`cb-option${on ? " is-on" : ""}`} role={multi ? "checkbox" : "radio"} aria-checked={on} disabled={!onChoose} onClick={() => onChoose?.(o.label)}>
            <span className="cb-mark" aria-hidden="true" />
            <span className="cb-optext">
              <span className="cb-oplabel">{o.label}</span>
              {o.description && o.description !== o.label && <span className="cb-opdesc">{o.description}</span>}
            </span>
          </button>
        );
      })}
    </div>
  );
}

const asList = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : typeof v === "string" ? [v] : []);

/** Choice: one option answers as it's pressed; several are ticked and sent with Submit. */
function ChoiceBlock({ block, live, answer }: BlockProps) {
  const p = block.props as { options: ChoiceOption[]; multi?: boolean };
  const [mine, setMine] = useState<string[]>([]);
  const [sending, setSending] = useState(false);
  const chosen = live ? mine : asList(block.answer?.value);
  const send = (value: unknown) => {
    setSending(true);
    quietly(answer({ value }).finally(() => setSending(false)));
  };
  const choose = (label: string) => (p.multi ? setMine((all) => (all.includes(label) ? all.filter((x) => x !== label) : [...all, label])) : send(label));
  return (
    <BlockFrame
      block={block}
      live={live}
      actions={
        live && p.multi ? (
          <button type="button" className="cb-btn is-primary" disabled={!mine.length || sending} onClick={() => send(mine)}>
            Submit
          </button>
        ) : undefined
      }
    >
      <Options options={p.options} chosen={chosen} multi={p.multi} onChoose={live && !sending ? choose : undefined} label={block.title} />
    </BlockFrame>
  );
}

/** Confirm: yes or no; a yes that's hard to undo is drawn as a warning. */
function ConfirmBlock({ block, live, answer }: BlockProps) {
  const p = block.props as { yes?: string; no?: string; danger?: boolean };
  const [sending, setSending] = useState(false);
  const send = (value: boolean) => {
    setSending(true);
    quietly(answer({ value }).finally(() => setSending(false)));
  };
  return (
    <BlockFrame
      block={block}
      live={live}
      actions={
        live ? (
          <>
            <button type="button" className={`cb-btn ${p.danger ? "is-danger" : "is-primary"}`} disabled={sending} onClick={() => send(true)}>
              {p.yes ?? "Yes"}
            </button>
            <button type="button" className="cb-btn" disabled={sending} onClick={() => send(false)}>
              {p.no ?? "No"}
            </button>
          </>
        ) : undefined
      }
    />
  );
}

type FieldValue = string | number | boolean;

/** Form: its fields, filled in and sent with its submit button; once answered, what was sent. */
function FormBlock({ block, live, answer }: BlockProps) {
  const p = block.props as { fields: FormField[]; submit?: string };
  const start = () => Object.fromEntries(p.fields.map((f) => [f.name, f.value ?? (f.type === "checkbox" ? false : "")])) as Record<string, FieldValue>;
  const [values, setValues] = useState<Record<string, FieldValue>>(start);
  const [sending, setSending] = useState(false);
  const shown = live ? values : { ...start(), ...((block.answer?.value as Record<string, FieldValue> | undefined) ?? {}) };
  const missing = p.fields.some((f) => f.required && (f.type === "checkbox" ? values[f.name] !== true : String(values[f.name] ?? "").trim() === ""));
  const set = (name: string, v: FieldValue) => setValues((all) => ({ ...all, [name]: v }));
  const submit = () => {
    setSending(true);
    quietly(answer({ value: values }).finally(() => setSending(false)));
  };
  const off = !live || sending;
  return (
    <BlockFrame
      block={block}
      live={live}
      actions={
        live ? (
          <button type="submit" form={`cb-form-${block.id}`} className="cb-btn is-primary" disabled={missing || sending}>
            {p.submit ?? "Send"}
          </button>
        ) : undefined
      }
    >
      <form id={`cb-form-${block.id}`} className="cb-body" onSubmit={(e) => (e.preventDefault(), !missing && !off && submit())}>
        {p.fields.map((f) => {
          const id = `cb-${block.id}-${f.name}`;
          const label = f.label ?? f.name;
          if (f.type === "checkbox")
            return (
              <label key={f.name} className="cb-field is-check" htmlFor={id}>
                <input id={id} type="checkbox" checked={shown[f.name] === true} disabled={off} onChange={(e) => set(f.name, e.target.checked)} />
                <span className={`cb-label${f.required ? " is-required" : ""}`}>{label}</span>
              </label>
            );
          return (
            <div key={f.name} className="cb-field">
              <label className={`cb-label${f.required ? " is-required" : ""}`} htmlFor={id}>
                {label}
              </label>
              {f.type === "textarea" ? (
                <textarea id={id} className="cb-input" value={String(shown[f.name] ?? "")} placeholder={f.placeholder} disabled={off} required={f.required} onChange={(e) => set(f.name, e.target.value)} />
              ) : f.type === "select" ? (
                <select id={id} className="cb-input" value={String(shown[f.name] ?? "")} disabled={off} required={f.required} onChange={(e) => set(f.name, e.target.value)}>
                  <option value="">Choose…</option>
                  {f.options?.map((o) => (
                    <option key={o} value={o}>
                      {o}
                    </option>
                  ))}
                </select>
              ) : (
                <input id={id} className="cb-input" type={f.type === "number" ? "number" : "text"} value={String(shown[f.name] ?? "")} placeholder={f.placeholder} disabled={off} required={f.required} onChange={(e) => set(f.name, e.target.value)} />
              )}
            </div>
          );
        })}
      </form>
    </BlockFrame>
  );
}

/** Claude Code's AskUserQuestion: each question's options; one question with one answer goes as it's pressed, otherwise Submit sends them all. */
function QuestionsBlock({ block, live, answer }: BlockProps) {
  const qs = (block.props as { questions: Question[] }).questions;
  const [mine, setMine] = useState<Record<string, string[]>>({});
  const [sending, setSending] = useState(false);
  const given = (block.answer?.value ?? {}) as Record<string, string>;
  const chosen = (q: Question) => (live ? (mine[q.question] ?? []) : q.multiSelect ? (given[q.question] ?? "").split(", ").filter(Boolean) : given[q.question] ? [given[q.question]] : []);
  const instant = qs.length === 1 && !qs[0].multiSelect;
  const send = (value: Record<string, string[] | string>) => {
    setSending(true);
    quietly(answer({ value }).finally(() => setSending(false)));
  };
  const choose = (q: Question, label: string) => {
    if (instant) return send({ [q.question]: label });
    setMine((all) => {
      const was = all[q.question] ?? [];
      return { ...all, [q.question]: q.multiSelect ? (was.includes(label) ? was.filter((x) => x !== label) : [...was, label]) : [label] };
    });
  };
  const answered = qs.filter((q) => (mine[q.question] ?? []).length).length;
  return (
    <BlockFrame
      block={qs.length === 1 ? block : { ...block, title: block.title ?? "A few questions" }}
      live={live}
      actions={
        live && !instant ? (
          <>
            <span className="cb-hint">
              {answered} of {qs.length} answered
            </span>
            <span className="cb-grow" />
            <button type="button" className="cb-btn is-primary" disabled={!answered || sending} onClick={() => send(mine)}>
              Submit
            </button>
          </>
        ) : undefined
      }
    >
      {qs.map((q) => (
        <div key={q.question} className="cb-group">
          {qs.length > 1 && (
            <>
              {q.header && <span className="cb-qhead">{q.header}</span>}
              <p className="cb-question">{q.question}</p>
            </>
          )}
          <Options options={q.options} chosen={chosen(q)} multi={q.multiSelect} onChoose={live && !sending ? (l) => choose(q, l) : undefined} label={q.question} />
        </div>
      ))}
      {live && <p className="cb-hint">Or type your own answer below.</p>}
    </BlockFrame>
  );
}

for (const [kind, c] of Object.entries({ pick: PickBlock, choice: ChoiceBlock, confirm: ConfirmBlock, form: FormBlock, questions: QuestionsBlock })) registry.set(kind, c);

/* ------------------------------------------------------------- app pages */

const MAX_PAGE_HEIGHT = 560;

/** A chat image as a data: address, for a page's image() (a sandboxed page can't load the chat's files). */
async function dataUrl(bytes: Uint8Array, type: string): Promise<string> {
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return `data:${type};base64,${btoa(bin)}`;
}

type DisplayMode = "inline" | "fullscreen";

/** Every string in a block's props (any depth). */
function stringsIn(v: unknown, out: string[] = [], depth = 0): string[] {
  if (depth > 8) return out;
  if (typeof v === "string") out.push(v);
  else if (Array.isArray(v)) v.forEach((x) => stringsIn(x, out, depth + 1));
  else if (v && typeof v === "object") Object.values(v).forEach((x) => stringsIn(x, out, depth + 1));
  return out;
}

/** One spelling of a path to compare by: forward slashes, any case (Windows' paths). */
const pathKey = (p: string) => p.trim().replace(/\\/g, "/").toLowerCase();

/**
 * An app page: the ui:// page the block's app serves, read through the chat's
 * session (transport.appPage) and drawn in a sandboxed iframe (scripts only:
 * no same origin, no forms, no popups) that talks MCP Apps over postMessage.
 * The page gets the chat's theme and the block's props, and its answer() answers
 * the block; its file() reads a file the props name (or one beside it) through
 * transport.file. Once the block's over, or with no session to read the page
 * through, the frame shows the answer without it. The iframe sits in a <dialog>
 * shown in place, so a page that asks for fullscreen goes over the whole window
 * (the dialog shown modally, in the top layer) without reloading.
 */
function AppBlock({ block, live, answer }: BlockProps) {
  const t = useTransport();
  const ui = useUi();
  const { chat } = useContext(BlocksContext);
  const { folder } = useContext(PicsContext);
  const [page, setPage] = useState<AppPage | Error>();
  const [height, setHeight] = useState(120);
  const [mode, setMode] = useState<DisplayMode>("inline");
  const modeRef = useRef<DisplayMode>("inline");
  const frame = useRef<HTMLIFrameElement>(null);
  const pagebox = useRef<HTMLDialogElement>(null);
  const box = useRef<HTMLDivElement>(null);
  const ready = useRef(false);
  const goInline = useRef<() => void>(undefined);
  const latest = useRef({ block, live, answer });
  latest.current = { block, live, answer };

  // A waiting block's page, or one put up to look at (shown), for as long as the chat's session can read it.
  const showing = live || block.state === "shown";
  useEffect(() => {
    if (!showing || !block.app || !t.appPage) return;
    let gone = false;
    t.appPage(chat, block.app, block.kind).then(
      (p) => !gone && setPage(p),
      (e: unknown) => !gone && setPage(e instanceof Error ? e : new Error(String(e))),
    );
    return () => void (gone = true);
  }, [showing, block.id, chat]);

  // The page's box opens in place as soon as it's there.
  useEffect(() => {
    const d = pagebox.current;
    if (d && !d.open) d.show();
  }, [page]);

  // The page's messages: the handshake, its height, its answer, images, files, links, fullscreen.
  useEffect(() => {
    if (!page || page instanceof Error) return;
    const win = () => frame.current?.contentWindow;
    const post = (m: RpcMessage) => win()?.postMessage(m, "*");
    const reply = (id: JsonRpcId, result: unknown) => post({ jsonrpc: "2.0", id, result });
    const fail = (id: JsonRpcId, message: string, code = -32000) => post({ jsonrpc: "2.0", id, error: { code, message } });
    const dims = () => (modeRef.current === "fullscreen" ? { width: window.innerWidth, height: window.innerHeight } : { maxHeight: MAX_PAGE_HEIGHT });
    const context = (): HostContext => {
      const cs = box.current ? getComputedStyle(box.current) : undefined;
      const ck = Object.fromEntries(CK_VARIABLES.map((k) => [k, cs?.getPropertyValue(k).trim() ?? ""]).filter(([, v]) => v));
      const b = latest.current.block;
      return {
        toolInfo: { id: b.id, tool: { name: "await_feedback" } },
        theme: /light/.test(cs?.colorScheme ?? "") ? "light" : "dark",
        styles: { variables: styleVariables(ck) },
        displayMode: modeRef.current,
        availableDisplayModes: ["inline", "fullscreen"],
        containerDimensions: dims(),
        locale: navigator.language,
        timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        platform: ui.phone ? "mobile" : "desktop",
        block: { title: b.title, body: b.body, app: b.app },
      };
    };
    const onMessage = (e: MessageEvent) => {
      if (e.source !== win() || !isRpc(e.data) || !("method" in e.data)) return;
      const m = e.data;
      const id = "id" in m ? m.id : undefined;
      const params = (m.params ?? {}) as Record<string, unknown>;
      const now = latest.current;
      switch (m.method) {
        case M.initialize:
          if (id !== undefined)
            reply(id, { protocolVersion: APPS_PROTOCOL, hostInfo: { name: "claude-kit", version: "0.1.0" }, hostCapabilities: { openLinks: {}, logging: {}, experimental: { [BLOCKS_EXT]: { answer: true, image: true, file: !!t.file, star: !!t.star } } }, hostContext: context() });
          return;
        case M.initialized:
          ready.current = true;
          post({ jsonrpc: "2.0", method: M.toolInput, params: { arguments: now.block.props ?? {} } });
          return;
        case M.sizeChanged:
          if (typeof params.height === "number") setHeight(Math.max(40, Math.min(MAX_PAGE_HEIGHT, Math.ceil(params.height))));
          return;
        case M.answer:
        case M.message: {
          if (id === undefined) return;
          const a: RawAnswer = m.method === M.answer ? (params as RawAnswer) : { text: String((params.content as { text?: string } | undefined)?.text ?? "") };
          if (!now.live) return fail(id, "This block isn't waiting for an answer any more.");
          now.answer(a).then(() => reply(id, {}), (err: unknown) => fail(id, err instanceof Error ? err.message : String(err)));
          return;
        }
        case M.image:
          if (id === undefined) return;
          t.image(String(params.ref ?? ""), folder).then(
            async (img) => reply(id, { url: await dataUrl(asBytes(img.bytes), img.type) }),
            (err: unknown) => fail(id, err instanceof Error ? err.message : String(err)),
          );
          return;
        case M.file: {
          if (id === undefined) return;
          if (!t.file) return fail(id, "This chat can't read files.", -32601);
          t.file(chat, now.block.id, String(params.ref ?? "")).then(
            (f) => {
              // Handed over, not copied: a 60 MB model goes across once. A view into a bigger buffer is copied out first.
              const b = asBytes(f.bytes);
              const buf = b.byteOffset === 0 && b.byteLength === b.buffer.byteLength && b.buffer instanceof ArrayBuffer ? b.buffer : b.slice().buffer;
              win()?.postMessage({ jsonrpc: "2.0", id, result: { bytes: buf, type: f.type, name: f.name, size: f.size } }, "*", [buf]);
            },
            (err: unknown) => fail(id, err instanceof Error ? err.message : String(err)),
          );
          return;
        }
        case M.star: {
          if (id === undefined) return;
          if (!t.star) return fail(id, "This chat can't keep stars.", -32601);
          const refs = Array.isArray(params.refs) ? params.refs.filter((r): r is string => typeof r === "string") : [];
          // Only files the block's props name: what Claude put up, nothing past it.
          const named = new Set(stringsIn(now.block.props).map(pathKey));
          const off = refs.find((r) => !named.has(pathKey(r)));
          if (off) return fail(id, `${off} isn't one of this block's files.`);
          t.star(refs, typeof params.on === "boolean" ? params.on : undefined).then(
            (starred) => reply(id, { starred }),
            (err: unknown) => fail(id, err instanceof Error ? err.message : String(err)),
          );
          return;
        }
        case M.openLink:
          if (id === undefined) return;
          if (typeof params.url === "string" && /^https?:\/\//i.test(params.url)) {
            ui.openLink(params.url);
            reply(id, {});
          } else fail(id, "Invalid URL");
          return;
        case M.displayMode: {
          const m = toMode(params.mode === "fullscreen" ? "fullscreen" : "inline");
          if (id !== undefined) reply(id, { mode: m });
          return;
        }
        case M.modelContext:
        case M.ping:
          if (id !== undefined) reply(id, {});
          return;
        case M.log:
          return;
        default:
          if (id !== undefined) fail(id, `${m.method} isn't available in this chat.`, -32601);
      }
    };
    // Fullscreen: the box in the top layer over the whole window; inline: back in place. The page hears where it is.
    const toMode = (m: DisplayMode): DisplayMode => {
      const d = pagebox.current;
      if (!d) return "inline";
      if (m === "fullscreen" && !d.matches(":modal")) {
        d.close();
        d.showModal();
      } else if (m === "inline" && d.matches(":modal")) {
        d.close();
        d.show();
      }
      modeRef.current = m;
      setMode(m);
      post({ jsonrpc: "2.0", method: M.contextChanged, params: { displayMode: m, containerDimensions: dims() } });
      return m;
    };
    goInline.current = () => void toMode("inline");
    const onResize = () => modeRef.current === "fullscreen" && post({ jsonrpc: "2.0", method: M.contextChanged, params: { containerDimensions: dims() } });
    window.addEventListener("message", onMessage);
    window.addEventListener("resize", onResize);
    return () => {
      window.removeEventListener("message", onMessage);
      window.removeEventListener("resize", onResize);
      goInline.current = undefined;
    };
  }, [page]);

  // The block ended (answered here, in the chat's box, or cut short): the page hears how.
  useEffect(() => {
    if (!ready.current || block.state === "waiting" || block.state === "shown") return;
    // Answered over the whole window (its Pick): back to the conversation, where Claude goes on.
    if (modeRef.current === "fullscreen") goInline.current?.();
    const win = frame.current?.contentWindow;
    if (block.state === "answered") win?.postMessage({ jsonrpc: "2.0", method: M.toolResult, params: { content: [{ type: "text", text: JSON.stringify({ answered: true, ...block.answer }) }] } }, "*");
    else win?.postMessage({ jsonrpc: "2.0", method: M.toolCancelled, params: { reason: block.reason ?? "It ended." } }, "*");
  }, [block.state]);

  const showPage = page && !(page instanceof Error);
  return (
    <BlockFrame block={block} live={live}>
      <div ref={box} className="cb-app">
        {showPage && (
          <dialog
            ref={pagebox}
            className={`cb-pagebox is-${mode}`}
            aria-label={block.title ?? `${block.app}'s page`}
            onCancel={(e) => {
              // Esc over the whole window comes back to the conversation; the block stays.
              e.preventDefault();
              goInline.current?.();
            }}
          >
            <div className="cb-pagebar">
              <span className="cb-title">{block.title ?? block.app}</span>
              <button type="button" className="cb-btn" onClick={() => goInline.current?.()} title="Back to the chat (Esc)">
                Back to the chat
              </button>
            </div>
            <iframe
              ref={frame}
              className={`cb-page${(page as AppPage).prefersBorder ? " has-border" : ""}`}
              title={block.title ?? `${block.app}'s page`}
              sandbox="allow-scripts"
              srcDoc={(page as AppPage).html}
              style={{ height }}
              referrerPolicy="no-referrer"
            />
          </dialog>
        )}
        {live && page instanceof Error && <p className="cb-error">{page.message} Answer in the box below instead.</p>}
        {block.state === "shown" && page instanceof Error && <p className="cb-hint">{page.message}</p>}
        {live && !page && !t.appPage && <p className="cb-hint">This chat can't show {block.app}'s page. Answer in the box below.</p>}
      </div>
    </BlockFrame>
  );
}
