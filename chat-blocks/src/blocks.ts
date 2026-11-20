// Embedded chat blocks: something Claude puts in a conversation for the person
// to answer (pick an image, choose, confirm, fill in a few fields), drawn in
// one frame and answered with one value. A block is a tool call: Claude calls
// await_feedback (claude-kit's host) with a spec, the chat draws it, and the
// answer goes back as the call's result. The transcript keeps both, so a
// conversation read back draws every block as it was answered. No DOM and no
// Node here: the host, the screens and app pages all use these.

/** waiting: the call is open and the block answers it; answered: it has its answer; expired: it ended without one;
 *  shown: put up to look at (await_feedback with wait: false), nothing to answer, its call returned at once. */
export type BlockState = "waiting" | "answered" | "expired" | "shown";

/** The kinds every chat draws. An app page's kind is its ui:// address instead (with `app`). */
export const BUILT_IN = ["pick", "choice", "confirm", "form", "questions"] as const;
export type BuiltInKind = (typeof BUILT_IN)[number];

/** An image to pick: a path, file:, data: or http(s) address, or a kept image's id. */
export interface PickImage {
  ref: string;
  /** What it is: its caption, and what the answer calls it. */
  alt?: string;
  /** Its file name, which Download starts from. */
  name?: string;
}
/** One carousel of a grouped pick: "Chair", its options. */
export interface PickGroup {
  label: string;
  images: PickImage[];
  /** Several may be picked in this group. */
  multi?: boolean;
}
/**
 * One carousel (`images`), or several (`groups`), picked one group at a time
 * and sent together with Submit. One carousel with one pick answers as Pick is
 * pressed; `multi` (several to pick) and groups wait for Submit.
 */
export interface PickProps {
  images?: PickImage[];
  groups?: PickGroup[];
  /** Several may be picked (answered as a list). For groups, every group's default. */
  multi?: boolean;
}

export interface ChoiceOption {
  label: string;
  description?: string;
}
export interface ChoiceProps {
  options: ChoiceOption[];
  /** Several may be chosen (answered as a list of labels). */
  multi?: boolean;
}

export interface ConfirmProps {
  /** The yes button: "Go ahead". */
  yes?: string;
  /** The no button: "Not now". */
  no?: string;
  /** Yes does something hard to undo: it's drawn as a warning. */
  danger?: boolean;
}

export type FieldType = "text" | "textarea" | "number" | "select" | "checkbox";
export interface FormField {
  name: string;
  label?: string;
  type?: FieldType;
  /** A select's choices. */
  options?: string[];
  required?: boolean;
  placeholder?: string;
  /** What it starts with. */
  value?: string | number | boolean;
}
export interface FormProps {
  fields: FormField[];
  /** The submit button: "Save". */
  submit?: string;
}

/** Claude Code's AskUserQuestion: one to four questions, each with its options. */
export interface Question {
  question: string;
  /** A short tag: "Library". */
  header?: string;
  options: ChoiceOption[];
  multiSelect?: boolean;
}
export interface QuestionsProps {
  questions: Question[];
}

/** What Claude asks for: a kind, the words around it and the kind's props. */
export interface BlockSpec {
  /** pick, choice, confirm, form (questions is AskUserQuestion's), a kind a screen registered, or an app page's ui:// address. */
  kind: string;
  title?: string;
  /** A line or two under the title. */
  body?: string;
  props?: Record<string, unknown>;
  /** The MCP server (as Claude Code names it) whose ui:// page draws the block, when `kind` is that address. */
  app?: string;
}

/** How a block was answered: with the block itself (`value`), or in words in the chat's box (`text`). */
export interface BlockAnswer {
  /** pick { index, ref, alt } (a list with multi); choice a label (a list with multi); confirm true or false; form its fields by name; questions the answers by question; an app page what it sent. */
  value?: unknown;
  /** Typed in the chat's box instead. */
  text?: string;
  /** In words, for Claude and for the chat: "Picked 2 of 4: the misty harbor (D:\renders\harbor.png)". */
  said: string;
}

