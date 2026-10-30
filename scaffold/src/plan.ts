import { findPackage, shortName, suggestPackages, type CatalogueEntry } from "./catalogue.js";
import { kindFromWords, kindOf, type AppKind } from "./kinds.js";

// The plan: what the new project is, decided from Ben's words and his answers.
// Claude writes most of it (interview.ts gives it the prompt and the schema);
// normalizePlan makes whatever came back safe to build from.

export interface AppQuestion {
  id: string;
  text: string;
  /** Up to a handful of answers to pick from; empty for a typed answer. */
  options: string[];
  /** A typed answer is welcome beside the options. */
  other?: boolean;
  /** A note rather than a decision (Anything else?): a multiline answer in his own words, and leaving it empty is fine. */
  freeform?: boolean;
}

export interface AppAnswer {
  /** The question's id, when it came from a plan. */
  id?: string;
  question: string;
  answer: string;
}

/**
 * The question every round ends on: whatever he wants to add, in his own
 * words, freeform and optional. normalizePlan appends it after the round's
 * questions, as `else`, then `else-2`… when an earlier round answered it.
 */
export const ANYTHING_ELSE: AppQuestion = { id: "else", text: "Anything else?", options: [], other: true, freeform: true };

const isElseText = (text: string) => text.trim().toLowerCase() === ANYTHING_ELSE.text.toLowerCase();

/** An answer to Anything else?, from any round: his notes. */
export const isNote = (a: AppAnswer): boolean => isElseText(a.question) || /^else(-\d+)?$/.test(a.id ?? "");

export interface VerticalInfo {
  id: string;
  name: string;
  line?: string;
}

export interface PlanRequest {
  /** What Ben typed. */
  description: string;
  answers?: AppAnswer[];
  /** A name Ben already chose. */
  name?: string;
  /** Ben's "Not quite" on this plan: before it's built, ask more and expand on the vision. */
  more?: AppPlan;
}

export interface PlanContext {
  catalogue: CatalogueEntry[];
  verticals: VerticalInfo[];
  /** Folder names already taken in the apps home and the packages home, lowercase. */
  taken: string[];
  /** The vertical a plan lands in when nothing says otherwise. */
  defaultVertical?: string;
}

export interface AppPlan {
  name: string;
  /** The folder name. */
  slug: string;
  kind: AppKind;
  vertical: string;
  /** One sentence: what it does. */
  summary: string;
  /** The vision, in a few short points: what it does and how it should feel. It grows as Ben answers more. */
  features: string[];
  /** Ben's words. */
  description: string;
  answers: AppAnswer[];
  /** BPM packages it builds on, by short name. */
  packages: string[];
  /** A shared package the app clearly needs that doesn't exist yet. */
  newPackage?: { name: string; why: string };
  /** What's still to ask; empty once the plan is ready. */
  questions: AppQuestion[];
  ready: boolean;
  /** The first milestones for the Claude Code session that builds it. */
  firstSteps: string[];
  /** Who made the plan and anything it had to guess. */
  note?: string;
}

export const DEFAULT_VERTICALS: VerticalInfo[] = [
  { id: "gt", name: "Godspeed Talent", line: "Force Majeure and Delphi" },
  { id: "fm", name: "Force Majeure", line: "Shows, Wildfire, internal tools" },
  { id: "delphi", name: "Delphi", line: "Projections, ticketing, bookings" },
  { id: "nhi", name: "NHI", line: "Releases, visuals, the music library" },
  { id: "personal", name: "Personal", line: "Career, money, daily life" },
  { id: "ai", name: "AI", line: "Image, video, training, LLMs" },
  { id: "games", name: "Games", line: "Narrative, tabletop, lore, bots" },
  { id: "utilities", name: "Utilities", line: "Small tools" },
];

const MAX_SLUG = 40;

/** A folder name from a name: lowercase words joined by dashes. */
export function slugify(s: string): string {
  const slug = s
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-")
    .slice(0, MAX_SLUG)
    .replace(/-+$/g, "");
  return slug || "new-app";
}

/** `slug`, or `slug-2`, `slug-3`… when it's taken. */
export function uniqueSlug(slug: string, taken: string[]): string {
  const set = new Set(taken.map((t) => t.toLowerCase()));
  if (!set.has(slug)) return slug;
  for (let n = 2; ; n++) if (!set.has(`${slug}-${n}`)) return `${slug}-${n}`;
}

