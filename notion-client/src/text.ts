// Notion's objects as text: a page's title, each property as a line, a database's schema,
// and a page's blocks as plain, markdown-leaning text. Browser-safe.

import { notionUrl } from "./ids.js";
import type { NotionBlock, NotionDatabase, NotionIcon, NotionObject, NotionPage, NotionSummary, NotionUser, PropertySchema, PropertyValue, RichText } from "./types.js";

/** The plain text of a rich-text array. */
export function plainText(rt: RichText[] | null | undefined): string {
  return (rt ?? []).map((r) => r.plain_text ?? "").join("");
}

/** An icon as one string: the emoji, or the image's address. */
export function iconOf(icon: NotionIcon | null | undefined): string | undefined {
  if (!icon) return undefined;
  const i = icon as { type: string; emoji?: string; external?: { url?: string }; file?: { url?: string } };
  if (i.type === "emoji" && i.emoji) return i.emoji;
  return i.external?.url ?? i.file?.url ?? undefined;
}

/** A page's title property, or a database's title. "Untitled" when empty. */
export function titleOf(obj: NotionObject): string {
  if (obj.object === "database") return plainText(obj.title) || "Untitled";
  const title = Object.values(obj.properties ?? {}).find((p) => p.type === "title");
  return plainText(title?.title as RichText[] | undefined) || "Untitled";
}

/** A page or database in a few words. */
export function summaryOf(obj: NotionObject): NotionSummary {
  const parent = obj.parent ?? { type: "workspace" };
  const pid = parent.database_id ?? parent.page_id ?? parent.block_id;
  return {
    id: obj.id,
    kind: obj.object,
    title: titleOf(obj),
    url: obj.url || notionUrl(obj.id),
    icon: iconOf(obj.icon),
    lastEdited: obj.last_edited_time,
    parent: pid ? { type: parent.type, id: pid } : { type: parent.type },
  };
}

function dateText(d: { start?: string | null; end?: string | null } | null | undefined): string {
  if (!d?.start) return "";
  return d.end ? `${d.start} – ${d.end}` : d.start;
}

function valueText(type: string, v: unknown): string {
  if (v == null) return "";
  if (type === "date") return dateText(v as { start?: string; end?: string | null });
  if (type === "boolean") return v ? "Yes" : "No";
  return String(v);
}

const names = (list: unknown): string => ((list as { name?: string }[] | undefined) ?? []).map((x) => x.name ?? "").filter(Boolean).join(", ");

/** A property's value as text: title and rich text as they read, selects by name, dates as `start – end`, checkboxes Yes/No, people by name, relations by id. Empty when unset. */
export function propertyText(p: PropertyValue | null | undefined): string {
  if (!p) return "";
  const v = p[p.type];
  switch (p.type) {
    case "title":
    case "rich_text":
      return plainText(v as RichText[]);
    case "number":
      return v == null ? "" : String(v);
    case "select":
    case "status":
      return (v as { name?: string } | null)?.name ?? "";
    case "multi_select":
      return names(v);
    case "date":
      return dateText(v as { start?: string; end?: string | null } | null);
    case "checkbox":
      return v ? "Yes" : "No";
    case "url":
    case "email":
    case "phone_number":
      return (v as string | null) ?? "";
    case "people":
      return ((v as NotionUser[] | undefined) ?? []).map((u) => u.name ?? u.id).join(", ");
    case "files":
      return ((v as { name?: string; external?: { url?: string }; file?: { url?: string } }[] | undefined) ?? [])
        .map((f) => f.name ?? f.external?.url ?? f.file?.url ?? "")
        .filter(Boolean)
        .join(", ");
    case "relation":
      return ((v as { id: string }[] | undefined) ?? []).map((r) => r.id).join(", ");
    case "formula": {
      const f = v as { type: string; [key: string]: unknown } | null;
      return f ? valueText(f.type, f[f.type]) : "";
    }
    case "rollup": {
      const r = v as { type: string; [key: string]: unknown } | null;
      if (!r) return "";
      if (r.type === "array") return ((r.array as PropertyValue[] | undefined) ?? []).map(propertyText).filter(Boolean).join(", ");
      return valueText(r.type, r[r.type]);
    }
    case "created_time":
    case "last_edited_time":
      return (v as string | null) ?? "";
    case "created_by":
    case "last_edited_by":
      return (v as NotionUser | undefined)?.name ?? "";
    case "unique_id": {
      const u = v as { prefix?: string | null; number?: number } | null;
      return u?.number == null ? "" : `${u.prefix ? `${u.prefix}-` : ""}${u.number}`;
    }
    case "verification":
      return (v as { state?: string } | null)?.state ?? "";
    default:
      return typeof v === "string" ? v : "";
  }
}

