// A small, lenient, single-pass XML tag scanner for Ableton documents.
//
// Why not a regex over the text: real sets break the obvious ones. Paths carry
// apostrophes inside double-quoted values (Splice pack names do), entities are
// escaped (`&amp;`, `&#39;`, `&#x0A;`), and `<Path Value>` also appears outside
// file references (a VST's DLL path). Why not a DOM parser: sets reach tens of MB
// and only a handful of elements matter. This walks tags once, honours quotes,
// skips comments, CDATA, processing instructions and DOCTYPE, and hands each
// tag to the caller with its offsets.

export interface XmlTag {
  name: string;
  /** Offset of the `<`. */
  start: number;
  /** Offset just past the `>`. */
  end: number;
  selfClosing: boolean;
  /** The text between the name and the closing `>` / `/>`: the attributes, undecoded. */
  rawAttrs: string;
}

export interface XmlHandler {
  /** Return true to stop scanning. */
  open?(tag: XmlTag): boolean | void;
  /**
   * Called for every end tag, and right after open() for a self-closing tag.
   * `start` is the offset of the end tag's `<` (for a self-closing tag, its `end`).
   */
  close?(name: string, start: number): boolean | void;
}

export function scanXml(xml: string, h: XmlHandler): void {
  const n = xml.length;
  let i = 0;
  while (i < n) {
    const lt = xml.indexOf("<", i);
    if (lt === -1) return;
    const c = xml.charCodeAt(lt + 1);
    if (c === 63 /* ? */) {
      i = after(xml, "?>", lt + 2);
      continue;
    }
    if (c === 33 /* ! */) {
      if (xml.startsWith("!--", lt + 1)) i = after(xml, "-->", lt + 4);
      else if (xml.startsWith("![CDATA[", lt + 1)) i = after(xml, "]]>", lt + 9);
      else i = after(xml, ">", lt + 2);
      continue;
    }
    if (c === 47 /* / */) {
      const gt = xml.indexOf(">", lt + 2);
      const name = xml.slice(lt + 2, gt === -1 ? n : gt).trim();
      i = gt === -1 ? n : gt + 1;
      if (h.close?.(name, lt) === true) return;
      continue;
    }
    // Start tag: find its `>` outside quotes.
    let j = lt + 1;
    let quote = 0;
    for (; j < n; j++) {
      const ch = xml.charCodeAt(j);
      if (quote) {
        if (ch === quote) quote = 0;
      } else if (ch === 34 || ch === 39) quote = ch;
      else if (ch === 62 /* > */) break;
    }
    let bodyEnd = j;
    const selfClosing = xml.charCodeAt(j - 1) === 47 /* / */;
    if (selfClosing) bodyEnd--;
    let k = lt + 1;
    while (k < bodyEnd && !isSpace(xml.charCodeAt(k))) k++;
    const name = xml.slice(lt + 1, k);
    const end = j < n ? j + 1 : n;
    i = end;
    if (!name) continue;
    const tag: XmlTag = { name, start: lt, end, selfClosing, rawAttrs: xml.slice(k, bodyEnd) };
    if (h.open?.(tag) === true) return;
    if (selfClosing && h.close?.(name, end) === true) return;
  }
}

/** One attribute's decoded value, or undefined when the tag doesn't have it. */
export function attr(tag: XmlTag, key: string): string | undefined {
  let found: string | undefined;
  eachAttr(tag.rawAttrs, (name, value) => {
    if (name !== key) return false;
    found = decodeXmlEntities(value);
    return true;
  });
  return found;
}

/** All attributes, decoded. */
export function attrs(tag: XmlTag): Record<string, string> {
  const out: Record<string, string> = {};
  eachAttr(tag.rawAttrs, (name, value) => {
    out[name] = decodeXmlEntities(value);
    return false;
  });
  return out;
}

/** Walks `name="value"` pairs in order, so text inside one value can't pose as another attribute. */
function eachAttr(raw: string, visit: (name: string, rawValue: string) => boolean): void {
  const n = raw.length;
  let p = 0;
  while (p < n) {
    while (p < n && isSpace(raw.charCodeAt(p))) p++;
    const nameStart = p;
    while (p < n && raw.charCodeAt(p) !== 61 /* = */ && !isSpace(raw.charCodeAt(p))) p++;
    const name = raw.slice(nameStart, p);
    while (p < n && isSpace(raw.charCodeAt(p))) p++;
    if (!name || raw.charCodeAt(p) !== 61) {
      // A bare word (not valid XML): skip it.
      if (p === nameStart) p++;
      continue;
    }
    p++;
    while (p < n && isSpace(raw.charCodeAt(p))) p++;
    const q = raw.charCodeAt(p);
    if (q !== 34 && q !== 39) return;
    const close = raw.indexOf(q === 34 ? '"' : "'", p + 1);
    if (close === -1) return;
    if (visit(name, raw.slice(p + 1, close))) return;
    p = close + 1;
  }
}

const NAMED: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };

/** Decodes the five named XML entities and numeric references (`&#39;`, `&#x0A;`). */
export function decodeXmlEntities(s: string): string {
  if (s.indexOf("&") === -1) return s;
  return s.replace(/&(#[xX][0-9a-fA-F]+|#[0-9]+|[A-Za-z]+);/g, (m, e: string) => {
    if (e[0] === "#") {
      const hex = e[1] === "x" || e[1] === "X";
      const cp = parseInt(e.slice(hex ? 2 : 1), hex ? 16 : 10);
      return Number.isFinite(cp) && cp >= 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : m;
    }
    return NAMED[e] ?? m;
  });
}

function after(xml: string, token: string, from: number): number {
  const at = xml.indexOf(token, from);
  return at === -1 ? xml.length : at + token.length;
}

function isSpace(c: number): boolean {
  return c === 32 || c === 9 || c === 10 || c === 13;
}
