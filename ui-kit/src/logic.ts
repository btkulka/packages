// The kit's decisions as plain functions (no DOM, no React), so they're tested on their own:
// reading an amount someone typed, stepping a number, splitting tags, whether a swipe commits,
// which rows of an animated list are still on screen, ISO dates, and an avatar's initials and hue.

const FRACTIONS: Record<string, number> = { "¼": 0.25, "½": 0.5, "¾": 0.75, "⅓": 1 / 3, "⅔": 2 / 3, "⅛": 0.125, "⅜": 0.375, "⅝": 0.625, "⅞": 0.875 };

/** "2", "1.5", "1,5", "1/2", "1 1/2", "1½", "½" → a number; anything else (or blank) → null. */
export function parseAmount(text: string): number | null {
  let s = text.trim();
  if (!s) return null;
  let extra = 0;
  const last = s.slice(-1);
  if (last in FRACTIONS) {
    extra = FRACTIONS[last];
    s = s.slice(0, -1).trim();
    if (!s) return extra;
  }
  const mixed = /^(\d+)\s+(\d+)\s*\/\s*(\d+)$/.exec(s);
  if (mixed) {
    const d = Number(mixed[3]);
    return d ? Number(mixed[1]) + Number(mixed[2]) / d + extra : null;
  }
  const frac = /^(\d+)\s*\/\s*(\d+)$/.exec(s);
  if (frac) {
    const d = Number(frac[2]);
    return d ? Number(frac[1]) / d + extra : null;
  }
  if (!/^-?\d*(?:[.,]\d+)?$/.test(s) || s === "-") return null;
  const n = Number(s.replace(",", "."));
  return Number.isFinite(n) ? n + extra : null;
}

/** Rounds to `precision` decimals (null: as it is), dodging 0.1 + 0.2. */
export function roundTo(n: number, precision: number | null | undefined): number {
  if (precision === null || precision === undefined) return Math.round(n * 1e9) / 1e9;
  const f = 10 ** precision;
  return Math.round(n * f) / f;
}

export function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n));
}

export interface StepOptions {
  step: number;
  min: number;
  max: number;
  precision?: number | null;
}

/**
 * One step up or down, landing on the step grid: 1.3 up by 0.5 is 1.5, not 1.8. A blank value
 * starts at the bottom of the range going up (or at `step` when the range starts at 0), and at
 * `min` going down.
 */
export function stepValue(value: number | null, dir: 1 | -1, o: StepOptions): number {
  if (value === null || !Number.isFinite(value)) {
    const start = dir > 0 ? (o.min > 0 ? o.min : Math.min(o.step, o.max)) : o.min;
    return roundTo(clamp(start, o.min, o.max), o.precision);
  }
  const eps = 1e-9;
  const n = dir > 0 ? Math.floor(value / o.step + eps) * o.step + o.step : Math.ceil(value / o.step - eps) * o.step - o.step;
  return roundTo(clamp(n, o.min, o.max), o.precision);
}

/** How a number shows in a stepper: no trailing zeros, at most `precision` decimals. */
export function formatAmount(n: number | null, precision: number | null | undefined = 2): string {
  if (n === null || !Number.isFinite(n)) return "";
  return String(roundTo(n, precision ?? 2));
}

/** "pasta, quick; vegetarian\nlunch" → ["pasta", "quick", "vegetarian", "lunch"]. */
export function splitTags(text: string): string[] {
  return text
    .split(/[,;\n]/)
    .map((t) => t.trim().replace(/\s+/g, " "))
    .filter(Boolean);
}

export interface AddTagsOptions {
  allowDuplicates?: boolean;
  max?: number;
  transform?: (tag: string) => string;
}

/** The tags with the new ones added once each (case-insensitively), up to `max`. Same array back when nothing changed. */
export function addTags(existing: readonly string[], incoming: readonly string[], o: AddTagsOptions = {}): string[] {
  const out = [...existing];
  const seen = new Set(existing.map((t) => t.toLowerCase()));
  for (const raw of incoming) {
    const t = (o.transform ? o.transform(raw) : raw).trim();
    if (!t) continue;
    if (!o.allowDuplicates && seen.has(t.toLowerCase())) continue;
    if (o.max !== undefined && out.length >= o.max) break;
    out.push(t);
    seen.add(t.toLowerCase());
  }
  return out.length === existing.length ? (existing as string[]) : out;
}

export interface SwipeOptions {
  /** Share of the row's width past which letting go commits. */
  threshold?: number;
  /** Speed (px/ms) of a flick that commits however short it was. */
  flick?: number;
  /** A flick must still travel this far. */
  minFlickDistance?: number;
}

/**
 * Where a let-go swipe lands: "start" (the row went right, revealing the action at its start),
 * "end" (went left), or null (springs back). A flick commits early; a flick back cancels.
 */
export function swipeOutcome(dx: number, velocity: number, width: number, o: SwipeOptions = {}): "start" | "end" | null {
  const threshold = o.threshold ?? 0.33;
  const flick = o.flick ?? 0.55;
  const minFlick = o.minFlickDistance ?? 32;
  if (width <= 0 || dx === 0) return null;
  const dir = dx > 0 ? "start" : "end";
  // Moving back toward the middle when let go: no.
  if (Math.sign(velocity) === -Math.sign(dx) && Math.abs(velocity) > 0.2) return null;
  if (Math.abs(dx) >= width * threshold) return dir;
  if (Math.abs(velocity) >= flick && Math.abs(dx) >= minFlick && Math.sign(velocity) === Math.sign(dx)) return dir;
  return null;
}