/** Every property of a page that has a value, as text, in the page's order. */
export function propertiesText(page: NotionPage): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, p] of Object.entries(page.properties ?? {})) {
    const text = propertyText(p);
    if (text) out[name] = text;
  }
  return out;
}

/** A property definition in a few words: its type, and a select's or status's options. */
export function schemaText(p: PropertySchema): string {
  const v = p[p.type] as { options?: { name: string }[] } | undefined;
  const options = v?.options?.map((o) => o.name) ?? [];
  return options.length ? `${p.type}: ${options.join(", ")}` : p.type;
}

/** A database's properties as text, by name. */
export function databaseSchema(db: NotionDatabase): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, p] of Object.entries(db.properties ?? {})) out[name] = schemaText(p);
  return out;
}

/** Blocks whose children sit at the same level in the text (their children are the content). */
const FLAT = new Set(["table", "column_list", "column", "synced_block", "template"]);

/** One block's own line(s), without its children. Empty for layout blocks. */
export function blockText(b: NotionBlock): string {
  const v = (b[b.type] ?? {}) as Record<string, unknown>;
  const text = plainText(v.rich_text as RichText[] | undefined);
  const caption = plainText(v.caption as RichText[] | undefined);
  switch (b.type) {
    case "paragraph":
    case "toggle":
      return text;
    case "heading_1":
      return `# ${text}`;
    case "heading_2":
      return `## ${text}`;
    case "heading_3":
      return `### ${text}`;
    case "bulleted_list_item":
      return `- ${text}`;
    case "numbered_list_item":
      return `1. ${text}`;
    case "to_do":
      return `- [${v.checked ? "x" : " "}] ${text}`;
    case "quote":
      return `> ${text}`;
    case "callout": {
      const icon = iconOf(v.icon as NotionIcon | undefined);
      return `> ${icon ? `${icon} ` : ""}${text}`;
    }
    case "code":
      return `\`\`\`${(v.language as string | undefined) ?? ""}\n${text}\n\`\`\``;
    case "divider":
      return "---";
    case "equation":
      return `$${(v.expression as string | undefined) ?? ""}$`;
    case "child_page":
      return `[Page] ${(v.title as string | undefined) ?? ""}`;
    case "child_database":
      return `[Database] ${(v.title as string | undefined) ?? ""}`;
    case "bookmark":
    case "embed":
    case "link_preview": {
      const url = (v.url as string | undefined) ?? "";
      return caption ? `${caption} ${url}` : url;
    }
    case "link_to_page": {
      const kind = v.type as string | undefined;
      return kind ? `[Link to ${kind.replace(/_id$/, "")}] ${String(v[kind] ?? "")}` : "";
    }
    case "image":
    case "video":
    case "audio":
    case "file":
    case "pdf": {
      const url = (v.external as { url?: string } | undefined)?.url ?? (v.file as { url?: string } | undefined)?.url ?? "";
      return `[${b.type}] ${caption || (v.name as string | undefined) || url}`;
    }
    case "table_row":
      return `| ${(((v.cells as RichText[][] | undefined) ?? []).map(plainText)).join(" | ")} |`;
    case "table":
    case "column_list":
    case "column":
    case "synced_block":
    case "template":
    case "table_of_contents":
    case "breadcrumb":
    case "unsupported":
      return "";
    default:
      return text;
  }
}

/**
 * A block tree (from `blocks()`) as text: one line per block, numbered lists counted,
 * children indented two spaces under their parent (except under tables and columns, which
 * are layout). Layout blocks and empty lines are left out.
 */
export function blocksToText(blocks: NotionBlock[], indent = 0): string {
  const out: string[] = [];
  const pad = "  ".repeat(indent);
  let n = 0;
  for (const b of blocks) {
    n = b.type === "numbered_list_item" ? n + 1 : 0;
    const line = b.type === "numbered_list_item" ? `${n}. ${plainText((b.numbered_list_item as { rich_text?: RichText[] } | undefined)?.rich_text)}` : blockText(b);
    if (line) out.push(line.split("\n").map((l) => pad + l).join("\n"));
    if (b.children?.length) {
      const inner = blocksToText(b.children, FLAT.has(b.type) ? indent : indent + 1);
      if (inner) out.push(inner);
    }
  }
  return out.join("\n");
}
