import { memo, type ReactNode } from "react";
import { useUi, type ClaudeUi } from "./context.js";
import { mdSrc, Thumb } from "./images.js";

// Claude's markdown, as far as a chat needs it: code blocks with Copy,
// headings, lists, tables, paragraphs, inline code, bold, links and images.

const PATH = /^[A-Za-z]:[\\/][^\s:*?"<>|]+(?::(\d+))?$/;

/** Inline code, bold, links, images (![what](a path or address)); a path in code opens through the app (ui.openPath, at its line) when it gives a way to. */
function inline(text: string, ui: ClaudeUi): ReactNode[] {
  return text.split(/(!\[[^\]\n]*\]\([^)\n]+\)|`[^`\n]+`|\*\*[^*\n]+\*\*|\[[^\]\n]+\]\([^)\s]+\)|https?:\/\/[^\s)>\]]+)/g).map((t, i) => {
    const img = /^!\[([^\]\n]*)\]\(([^)\n]+)\)$/.exec(t);
    if (img) return <Thumb key={i} pic={{ ref: mdSrc(img[2]), alt: img[1] || undefined }} size="lg" />;
    if (t.startsWith("`") && t.endsWith("`") && t.length > 2) {
      const code = t.slice(1, -1);
      const p = ui.openPath && !ui.phone ? PATH.exec(code) : null;
      if (!p) return <code key={i}>{code}</code>;
      const file = p[1] ? code.slice(0, code.lastIndexOf(":")) : code;
      return (
        <button key={i} type="button" className="ck-path" title="Open" onClick={() => ui.openPath?.(file, p[1] ? Number(p[1]) : undefined)}>
          {code}
        </button>
      );
    }
    if (t.startsWith("**") && t.endsWith("**") && t.length > 4) return <strong key={i}>{t.slice(2, -2)}</strong>;
    const link = /^\[([^\]]+)\]\(([^)\s]+)\)$/.exec(t);
    const href = link ? link[2] : /^https?:\/\//.test(t) ? t : undefined;
    if (href)
      return (
        <a key={i} href={href} onClick={(e) => (e.preventDefault(), ui.openLink(href))}>
          {link ? link[1] : t}
        </a>
      );
    return t;
  });
}

function CodeBlock({ code }: { code: string }) {
  const ui = useUi();
  return (
    <div className="ck-codewrap">
      <pre className="ck-code">
        <code>{code}</code>
      </pre>
      <button
        type="button"
        className="ck-chip ck-copy"
        onClick={() =>
          void ui.copy(code).then(
            () => ui.toast("Copied"),
            (e) => ui.toast(ui.errorText(e)),
          )
        }
      >
        Copy
      </button>
    </div>
  );
}

/** A table row, by its pipes: `| a | b |`, or `a | b` under a rule row. */
const isRow = (line: string) => /^\s*\|.*\|\s*$/.test(line);
/** A table's rule row, `| --- | :--: |`, with or without its outer pipes (or, mid-stream, its end). */
const isRule = (line: string) => /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/.test(line);
/** A non-blank line with a pipe in it continues a table, as it does on GitHub. */
const inTable = (line: string) => line.trim() !== "" && /(?<!\\)\|/.test(line) && !/^\s*```/.test(line);

/** A row's cells: the outer pipes dropped, `\|` a pipe again. */
function cells(row: string): string[] {
  return row
    .trim()
    .replace(/^\|/, "")
    .replace(/(?<!\\)\|$/, "")
    .split(/(?<!\\)\|/)
    .map((c) => c.replace(/\\\|/g, "|").trim());
}

/** A markdown table: the first row its header, the rule row its columns' alignment, each cell's markdown as inline(). Short rows pad, long ones trim, as on GitHub. */
function Table({ rows, ui }: { rows: string[]; ui: ClaudeUi }) {
  const head = cells(rows[0]);
  const ruled = rows.length > 1 && isRule(rows[1]);
  const align = ruled ? cells(rows[1]).map((c) => (c.startsWith(":") && c.endsWith(":") ? "center" : c.endsWith(":") ? "right" : undefined)) : [];
  const body = rows
    .slice(ruled ? 2 : 1)
    .map(cells)
    .filter((r) => r.some(Boolean));
  const cell = (c: string | undefined, i: number, Tag: "th" | "td") => (
    <Tag key={i} style={align[i] ? { textAlign: align[i] } : undefined}>
      {inline(c ?? "", ui)}
    </Tag>
  );
  return (
    <div className="ck-tablewrap">
      <table className="ck-table">
        <thead>
          <tr>{head.map((c, i) => cell(c, i, "th"))}</tr>
        </thead>
        {body.length > 0 && (
          <tbody>
            {body.map((r, ri) => (
              <tr key={ri}>{head.map((_, i) => cell(r[i], i, "td"))}</tr>
            ))}
          </tbody>
        )}
      </table>
    </div>
  );
}

/** Claude's markdown, as far as a chat needs it: code blocks, headings, lists, tables, paragraphs. Drawn again only when its text changes. */
export const Prose = memo(function Prose({ text }: { text: string }) {
  const ui = useUi();
  const out: ReactNode[] = [];
  const lines = text.split("\n");
  let para: string[] = [];
  let list: { ordered: boolean; items: string[] } | null = null;
  const flush = () => {
    if (para.length) out.push(<p key={out.length}>{inline(para.join("\n"), ui)}</p>);
    if (list) {
      const items = list.items.map((it, i) => <li key={i}>{inline(it, ui)}</li>);
      out.push(list.ordered ? <ol key={out.length}>{items}</ol> : <ul key={out.length}>{items}</ul>);
    }
    para = [];
    list = null;
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^\s*```/.test(line)) {
      flush();
      const body: string[] = [];
      while (++i < lines.length && !/^\s*```\s*$/.test(lines[i])) body.push(lines[i]);
      out.push(<CodeBlock key={out.length} code={body.join("\n")} />);
      continue;
    }
    // A table: a |…| row (its rule row may still be on its way as it streams), or any row with a pipe when a rule row follows it.
    if (isRow(line) || (inTable(line) && i + 1 < lines.length && isRule(lines[i + 1]))) {
      flush();
      const rows = [line];
      while (i + 1 < lines.length && inTable(lines[i + 1])) rows.push(lines[++i]);
      out.push(<Table key={out.length} rows={rows} ui={ui} />);
      continue;
    }
    const h = /^#{1,6}\s+(.*)$/.exec(line);
    if (h) {
      flush();
      out.push(
        <p key={out.length} className="ck-h">
          {inline(h[1], ui)}
        </p>,
      );
      continue;
    }
    const li = /^\s*([-*•]|\d+[.)])\s+(.*)$/.exec(line);
    if (li) {
      const ordered = /\d/.test(li[1]);
      if (para.length || (list && list.ordered !== ordered)) flush();
      list ??= { ordered, items: [] };
      list.items.push(li[2]);
      continue;
    }
    if (!line.trim()) {
      flush();
      continue;
    }
    if (list) {
      // A wrapped list item.
      if (/^\s{2,}/.test(line)) {
        list.items[list.items.length - 1] += ` ${line.trim()}`;
        continue;
      }
      flush();
    }
    para.push(line);
  }
  flush();
  return <div className="ck-prose">{out}</div>;
});