const STOP = new Set(["a", "an", "the", "that", "which", "for", "to", "of", "and", "my", "me", "i", "it", "with", "from", "in", "on", "app", "tool", "something", "want", "build", "make", "create", "new", "little", "small", "simple"]);

/** A name from a description: its first few telling words, capitalized. */
export function nameFromDescription(description: string): string {
  const words = description
    .replace(/[^\p{L}\p{N}\s'-]/gu, " ")
    .split(/\s+/)
    .filter((w) => w && !STOP.has(w.toLowerCase()));
  const picked = words.slice(0, 2).map((w) => (w === w.toUpperCase() && w.length <= 4 ? w : w[0].toUpperCase() + w.slice(1).toLowerCase()));
  return picked.join(" ") || "New app";
}

/** The first sentence of a description, trimmed to one line. */
export function firstSentence(text: string, max = 160): string {
  const one = text.replace(/\s+/g, " ").trim();
  const m = /^(.+?[.!?])(\s|$)/.exec(one);
  const s = (m ? m[1] : one).trim();
  return s.length > max ? `${s.slice(0, max - 1).trimEnd()}…` : s;
}

/** The vertical a plan names, by id or name; undefined when it's not one of Ben's. */
export function findVertical(name: unknown, verticals: VerticalInfo[]): VerticalInfo | undefined {
  if (typeof name !== "string") return undefined;
  const n = name.trim().toLowerCase();
  return verticals.find((v) => v.id.toLowerCase() === n) ?? verticals.find((v) => v.name.toLowerCase() === n);
}

/** A guess at the vertical from what the app is about. */
export function verticalFromWords(text: string, verticals: VerticalInfo[]): string | undefined {
  const t = text.toLowerCase();
  const has = (id: string) => verticals.some((v) => v.id === id);
  const guess =
    (/\bnhi\b|\brelease|\btrack|\balbum|\bsoundcloud|\bspotify|\bableton|\bmusic\b|\bsong|\bvisuali[sz]er|\bcanvas\b/.test(t) && "nhi") ||
    (/\bdelphi\b|\bprojection|\bbooking|\bhold\b|\boffer\b/.test(t) && "delphi") ||
    (/\bforce majeure\b|\bfm\b|\bwildfire\b|\bshow(s)?\b|\bticket|\bvenue|\bevent\b/.test(t) && "fm") ||
    (/\bgame\b|\bgames\b|\bd&d\b|\bdnd\b|\btabletop\b|\blore\b|\bnarrative\b|\bbattlemap\b|\bnpc\b|\bworld\b/.test(t) && "games") ||
    (/\bimage\b|\bimages\b|\bcomfy|\blora\b|\bllm\b|\bai\b|\bmodel\b|\btrain/.test(t) && "ai") ||
    (/\bjob|\bcareer|\bmoney|\bbudget|\bynab|\btodo|\btask|\bhabit|\bjournal|\bpersonal\b|\bhome\b|\bmail\b|\bcalendar\b/.test(t) && "personal") ||
    undefined;
  return guess && has(guess) ? guess : undefined;
}

type Raw = Record<string, unknown>;
const obj = (v: unknown): Raw => (v && typeof v === "object" && !Array.isArray(v) ? (v as Raw) : {});
const str = (v: unknown): string => (typeof v === "string" ? v.trim() : "");
const strs = (v: unknown, max: number): string[] => (Array.isArray(v) ? v.map(str).filter(Boolean).slice(0, max) : []);

const MAX_QUESTIONS = 4;
const MAX_OPTIONS = 7;

/** The packages a plan builds on: the kind's own, every valid one named, and when none were named, the ones the description calls for. */
export function packagesFor(kind: AppKind, named: string[], description: string, catalogue: CatalogueEntry[]): string[] {
  const base = kindOf(kind)?.packages.filter((p) => findPackage(p, catalogue)) ?? [];
  const valid = named.map((n) => findPackage(n, catalogue)).filter((e): e is CatalogueEntry => Boolean(e)).map((e) => shortName(e.name));
  const extra = valid.length ? valid : suggestPackages(kind, description, catalogue);
  return [...new Set([...base, ...extra])];
}

/**
 * Whatever Claude (or anything) answered, made into a plan that's safe to
 * build from: a real kind, one of Ben's verticals, a free folder name, only
 * packages that exist, and the questions he hasn't answered yet.
 */
export function normalizePlan(raw: unknown, req: PlanRequest, ctx: PlanContext): AppPlan {
  const r = obj(raw);
  const description = req.description.trim();
  const answers = req.answers ?? [];
  const kind: AppKind = kindOf(str(r.kind))?.id ?? kindFromWords(str(r.kind)) ?? kindFromWords(description) ?? "web";
  const name = str(r.name) || str(req.name) || nameFromDescription(description);
  const slug = uniqueSlug(slugify(str(r.slug) || name), ctx.taken);
  const vertical = findVertical(r.vertical, ctx.verticals)?.id ?? verticalFromWords(description, ctx.verticals) ?? ctx.defaultVertical ?? ctx.verticals[0]?.id ?? "utilities";
  const summary = str(r.summary) || firstSentence(description);
  const packages = packagesFor(kind, strs(r.packages, 20), `${description} ${answers.map((a) => a.answer).join(" ")}`, ctx.catalogue);
  const np = obj(r.newPackage);
  const newPackage = str(np.name) && str(np.why) ? { name: slugify(str(np.name)), why: str(np.why) } : undefined;
  const answeredText = new Set(answers.map((a) => a.question.trim().toLowerCase()));
  const answeredId = new Set(answers.map((a) => a.id).filter((id): id is string => Boolean(id)));
  const ids = new Set<string>();
  const questions: AppQuestion[] = (Array.isArray(r.questions) ? r.questions : [])
    .map((q, i) => {
      const o = obj(q);
      const text = str(o.text) || str(o.question);
      const options = strs(o.options, MAX_OPTIONS);
      return { id: str(o.id) || `q${i + 1}`, text, options, other: typeof o.other === "boolean" ? o.other : options.length === 0 };
    })
    // Asked already, word for word, or (outside a Not quite round, which asks new things) under the same id. A catch-all is dropped: Anything else? is appended below.
    .filter((q) => q.text && !isElseText(q.text) && !answeredText.has(q.text.toLowerCase()) && (req.more || !answeredId.has(q.id)))
    .slice(0, MAX_QUESTIONS)
    .map((q) => {
      let id = q.id;
      for (let n = 2; answeredId.has(id) || ids.has(id); n++) id = `${q.id}-${n}`;
      ids.add(id);
      return { ...q, id };
    });
  // A Not quite round is for asking: it's ready only when there's nothing left to ask.
  const ready = req.more ? questions.length === 0 : r.ready === true || questions.length === 0;
  // Every round ends on Anything else?: his own notes, freeform and skippable, under an id no earlier round used.
  if (!ready) {
    let id = ANYTHING_ELSE.id;
    for (let n = 2; answeredId.has(id) || ids.has(id); n++) id = `${ANYTHING_ELSE.id}-${n}`;
    questions.push({ ...ANYTHING_ELSE, id });
  }
  const features = strs(r.features, 8);
  const firstSteps = strs(r.firstSteps, 6);
  return {
    name,
    slug,
    kind,
    vertical,
    summary,
    features: features.length ? features : (req.more?.features ?? []),
    description,
    answers,
    packages,
    newPackage,
    questions: ready ? [] : questions,
    ready,
    firstSteps: firstSteps.length ? firstSteps : defaultFirstSteps(kind),
    note: str(r.note) || undefined,
  };
}

/** Sensible first milestones when the plan has none. */
export function defaultFirstSteps(kind: AppKind): string[] {
  const common = ["npm install, then confirm the scaffold runs (npm run dev or npm start)."];
  const byKind: Record<AppKind, string[]> = {
    electron: ["Lay out the main window: the one screen the app is for, on the design the brief describes.", "Wire the main process to what the app reads or runs, over typed IPC.", "Persist what it should remember (sqlite-store if it's data, electron-kit's window state for the window)."],
    web: ["Build the one page the app is for, with its data loading.", "Add the dev server to Benhäus's service list if it should start on open."],
    service: ["Define the endpoints and what each answers.", "Add a /health check Benhäus can watch, and the port it listens on."],
    cli: ["Parse the arguments and run the main action end to end.", "Print clear output and exit codes; add --help."],
    mcp: ["Define the tools: names, descriptions, input schemas, handlers.", "Register the server with Claude Code (claude mcp add) and try each tool."],
    bot: ["Put the bot token in .env and get it online in the right server.", "Implement the first command or trigger the brief describes."],
    package: ["Write the API in src/index.ts with tests beside it.", "Build it and link it from the first app that uses it; delete the copy it replaces."],
  };
  return [...common, ...byKind[kind]];
}