/** A block in a conversation. */
export interface ChatBlock extends BlockSpec {
  /** The tool call's id. */
  id: string;
  state: BlockState;
  answer?: BlockAnswer;
  /** Why it expired: "No answer after 10 minutes", "Ben stopped the turn". */
  reason?: string;
}

/** What a screen or app page sends as the answer: its value, or words. */
export type RawAnswer = { value?: unknown; text?: string };

/* ------------------------------------------------------------- checking */

const MAX_IMAGES = 24;
const MAX_GROUPS = 20;
const MAX_OPTIONS = 12;
const MAX_FIELDS = 12;
const FIELD_TYPES: readonly FieldType[] = ["text", "textarea", "number", "select", "checkbox"];

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v.trim() : undefined);

function list(v: unknown, what: string, max: number): unknown[] {
  if (!Array.isArray(v) || !v.length) throw new Error(`${what}: give at least one.`);
  if (v.length > max) throw new Error(`${what}: at most ${max}.`);
  return v;
}

function image(v: unknown, i: number): PickImage {
  if (typeof v === "string" && v.trim()) return { ref: v.trim() };
  const ref = isObj(v) ? str(v.ref) ?? str(v.path) ?? str(v.src) ?? str(v.url) : undefined;
  if (!ref || !isObj(v)) throw new Error(`images[${i}]: needs a ref (a path, an address or an image id).`);
  return { ref, alt: str(v.alt) ?? str(v.caption), name: str(v.name) };
}

function option(v: unknown, i: number, what = "options"): ChoiceOption {
  if (typeof v === "string" && v.trim()) return { label: v.trim() };
  const label = isObj(v) ? str(v.label) : undefined;
  if (!label || !isObj(v)) throw new Error(`${what}[${i}]: needs a label.`);
  return { label, description: str(v.description) };
}

function field(v: unknown, i: number): FormField {
  if (!isObj(v) || !str(v.name)) throw new Error(`fields[${i}]: needs a name.`);
  const type = (str(v.type) ?? "text") as FieldType;
  if (!FIELD_TYPES.includes(type)) throw new Error(`fields[${i}].type: one of ${FIELD_TYPES.join(", ")}.`);
  const options = Array.isArray(v.options) ? v.options.filter((o): o is string => typeof o === "string") : undefined;
  if (type === "select" && !options?.length) throw new Error(`fields[${i}]: a select needs options.`);
  const value = typeof v.value === "string" || typeof v.value === "number" || typeof v.value === "boolean" ? v.value : undefined;
  return { name: str(v.name)!, label: str(v.label), type, options, required: v.required === true || undefined, placeholder: str(v.placeholder), value };
}

const drop = <T extends object>(o: T): T => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T;

/** A kind's props, checked and tidied (strings for images or options become objects). Throws what's wrong, in words Claude can act on. */
export function checkProps(kind: string, props: unknown): Record<string, unknown> {
  const p = isObj(props) ? props : {};
  switch (kind) {
    case "pick": {
      const multi = p.multi === true || undefined;
      if (p.groups === undefined) return drop({ images: list(p.images, "images", MAX_IMAGES).map(image).map(drop), multi });
      const groups = list(p.groups, "groups", MAX_GROUPS).map((g, i) => {
        if (!isObj(g)) throw new Error(`groups[${i}]: needs a label and images.`);
        return drop({ label: str(g.label) ?? str(g.title) ?? `Group ${i + 1}`, images: list(g.images, `groups[${i}].images`, MAX_IMAGES).map(image).map(drop), multi: g.multi === true ? true : g.multi === false ? undefined : multi });
      });
      return { groups };
    }
    case "choice":
      return drop({ options: list(p.options, "options", MAX_OPTIONS).map((o, i) => drop(option(o, i))), multi: p.multi === true || undefined });
    case "confirm":
      return drop({ yes: str(p.yes), no: str(p.no), danger: p.danger === true || undefined });
    case "form":
      return drop({ fields: list(p.fields, "fields", MAX_FIELDS).map((f, i) => drop(field(f, i) as unknown as Record<string, unknown>)), submit: str(p.submit) });
    case "questions":
      return {
        questions: list(p.questions, "questions", 4).map((q, i) => {
          if (!isObj(q) || !str(q.question)) throw new Error(`questions[${i}]: needs a question.`);
          return drop({ question: str(q.question)!, header: str(q.header), options: list(q.options, `questions[${i}].options`, MAX_OPTIONS).map((o, j) => drop(option(o, j, `questions[${i}].options`))), multiSelect: q.multiSelect === true || undefined });
        }),
      };
    default:
      return p;
  }
}

