import { pickWords } from "@btkulka/chat-blocks";
import type { ChatItem } from "../types.js";

// Images in a row in a reply, as a carousel Ben picks from: which lines make
// one, what a pick says, and which image each carousel shows as picked, read
// back from the conversation (a later message of his starting "Picked"), so
// it holds through a redraw and a restart. No React here: the tests run it in
// Node.

/** An image in the conversation: a kept image's id, or the path or address a reply named. */
export interface Pic {
  ref: string;
  /** Its file name, which Download starts from. */
  name?: string;
  /** What a reply called it (markdown's alt text). */
  alt?: string;
}

const MD_IMAGE = /!\[([^\]\n]*)\]\(([^)\n]+)\)/g;
/** A markdown image's address: without <…> around it or a "title" after it. */
export const mdSrc = (raw: string) => raw.trim().replace(/^<(.*)>$/, "$1").replace(/\s+"[^"]*"$/, "");
/** The images a reply shows, outside its code blocks. */
export const picsIn = (text: string): Pic[] => [...text.replace(/```[\s\S]*?```/g, "").matchAll(MD_IMAGE)].map((m) => ({ ref: mdSrc(m[2]), alt: m[1].trim() || undefined }));

/** A line that's only markdown images (one, or several with spaces between): its images. Never a table's row, so a pipe rules it out. */
export function imageLine(line: string): Pic[] | undefined {
  const t = line.trim();
  if (!t.startsWith("![") || t.includes("|")) return undefined;
  const pics: Pic[] = [];
  const rest = t.replace(MD_IMAGE, (_, alt: string, src: string) => (pics.push({ ref: mdSrc(src), alt: alt.trim() || undefined }), " "));
  return pics.length && !rest.trim() ? pics : undefined;
}

/**
 * The image lines from line `i` on, blank lines between them allowed: their
 * images, and the last image line's index. Undefined when line `i` isn't one.
 * Two or more images make a carousel; one stays a picture of its own.
 */
export function imageRun(lines: readonly string[], i: number): { pics: Pic[]; end: number } | undefined {
  const first = imageLine(lines[i] ?? "");
  if (!first) return undefined;
  const pics = [...first];
  let end = i;
  for (let j = i + 1; j < lines.length; j++) {
    if (!lines[j].trim()) continue;
    const more = imageLine(lines[j]);
    if (!more) break;
    pics.push(...more);
    end = j;
  }
  return { pics, end };
}

/** The carousels a reply draws, in order: each run of two or more images outside its code blocks, as Prose finds them. */
export function carouselsIn(text: string): Pic[][] {
  const lines = text.split("\n");
  const out: Pic[][] = [];
  for (let i = 0; i < lines.length; i++) {
    if (/^\s*```/.test(lines[i])) {
      while (++i < lines.length && !/^\s*```\s*$/.test(lines[i]));
      continue;
    }
    const run = imageRun(lines, i);
    if (!run) continue;
    if (run.pics.length > 1) out.push(run.pics);
    i = run.end;
  }
  return out;
}

/** A carousel's name among the conversation's: its images' addresses, in order. */
export const setKey = (pics: readonly Pic[]) => pics.map((p) => p.ref).join("\n");

/** What Pick sends, as Ben's message: "Picked 2 of 4: the misty harbor (D:\renders\harbor.png)", worded by chat-blocks' pickWords so a pick block says it the same way. An image written into the reply as data: goes without its address. */
export const pickText = (pics: readonly Pic[], at: number): string => pickWords(pics, at);

/** Which carousel image a "Picked …" message names: the latest carousel before it with the image whose address ends it, else the latest whose size fits its "N of M". */
function named(text: string, sets: readonly Pic[][]): { set: Pic[]; ref: string } | undefined {
  for (let s = sets.length - 1; s >= 0; s--) {
    const hit = sets[s].find((p) => text.endsWith(`(${p.ref})`));
    if (hit) return { set: sets[s], ref: hit.ref };
  }
  const n = /^picked\s+#?(\d+)(?:\s+of\s+(\d+))?/i.exec(text);
  if (!n) return undefined;
  const at = Number(n[1]) - 1;
  const of = n[2] ? Number(n[2]) : undefined;
  for (let s = sets.length - 1; s >= 0; s--) if (sets[s][at] && (of === undefined || sets[s].length === of)) return { set: sets[s], ref: sets[s][at].ref };
  return undefined;
}

/** The picks in a conversation: each carousel's key (setKey) to the address of the image Ben picked from it last. */
export function picksIn(items: readonly ChatItem[]): Map<string, string> {
  const sets: Pic[][] = [];
  const picked = new Map<string, string>();
  for (const it of items) {
    if (it.kind === "claude") sets.push(...carouselsIn(it.text));
    else if (it.kind === "you" && /^picked\b/i.test(it.text.trim())) {
      const hit = named(it.text.trim(), sets);
      if (hit) picked.set(setKey(hit.set), hit.ref);
    }
  }
  return picked;
}

/** Where a carousel's pick is in it, if it has one. */
export function pickedAt(pics: readonly Pic[], picks: ReadonlyMap<string, string> | undefined): number | undefined {
  const ref = picks?.get(setKey(pics));
  const at = ref === undefined ? -1 : pics.findIndex((p) => p.ref === ref);
  return at < 0 ? undefined : at;
}
