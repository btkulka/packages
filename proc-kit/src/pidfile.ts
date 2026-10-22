// PID files: a small JSON file saying which process owns something (a
// supervised server, an update in progress), so another process can tell
// "running", "stale leftover" and "nothing".

import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { isAlive } from "./kill.js";

export interface PidFileData {
  pid: number;
  /** ISO time the file was written. */
  startedAt: string;
  /** Whatever else the writer recorded (a supervisor pid, a port…). */
  [key: string]: unknown;
}

export interface PidFileEntry extends PidFileData {
  /** Whether `pid` is running now. */
  alive: boolean;
}

/**
 * Write `file` as JSON: `pid` (default this process), `startedAt` (now) and any
 * extra fields. Creates the folder; replaces the file atomically, so a reader
 * never sees half of it. Returns what it wrote.
 */
export function writePidFile(file: string, data: { pid?: number; [key: string]: unknown } = {}): PidFileData {
  const entry: PidFileData = { ...data, pid: data.pid ?? process.pid, startedAt: new Date().toISOString() };
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(entry, null, 2)}\n`, "utf8");
  renameSync(tmp, file);
  return entry;
}

/**
 * Read `file`, with `alive` saying whether its pid still runs. Null when the
 * file is missing or unreadable. Also reads the older line format
 * ("pid\nstartedAt\n…") that orson's comfy.pid used, as `{ pid, startedAt }`.
 */
export function readPidFile(file: string): PidFileEntry | null {
  let text: string;
  try {
    text = readFileSync(file, "utf8").replace(/^﻿/, "");
  } catch {
    return null;
  }
  let data: Record<string, unknown> | null = null;
  try {
    const parsed = JSON.parse(text) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) data = parsed as Record<string, unknown>;
  } catch {
    /* not JSON: maybe the line format */
  }
  if (!data) {
    const lines = text.split(/\r?\n/);
    if (/^\s*\d+\s*$/.test(lines[0] ?? "")) data = { pid: Number(lines[0]), startedAt: (lines[1] ?? "").trim() };
  }
  if (!data) return null;
  const pid = Number(data.pid);
  if (!Number.isInteger(pid) || pid <= 0) return null;
  return { ...data, pid, startedAt: typeof data.startedAt === "string" ? data.startedAt : "", alive: isAlive(pid) };
}

/** Delete `file`. Never throws. */
export function removePidFile(file: string): void {
  try {
    rmSync(file, { force: true });
  } catch {
    /* in use or already gone */
  }
}