/** A spec from Claude, checked: a known kind with good props, or an app page (a ui:// kind with its app). Throws what's wrong. */
export function checkSpec(input: unknown): BlockSpec {
  if (!isObj(input)) throw new Error("A block needs a kind.");
  const kind = str(input.kind);
  if (!kind) throw new Error("A block needs a kind: pick, choice, confirm or form, or an app page's ui:// address with its app.");
  const app = str(input.app);
  if (kind.startsWith("ui://") && !app) throw new Error(`${kind}: say which app (MCP server) serves it.`);
  if (!kind.startsWith("ui://") && !/^[a-z][\w.-]*$/i.test(kind)) throw new Error(`${kind}: not a kind. Use pick, choice, confirm or form, or an app page's ui:// address.`);
  return drop({ kind, title: str(input.title), body: str(input.body), props: checkProps(kind, input.props), app });
}

/* ---------------------------------------------------------------- words */

/** "Picked 2 of 4: the misty harbor (D:\renders\harbor.png)". An image written in as data: goes without its address. */
export function pickWords(images: readonly PickImage[], at: number): string {
  const p = images[at];
  const alt = p.alt?.trim();
  const ref = /^data:/i.test(p.ref) ? "" : ` (${p.ref})`;
  return `Picked ${at + 1} of ${images.length}${alt ? `: ${alt}` : ""}${ref}`;
}

const quote = (s: string) => `"${s}"`;
/** Questions' answers in words: "Which library? → dayjs", a line each. */
export const questionWords = (answers: Record<string, string>) =>
  Object.entries(answers)
    .map(([q, a]) => `${q} → ${a}`)
    .join("\n");
/** One image of several picked: "the misty harbor (D:\x.png)", or "#2 (D:\y.png)" when it has no caption. */
const itemWords = (images: readonly PickImage[], at: number) => {
  const p = images[at];
  return `${p.alt?.trim() || `#${at + 1}`}${/^data:/i.test(p.ref) ? "" : ` (${p.ref})`}`;
};
const shown = (v: unknown) => (typeof v === "string" ? v : JSON.stringify(v));

/**
 * A screen's or page's answer, checked against the block, with what it says
 * in words. Words typed in the chat's box answer any block. Throws when the
 * value doesn't fit (a pick out of range, a choice that isn't offered, a
 * required field left empty).
 */
