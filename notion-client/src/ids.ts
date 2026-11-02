// Notion ids: a page, database or block id is a UUID that Notion shows with dashes in the
// API and without them at the end of a notion.so address. Browser-safe.

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HEX32 = /^[0-9a-f]{32}$/i;
const HEX32_RUNS = /[0-9a-f]{32}/gi;
const UUID_RUNS = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

/** The dashed form of an id given with or without dashes. */
export function dashed(id: string): string {
  const h = id.replace(/-/g, "").toLowerCase();
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/** The 32-character form of an id, as notion.so addresses carry it. */
export const undashed = (id: string): string => id.replace(/-/g, "").toLowerCase();

/**
 * The id in a Notion id or address, dashed, or undefined when there's none. Takes a dashed or
 * undashed id, a page or database address (`notion.so/Workspace/Title-<id>`, `?v=<view>`,
 * `#<block>` and `?pvs=` tails ignored), a peek address (`?p=<id>`) and a `notion://` link.
 */
export function parseNotionId(input: string): string | undefined {
  const s = input.trim();
  if (!s) return undefined;
  if (UUID.test(s)) return s.toLowerCase();
  if (HEX32.test(s)) return dashed(s);
  let url: URL;
  try {
    url = new URL(s.replace(/^notion:\/\//i, "https://www.notion.so/"));
  } catch {
    return undefined;
  }
  const peek = url.searchParams.get("p");
  if (peek && HEX32.test(peek.replace(/-/g, ""))) return dashed(peek);
  let path: string;
  try {
    path = decodeURIComponent(url.pathname);
  } catch {
    path = url.pathname;
  }
  const runs = path.match(HEX32_RUNS);
  if (runs?.length) return dashed(runs[runs.length - 1]!);
  const uuids = path.match(UUID_RUNS);
  if (uuids?.length) return uuids[uuids.length - 1]!.toLowerCase();
  return undefined;
}

/** The notion.so address of a page or database. */
export const notionUrl = (id: string): string => `https://www.notion.so/${undashed(id)}`;