/**
 * The keys an animated list shows: every current key in its order, plus keys that just left,
 * kept where they were (after the key that preceded them) until their exit finishes (`gone`).
 */
export function mergePresence(prev: readonly string[], next: readonly string[], gone: ReadonlySet<string>): string[] {
  const nextSet = new Set(next);
  const leaving = prev.filter((k) => !nextSet.has(k) && !gone.has(k));
  if (!leaving.length) return [...next];
  const out = [...next];
  const leavingSet = new Set(leaving);
  for (const k of leaving) {
    // Find the nearest earlier key in prev that is still placed in out, and go right after it.
    let i = prev.indexOf(k) - 1;
    let at = 0;
    while (i >= 0) {
      const before = prev[i];
      const pos = out.indexOf(before);
      if (pos >= 0 && (nextSet.has(before) || leavingSet.has(before))) {
        at = pos + 1;
        break;
      }
      i--;
    }
    out.splice(at, 0, k);
  }
  return out;
}

/** Whether keys present in both lists changed their order relative to each other. */
export function reordered(prev: readonly string[], next: readonly string[]): boolean {
  const nextSet = new Set(next);
  const prevSet = new Set(prev);
  const a = prev.filter((k) => nextSet.has(k));
  const b = next.filter((k) => prevSet.has(k));
  return a.some((k, i) => k !== b[i]);
}

/* ------------------------------------------------------------------ dates */

const isoRe = /^(\d{4})-(\d{2})-(\d{2})$/;

/** An ISO day (yyyy-mm-dd) as a Date at local noon, so no timezone moves it a day. */
export function isoToDate(iso: string): Date {
  const m = isoRe.exec(iso);
  if (!m) return new Date(NaN);
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 12);
}

export function dateToIso(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export function addDaysIso(iso: string, n: number): string {
  const d = isoToDate(iso);
  d.setDate(d.getDate() + n);
  return dateToIso(d);
}

/** Whole days from a to b (b later: positive). */
export function daysBetweenIso(a: string, b: string): number {
  return Math.round((isoToDate(b).getTime() - isoToDate(a).getTime()) / 86_400_000);
}

export function isIso(s: unknown): s is string {
  return typeof s === "string" && isoRe.test(s) && !Number.isNaN(isoToDate(s).getTime());
}

/* ----------------------------------------------------------------- people */

/** "Kourtney Smith" → "KS", "ben" → "B", "" → "?". */
export function initials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (!words.length) return "?";
  const first = [...words[0]][0] ?? "";
  const last = words.length > 1 ? ([...words[words.length - 1]][0] ?? "") : "";
  return (first + last).toUpperCase();
}

/** A steady hue (0–359) for a name, so the same person always gets the same colour. */
export function hueFor(name: string): number {
  let h = 0;
  for (const ch of name.trim().toLowerCase()) h = (h * 31 + ch.codePointAt(0)!) % 360;
  return h;
}

/* ------------------------------------------------------------ token completion */

// "2 avocados, spin" → the token being typed is "spin" (after the last comma), with any amount
// in front of it ("1 lb chick" → "chick" after "1 lb ") kept when a suggestion replaces it.
const AMOUNT = /^(\s*(?:(?:\d+(?:[.,]\d+)?|\d+\s*\/\s*\d+|[½¼¾⅓⅔]|a|an|one|two|three|a few|some)\s*(?:lbs?|oz|g|kg|ml|l|bags?|cans?|jars?|bunch(?:es)?|packs?|dozen|heads?|cloves?|boxes|box|bottles?|cartons?|x)?\s+)?)(.*)$/i;

export function currentToken(text: string): { before: string; amount: string; word: string } {
  const cut = Math.max(text.lastIndexOf(","), text.lastIndexOf(";"), text.lastIndexOf("\n"));
  const before = cut >= 0 ? text.slice(0, cut + 1) : "";
  const token = text.slice(cut + 1);
  const m = AMOUNT.exec(token) ?? ["", "", token];
  return { before, amount: m[1] ?? "", word: (m[2] ?? "").trimStart() };
}

/** The text with the token being typed replaced by `pick`, ready for the next one (", "). */
export function completeToken(text: string, pick: string): string {
  const { before, amount } = currentToken(text);
  const lead = before ? `${before.trimEnd()} ` : "";
  return `${lead}${amount.trimStart()}${pick}, `;
}

/** Suggestions for a word: starts-with first, then a word starting with it, then containing it; never the word itself. */
export function rankSuggestions(word: string, pool: readonly string[], limit = 6): string[] {
  const q = word.trim().toLowerCase();
  if (q.length < 1) return [];
  const starts: string[] = [];
  const wordStarts: string[] = [];
  const has: string[] = [];
  const seen = new Set<string>();
  for (const s of pool) {
    const l = s.toLowerCase();
    if (l === q || seen.has(l)) continue;
    seen.add(l);
    if (l.startsWith(q)) starts.push(s);
    else if (l.split(/[\s-]+/).some((w) => w.startsWith(q))) wordStarts.push(s);
    else if (q.length >= 3 && l.includes(q)) has.push(s);
  }
  const byLen = (a: string, b: string) => a.length - b.length || a.localeCompare(b);
  return [...starts.sort(byLen), ...wordStarts.sort(byLen), ...has.sort(byLen)].slice(0, limit);
}