export function answerFor(spec: BlockSpec, raw: RawAnswer): BlockAnswer {
  const text = typeof raw.text === "string" ? raw.text.trim() : "";
  if (raw.value === undefined) {
    if (!text) throw new Error("An answer needs a value or words.");
    return { text, said: `Answered in words instead: ${quote(text)}` };
  }
  const v = raw.value;
  const p = (spec.props ?? {}) as Record<string, unknown>;
  switch (spec.kind) {
    case "pick": {
      if (Array.isArray(p.groups)) return groupAnswer(p.groups as PickGroup[], v);
      const images = (p.images as PickImage[] | undefined) ?? [];
      const one = (x: unknown) => {
        const at = typeof x === "number" ? x : isObj(x) && typeof x.index === "number" ? x.index : -1;
        if (!Number.isInteger(at) || !images[at]) throw new Error(`No image ${at + 1} to pick.`);
        return { index: at, ref: images[at].ref, ...(images[at].alt ? { alt: images[at].alt } : {}) };
      };
      if (p.multi) {
        const picks = (Array.isArray(v) ? v : [v]).map(one);
        if (!picks.length) throw new Error("Pick at least one.");
        const words = picks.map((x) => itemWords(images, x.index));
        return { value: picks, said: `Picked ${picks.map((x) => x.index + 1).join(", ")} of ${images.length}: ${words.join("; ")}` };
      }
      const pick = one(Array.isArray(v) ? v[0] : v);
      return { value: pick, said: pickWords(images, pick.index) };
    }
    case "choice": {
      const labels = ((p.options as ChoiceOption[] | undefined) ?? []).map((o) => o.label);
      const picked = (Array.isArray(v) ? v : [v]).map((x) => (typeof x === "number" ? labels[x] : x));
      for (const x of picked) if (typeof x !== "string" || !labels.includes(x)) throw new Error(`${shown(x)} isn't one of the options.`);
      if (!picked.length) throw new Error("Choose at least one.");
      return p.multi ? { value: picked, said: `Chose ${picked.map((x) => quote(x as string)).join(", ")}` } : { value: picked[0], said: `Chose ${quote(picked[0] as string)}` };
    }
    case "confirm": {
      if (typeof v !== "boolean") throw new Error("A confirm is answered true or false.");
      const word = v ? ((p.yes as string | undefined) ?? "Yes") : ((p.no as string | undefined) ?? "No");
      return { value: v, said: `${v ? "Yes" : "No"}: ${quote(word)}` };
    }
    case "form": {
      if (!isObj(v)) throw new Error("A form is answered with its fields by name.");
      const fields = (p.fields as FormField[] | undefined) ?? [];
      const out: Record<string, string | number | boolean> = {};
      for (const f of fields) {
        const x = v[f.name];
        const empty = x === undefined || x === null || x === "";
        if (f.required && (empty || (f.type === "checkbox" && x !== true))) throw new Error(`${f.label ?? f.name} is needed.`);
        if (empty) continue;
        if (f.type === "number") {
          const n = typeof x === "number" ? x : Number(x);
          if (!Number.isFinite(n)) throw new Error(`${f.label ?? f.name} has to be a number.`);
          out[f.name] = n;
        } else if (f.type === "checkbox") out[f.name] = x === true;
        else if (f.type === "select" && !f.options?.includes(String(x))) throw new Error(`${f.label ?? f.name}: ${shown(x)} isn't one of its choices.`);
        else out[f.name] = String(x);
      }
      const said = fields.filter((f) => f.name in out).map((f) => `${f.label ?? f.name}: ${shown(out[f.name])}`);
      return { value: out, said: said.length ? said.join("; ") : "Sent the form empty" };
    }
    case "questions": {
      if (!isObj(v)) throw new Error("Questions are answered by question.");
      const qs = (p.questions as Question[] | undefined) ?? [];
      const out: Record<string, string> = {};
      for (const q of qs) {
        const x = v[q.question];
        const a = Array.isArray(x) ? x.filter((s) => typeof s === "string").join(", ") : typeof x === "string" ? x.trim() : "";
        if (a) out[q.question] = a;
      }
      if (!Object.keys(out).length) throw new Error("Answer at least one question.");
      return { value: out, said: questionWords(out) };
    }
    default:
      // A registered kind or an app page: its value as it sent it, and words it gave or else the value.
      return { value: v, ...(text ? { text } : {}), said: text || (typeof v === "string" ? v : `Answered: ${JSON.stringify(v)}`) };
  }
}

type GroupPick = { index: number; ref: string; alt?: string };

