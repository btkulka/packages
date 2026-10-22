/**
 * The lore markdown format — the authoring surface for canon.
 *
 * A lore file is a bullet list. Each bullet is one fact. The obscurity may ride the
 * bullet inline, and trailing `#tokens` become tags:
 *
 *     ---
 *     obscurity: common
 *     tags: [brass-lantern]
 *     ---
 *     - The taproom keeps a ledger of every debt owed in town
 *     - [secret] The cellar floods every spring and the landlord hides it #flood
 *
 * Frontmatter supplies defaults (collection, charId, tags, obscurity); anything on the
 * bullet overrides or extends it. A fact with no obscurity from either source is an
 * error rather than a guess — silently defaulting would make a secret public.
 *
 * Ported verbatim from orson's `src/lore/format.ts` so both projects parse one format.
 */
import { OBSCURITY, type Collection } from "../types.js";

export interface LoreFact {
  collection: Collection;
  charId: string;
  text: string;
  obscurity: number;
  tags: string[];
}

export interface PathDefaults {
  collection: Collection;
  charId: string;
}

interface Frontmatter {
  collection?: Collection;
  charId?: string;
  tags?: string[];
  obscurity?: number;
}

const OBSCURITY_KEYWORDS: Record<string, number> = {
  trivial: OBSCURITY.trivial,
  common: OBSCURITY.common,
  uncommon: OBSCURITY.uncommon,
  rare: OBSCURITY.rare,
  hidden: OBSCURITY.hidden,
  secret: OBSCURITY.secret,
};

const TAG_TOKEN = /^#[A-Za-z_][A-Za-z0-9_:-]*$/;
const BULLET_PREFIX = /^[-*]\s+/;

function splitFrontmatter(raw: string): { yaml: string | null; body: string } {
  if (!raw.startsWith("---")) return { yaml: null, body: raw };
  const rest = raw.slice(3);
  const headEnd = rest.indexOf("\n");
  if (headEnd === -1) return { yaml: null, body: raw };
  const afterOpen = rest.slice(headEnd + 1);
  const closeMatch = afterOpen.match(/\n?---\s*(?:\n|$)/);
  if (!closeMatch || closeMatch.index === undefined) return { yaml: null, body: raw };
  const yaml = afterOpen.slice(0, closeMatch.index);
  const body = afterOpen.slice(closeMatch.index + closeMatch[0].length);
  return { yaml, body };
}

function parseFrontmatterYaml(yaml: string): Frontmatter {
  const fm: Frontmatter = {};
  for (const rawLine of yaml.split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const colon = line.indexOf(":");
    if (colon === -1) continue;
    const key = line.slice(0, colon).trim();
    const value = line.slice(colon + 1).trim();
    if (key === "tags") {
      fm.tags = parseInlineList(value);
    } else if (key === "collection") {
      if (value === "world_truth" || value === "character_memories" || value === "common_knowledge") {
        fm.collection = value;
      }
    } else if (key === "charId") {
      fm.charId = stripQuotes(value);
    } else if (key === "obscurity") {
      const n = parseObscurityValue(value);
      if (n !== null) fm.obscurity = n;
    }
  }
  return fm;
}

function parseInlineList(raw: string): string[] {
  const trimmed = raw.trim();
  if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
    return trimmed
      .slice(1, -1)
      .split(",")
      .map((s) => stripQuotes(s.trim()))
      .filter((s) => s.length > 0);
  }
  // Fallback: single scalar value, treat as one-element list.
  if (trimmed.length === 0) return [];
  return [stripQuotes(trimmed)];
}

function stripQuotes(s: string): string {
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    return s.slice(1, -1);
  }
  return s;
}

function parseObscurityValue(raw: string): number | null {
  const trimmed = raw.trim().toLowerCase();
  const asNum = Number(trimmed);
  if (Number.isFinite(asNum)) return asNum;
  if (trimmed in OBSCURITY_KEYWORDS) return OBSCURITY_KEYWORDS[trimmed];
  return null;
}

interface BulletParts {
  obscurity: number | null;
  text: string;
  tags: string[];
}

function parseBullet(line: string): BulletParts | null {
  const stripped = line.replace(BULLET_PREFIX, "");
  if (stripped === line) return null;
  const tokens = stripped.trim().split(/\s+/);
  const tags: string[] = [];
  while (tokens.length > 0 && TAG_TOKEN.test(tokens[tokens.length - 1])) {
    tags.unshift(tokens.pop()!.slice(1));
  }
  let obscurity: number | null = null;
  if (tokens[0]?.startsWith("[")) {
    const first = tokens[0];
    const close = first.indexOf("]");
    if (close !== -1) {
      const label = first.slice(1, close);
      const parsed = parseObscurityValue(label);
      if (parsed !== null) {
        obscurity = parsed;
        const remainder = first.slice(close + 1);
        if (remainder.length > 0) tokens[0] = remainder;
        else tokens.shift();
      }
    }
  }
  const text = tokens.join(" ").trim();
  if (!text) return null;
  return { obscurity, text, tags };
}

