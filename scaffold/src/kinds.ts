// What a new project can be. Each kind knows the shared packages every app of
// that kind starts from and how Benhäus lists it once it exists.

export type AppKind = "electron" | "web" | "service" | "cli" | "mcp" | "bot" | "package";

export interface KindDef {
  id: AppKind;
  name: string;
  line: string;
  /** The BPM packages every app of this kind starts with, by short name (scope dropped). */
  packages: string[];
  /** How Benhäus lists it: its tool kind, how it opens, the command that launches it, whether it's a server Benhäus runs. */
  benhaus: { kind: string; opens: string; launch?: string; service?: boolean; also?: string[] };
  /** The port its dev server listens on, when it has one. */
  port?: number;
}

export const KINDS: KindDef[] = [
  { id: "electron", name: "Desktop app", line: "An Electron window of its own, like clipdrift or candybar-manager.", packages: ["electron-kit", "proc-kit"], benhaus: { kind: "electron", opens: "window", launch: "npm run dev" } },
  { id: "web", name: "Web app", line: "A page in the browser (or a Benhäus tab) with a Vite dev server.", packages: [], benhaus: { kind: "web", opens: "inside", service: true }, port: 5173 },
  { id: "service", name: "Server", line: "A Node service on a port that Benhäus starts and watches.", packages: ["proc-kit"], benhaus: { kind: "web", opens: "browser", service: true }, port: 4800 },
  { id: "cli", name: "Command-line tool", line: "A command run from a terminal.", packages: ["proc-kit"], benhaus: { kind: "cli", opens: "terminal" } },
  { id: "mcp", name: "MCP server", line: "Tools for Claude over stdio, built on mcp-kit.", packages: ["mcp-kit"], benhaus: { kind: "mcp", opens: "vscode" } },
  { id: "bot", name: "Discord bot", line: "A bot that stays online, on discord.js.", packages: ["proc-kit"], benhaus: { kind: "cli", opens: "terminal", launch: "npm start", also: ["Bot"] } },
  { id: "package", name: "Shared package", line: "Code for more than one app, in the packages home, listed in BPM.", packages: [], benhaus: { kind: "repo", opens: "vscode" } },
];

export const kindOf = (id: string): KindDef | undefined => KINDS.find((k) => k.id === id);

/** A kind from a name Ben or Claude used: its id, its name, or a word that means it. */
export function kindFromWords(text: string): AppKind | undefined {
  const t = text.trim().toLowerCase();
  const exact = KINDS.find((k) => k.id === t || k.name.toLowerCase() === t);
  if (exact) return exact.id;
  if (/\bmcp\b|model context protocol|tools? for claude/.test(t)) return "mcp";
  if (/\bdiscord\b|\bbot\b/.test(t)) return "bot";
  if (/\belectron\b|desktop|window of its own|\btray\b/.test(t)) return "electron";
  if (/\bcli\b|\bcommand\b|terminal|\bscript\b/.test(t)) return "cli";
  if (/\bpackage\b|\blibrary\b|shared code|\bkit\b/.test(t)) return "package";
  if (/\bserver\b|\bservice\b|\bapi\b|daemon|background/.test(t)) return "service";
  if (/\bweb\b|\bsite\b|browser|\bpage\b|dashboard|\bapp\b/.test(t)) return "web";
  return undefined;
}