/** Where a pick value points: an index, or { index }. */
const indexOf = (x: unknown) => (typeof x === "number" ? x : isObj(x) && typeof x.index === "number" ? x.index : -1);

/**
 * A grouped pick's answer: one entry per group, in order (an index, a list of
 * them for a multi group, or null to skip it). Answered as each group's picks
 * by label, skipped groups said as skipped; at least one group has to be picked.
 */
function groupAnswer(groups: readonly PickGroup[], v: unknown): BlockAnswer {
  if (!Array.isArray(v) || v.length !== groups.length) throw new Error(`A grouped pick is answered with one entry per group (${groups.length}).`);
  type Entry = { group: string; picks: GroupPick[] } | ({ group: string } & GroupPick) | { group: string; skipped: true };
  const value = groups.map((g, gi): Entry => {
    const raw = v[gi];
    const at = (raw === null || raw === undefined ? [] : Array.isArray(raw) ? raw : [raw]).map(indexOf);
    for (const i of at) if (!Number.isInteger(i) || !g.images[i]) throw new Error(`${g.label}: no image ${i + 1} to pick.`);
    if (!g.multi && at.length > 1) throw new Error(`${g.label}: pick one.`);
    const picks = at.map((i) => ({ index: i, ref: g.images[i].ref, ...(g.images[i].alt ? { alt: g.images[i].alt } : {}) }));
    return g.multi ? { group: g.label, picks } : picks.length ? { group: g.label, ...picks[0] } : { group: g.label, skipped: true as const };
  });
  const picked = (e: (typeof value)[number]) => ("picks" in e ? e.picks.length > 0 : !("skipped" in e));
  if (!value.some(picked)) throw new Error("Pick from at least one group.");
  const said = groups.map((g, gi) => {
    const e = value[gi];
    const at = "picks" in e ? e.picks.map((x) => x.index) : "index" in e ? [e.index] : [];
    if (!at.length) return `${g.label}: skipped`;
    return `${g.label}: ${at.map((i) => pickWords(g.images, i).replace(/^Picked/, "picked")).join("; ")}`;
  });
  return { value, said: said.join("\n") };
}

/* -------------------------------------------------------------- results */

/** What a block's tool call returns to Claude, as JSON text: its answer, why it ended without one, or that it's up to look at. */
export type BlockOutcome = { answered: true; value?: unknown; text?: string; said: string } | { expired: true; reason: string } | { shown: true };

export const outcomeOf = (a: BlockAnswer): BlockOutcome => drop({ answered: true as const, value: a.value, text: a.text, said: a.said });
export const expiredOutcome = (reason: string): BlockOutcome => ({ expired: true, reason });
export const shownOutcome: BlockOutcome = { shown: true };
export const outcomeText = (o: BlockOutcome) => JSON.stringify(o);

/** A block call's result read back (a transcript, a tool row): answered, expired, or not one of ours. */
export function readOutcome(text: string | undefined): BlockOutcome | undefined {
  const t = text?.trim();
  if (!t?.startsWith("{")) return undefined;
  try {
    const o = JSON.parse(t) as Record<string, unknown>;
    if (o.answered === true && typeof o.said === "string") return drop({ answered: true as const, value: o.value, text: typeof o.text === "string" ? o.text : undefined, said: o.said });
    if (o.expired === true) return { expired: true, reason: typeof o.reason === "string" ? o.reason : "It ended without an answer." };
    if (o.shown === true) return shownOutcome;
  } catch {
    // Not JSON: not a block's result.
  }
  return undefined;
}

/** A block with its outcome on it. */
export function settled(block: ChatBlock, o: BlockOutcome): ChatBlock {
  if ("expired" in o) return { ...block, state: "expired", reason: o.reason, answer: undefined };
  if ("shown" in o) return { ...block, state: "shown", reason: undefined, answer: undefined };
  return { ...block, state: "answered", reason: undefined, answer: drop({ value: o.value, text: o.text, said: o.said }) };
}