export function parseLoreFile(raw: string, defaults: PathDefaults): LoreFact[] {
  const { yaml, body } = splitFrontmatter(raw);
  const fm = yaml !== null ? parseFrontmatterYaml(yaml) : {};
  const collection = fm.collection ?? defaults.collection;
  const charId = fm.charId ?? defaults.charId;
  const defaultTags = fm.tags ?? [];
  const defaultObscurity = fm.obscurity;

  const facts: LoreFact[] = [];
  for (const line of body.split("\n")) {
    const bullet = parseBullet(line);
    if (!bullet) continue;
    const obscurity = bullet.obscurity ?? defaultObscurity;
    if (obscurity === undefined) {
      throw new Error(
        `Lore fact missing obscurity and no default in frontmatter: "${bullet.text.slice(0, 60)}..."`,
      );
    }
    const merged = mergeTags(defaultTags, bullet.tags);
    facts.push({ collection, charId, text: bullet.text, obscurity, tags: merged });
  }
  return facts;
}

/**
 * A readable thing in the world — a ledger, a letter, a posted notice — parsed from
 * `lore/documents/*.md`. Its bullets are its CONTENTS, indexed as common knowledge so
 * retrieval surfaces them; its frontmatter is what makes it an object rather than a
 * loose set of facts: a title, and where it physically sits.
 *
 * Returned alongside the facts rather than instead of them, because a document is both:
 * a thing you can find in the world, and a source of things the town knows.
 */
export interface LoreDocument {
  /** Slug from the filename. */
  id: string;
  title: string;
  /** Location id or free-text placement — where the thing physically is. */
  where?: string;
  /** One-line description of the object itself, not its contents. */
  blurb?: string;
  facts: LoreFact[];
}

/** Read frontmatter keys `parseLoreFile` ignores (title, where, blurb, …). */
export function parseDocumentMeta(raw: string): Record<string, string> {
  const { yaml } = splitFrontmatter(raw);
  const out: Record<string, string> = {};
  if (!yaml) return out;
  for (const rawLine of yaml.split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const colon = line.indexOf(":");
    if (colon === -1) continue;
    out[line.slice(0, colon).trim()] = stripQuotes(line.slice(colon + 1).trim());
  }
  return out;
}

/** Parse one `lore/documents/*.md` into a {@link LoreDocument}. */
export function parseLoreDocument(raw: string, id: string): LoreDocument {
  const meta = parseDocumentMeta(raw);
  return {
    id,
    title: meta.title || id.replace(/[-_]/g, " "),
    where: meta.where || undefined,
    blurb: meta.blurb || undefined,
    facts: parseLoreFile(raw, { collection: "common_knowledge", charId: "" }),
  };
}

function mergeTags(a: string[], b: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const t of [...a, ...b]) {
    if (!seen.has(t)) {
      seen.add(t);
      out.push(t);
    }
  }
  return out;
}

/**
 * Infer (collection, charId) from a file's path relative to the lore/ root.
 *   world/*.md               → world_truth
 *   common/*.md              → common_knowledge
 *   documents/*.md           → common_knowledge  (a readable thing in the world)
 *   characters/<id>/*.md     → character_memories + charId = <id>
 *   anything else            → null (caller should skip)
 *
 * DOCUMENTS are common_knowledge rather than a fourth collection: what a ledger or a
 * posted notice says is knowledge anyone who reads it comes to hold, and retrieval
 * should surface it on the same footing as anything else the town knows. What makes a
 * document a document is its FRONTMATTER — a title, where it physically is, and a
 * `document` tag — not a separate table. Adding a collection would have meant a schema
 * change in every consumer for something the existing shape already models.
 */
export function defaultsForPath(relativePath: string): PathDefaults | null {
  const parts = relativePath.split(/[\\/]/).filter(Boolean);
  if (parts.length < 2) return null;
  const [first, second] = parts;
  if (first === "world") return { collection: "world_truth", charId: "" };
  if (first === "common" || first === "documents") {
    return { collection: "common_knowledge", charId: "" };
  }
  if (first === "characters" && parts.length >= 3) {
    return { collection: "character_memories", charId: second };
  }
  return null;
}
