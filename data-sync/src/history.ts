import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// Every push, pull and conflict, kept in the sync folder so each machine sees the others': one file per app per
// machine (<sync>/<app>/history/<machine>.jsonl), so Syncthing never sees two machines write the same file.
// Benhäus's Sync screen reads them all into one timeline.

export type HistoryEvent =
  /** This machine's data went out as the snapshot. */
  | "pushed"
  /** Another machine's snapshot came in. */
  | "pulled"
  /** Both changed: this copy was backed up and nothing syncs until Ben picks. */
  | "held"
  /** Ben kept this machine's data (pushed over the other's). */
  | "kept-local"
  /** Ben took the other machine's data. */
  | "took-remote"
  /** A snapshot from newer code was left alone (the app here needs updating). */
  | "behind";

export interface HistoryEntry {
  at: string;
  app: string;
  machine: string;
  event: HistoryEvent;
  sha?: string;
  total?: number;
  rows?: Record<string, number>;
  schemaVersion?: number;
  /** For a pull or a take: the machine the data came from. */
  from?: string;
  /** For a hold: why. */
  note?: string;
}

/** A history file past this many bytes keeps its newer half. */
const MAX_BYTES = 1_000_000;

const safe = (machine: string) => machine.toLowerCase().replace(/[^a-z0-9._-]+/g, "-") || "machine";

export function historyFile(dir: string, app: string, machine: string): string {
  return join(dir, app, "history", `${safe(machine)}.jsonl`);
}

/** Add one entry to this machine's history for the app. Never throws: history is a record, not the sync. */
export function recordHistory(dir: string, entry: HistoryEntry): void {
  try {
    const file = historyFile(dir, entry.app, entry.machine);
    mkdirSync(join(dir, entry.app, "history"), { recursive: true });
    appendFileSync(file, `${JSON.stringify(entry)}\n`, "utf8");
    if (statSync(file).size > MAX_BYTES) {
      const lines = readFileSync(file, "utf8").split("\n").filter(Boolean);
      writeFileSync(file, `${lines.slice(Math.floor(lines.length / 2)).join("\n")}\n`, "utf8");
    }
  } catch {
    // a full disk or a locked file mustn't stop a push
  }
}

/**
 * Every machine's history for one app, or for every app in the sync folder, oldest first. `since` (an ISO time)
 * drops what's older.
 */
export function readHistory(dir: string, options: { app?: string; since?: string } = {}): HistoryEntry[] {
  const apps = options.app ? [options.app] : existsSync(dir) ? readdirSync(dir).filter((n) => !n.startsWith(".") && existsSync(join(dir, n, "history"))) : [];
  const out: HistoryEntry[] = [];
  for (const app of apps) {
    const folder = join(dir, app, "history");
    if (!existsSync(folder)) continue;
    for (const f of readdirSync(folder)) {
      if (!f.endsWith(".jsonl") || f.includes(".sync-conflict-")) continue;
      let text = "";
      try {
        text = readFileSync(join(folder, f), "utf8");
      } catch {
        continue;
      }
      for (const line of text.split("\n")) {
        if (!line.trim()) continue;
        try {
          const e = JSON.parse(line) as HistoryEntry;
          if (e?.at && e.event && (!options.since || e.at >= options.since)) out.push(e);
        } catch {
          // a line cut short by a sync in flight
        }
      }
    }
  }
  return out.sort((a, b) => a.at.localeCompare(b.at));
}
