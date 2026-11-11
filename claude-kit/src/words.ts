import type { ChatsState, ChatState, ClaudeMode } from "./types.js";

// What the screens call things: the modes, a chat's state in a word, a model's
// name. No DOM here, so a host's notices and an app's own badge can use them too.

export const MODES: { value: ClaudeMode; label: string; hint: string }[] = [
  { value: "default", label: "Ask", hint: "Asks before it edits a file or runs a command." },
  { value: "acceptEdits", label: "Edits", hint: "Edits files without asking; asks before commands." },
  { value: "auto", label: "Auto", hint: "Goes ahead with what's safe and asks when it can't tell." },
  { value: "plan", label: "Plan", hint: "Reads and plans. Changes nothing until you say so." },
  { value: "bypassPermissions", label: "Bypass", hint: "Never asks. Everything it does goes ahead." },
];

/** How a chat is, in a word, with its signal class (live, starting, alert or none). */
export function chatWord(chat?: ChatState): { label: string; cls: string } {
  if (!chat) return { label: "Off", cls: "" };
  // Its session isn't up: it starts as a message is typed, so to the person it's ready, without the live dot.
  if (chat.status === "off") return { label: "Ready", cls: "" };
  if (chat.asks.length) return { label: "Waiting for you", cls: "alert" };
  if (chat.status === "starting") return { label: "Starting", cls: "starting" };
  if (chat.status === "working") return { label: chat.activity ?? "Working", cls: "starting" };
  if (chat.status === "error") return { label: "Stopped", cls: "alert" };
  return { label: "Ready", cls: "live" };
}

/** All of them in a few words: a button's tooltip or a badge. `idle` is what it says when nothing's going on. */
export function chatsWord(list?: ChatsState, idle = "Claude Code"): string {
  const all = list?.chats ?? [];
  if (all.length < 2) return !all[0] || all[0].status === "off" ? idle : chatWord(all[0]).label;
  const waiting = all.filter((c) => c.asks.length).length;
  const working = all.filter((c) => c.status === "working").length;
  return [waiting && `${waiting} waiting for you`, working && `${working} working`].filter(Boolean).join(" · ") || `${all.length} chats`;
}

/** Whether any chat is on a turn, and whether any waits for an answer: a button's dot. */
export function chatsSignal(list?: ChatsState): "alert" | "working" | undefined {
  const all = list?.chats ?? [];
  if (all.some((c) => c.asks.length || c.status === "error")) return "alert";
  if (all.some((c) => c.status === "working" || c.status === "starting")) return "working";
  return undefined;
}

/** "claude-opus-5-5" → "Opus 5.5"; an alias the account lists by its own name. */
export function modelName(chat: ChatState, models: ChatsState["models"]): string {
  const id = chat.model;
  if (!id) return "Default model";
  const listed = models.find((m) => m.value === id);
  if (listed && listed.value !== "default") return listed.name;
  const m = /^claude-([a-z]+)-(\d+)(?:-(\d))?/.exec(id);
  return m ? `${m[1][0].toUpperCase()}${m[1].slice(1)} ${m[2]}${m[3] ? `.${m[3]}` : ""}` : id;
}

/** "mcp__benhaus__open" → "benhaus · open". */
export const toolLabel = (name: string) => (name.startsWith("mcp__") ? name.slice(5).replace("__", " · ") : name);

/** Claude Code's words for a missing or dead login ("Not logged in · Please run /login", "Login expired", "OAuth token revoked"…). */
export const needsSignIn = (error?: string) => !!error && /\/login|not logged in|login expired|token revoked|authenticat|invalid api key|unauthori[sz]ed/i.test(error);

/** "D:/source/benhaus" → "D:\source\benhaus" on Windows-looking paths; others as they are. */
export const showPath = (p: string) => (/^[A-Za-z]:[\\/]/.test(p) ? p.replace(/\//g, "\\") : p);

/** "D:\source\benhaus" → "benhaus". */
export const folderName = (path: string) => path.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || path;

/** "3 min ago", "yesterday", "Oct 12": when a past chat was last touched. */
export function relTime(iso: string, now = Date.now()): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "";
  const s = Math.round((now - t) / 1000);
  if (s < 45) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} hr ago`;
  const d = Math.round(h / 24);
  if (d === 1) return "yesterday";
  if (d < 7) return `${d} days ago`;
  const date = new Date(t);
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric", ...(date.getFullYear() !== new Date(now).getFullYear() ? { year: "numeric" } : {}) });
}
