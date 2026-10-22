// listProcesses: the running processes with their parent, name and command
// line, to find orphans ("a node.exe whose command line runs src/servers/dm.ts",
// "an ffmpeg.exe from our own bin folder") or to ask who a pid is.
//
// Windows: Get-CimInstance Win32_Process through PowerShell (about 1.5 s; wmic
// is deprecated and gone from new Windows 11 installs). Output is forced to
// UTF-8 so command lines with non-ASCII paths (…\Benhäus\…) come through
// intact. POSIX: `ps -A -o pid=,ppid=,args=`.

import { basename } from "node:path";
import { isWindows, POWERSHELL, run } from "./system.js";

export interface ProcessInfo {
  pid: number;
  ppid: number;
  /** Image name: "node.exe" on Windows; on POSIX the basename of argv[0]. */
  name: string;
  /** Full command line. Missing when the OS won't say (another user's process without elevation). */
  commandLine?: string;
  /** Path of the executable. Windows only; missing for protected processes. */
  executablePath?: string;
}

export interface ListProcessesFilter {
  /** Only this pid. */
  pid?: number;
  /** Only processes with this image name ("node.exe"; case-insensitive on Windows). */
  name?: string;
}

/**
 * Running processes, optionally filtered. Empty when the lookup fails (no
 * PowerShell, no ps). Never throws. Includes this process.
 */
export async function listProcesses(filter: ListProcessesFilter = {}): Promise<ProcessInfo[]> {
  if (isWindows()) {
    const r = await run(POWERSHELL(), ["-NoProfile", "-NonInteractive", "-EncodedCommand", encode(cimScript(filter))], 60_000);
    return parseCimJson(r.stdout);
  }
  const r = await run("ps", ["-A", "-o", "pid=,ppid=,args="], 30_000);
  return parsePs(r.stdout).filter((p) => (filter.pid === undefined || p.pid === filter.pid) && (filter.name === undefined || p.name === filter.name));
}

/** The PowerShell script listing Win32_Process rows as a JSON array. */
export function cimScript(filter: ListProcessesFilter = {}): string {
  const where: string[] = [];
  if (filter.pid !== undefined) where.push(`ProcessId=${Math.trunc(Number(filter.pid)) || 0}`);
  if (filter.name !== undefined) where.push(`Name='${wqlString(filter.name)}'`);
  const query = where.length ? ` -Filter "${where.join(" AND ")}"` : "";
  return [
    "$ErrorActionPreference = 'Stop'",
    "[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false",
    `$p = @(Get-CimInstance Win32_Process${query} | Select-Object ProcessId, ParentProcessId, Name, CommandLine, ExecutablePath)`,
    "ConvertTo-Json -Compress -Depth 2 -InputObject $p",
  ].join("\n");
}

/** WQL string literal body: backslash and quote escaped; `"` and `$` dropped (they'd end the PowerShell string). */
function wqlString(s: string): string {
  return s.replace(/["$`]/g, "").replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

const encode = (script: string): string => Buffer.from(script, "utf16le").toString("base64");

/** Parse ConvertTo-Json output of Win32_Process rows (an array, or one object). */
export function parseCimJson(output: string): ProcessInfo[] {
  const text = String(output).replace(/^﻿/, "").trim();
  if (!text) return [];
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return [];
  }
  const rows = (Array.isArray(data) ? data : [data]) as Record<string, unknown>[];
  const out: ProcessInfo[] = [];
  for (const row of rows) {
    if (!row || typeof row !== "object") continue;
    const pid = Number(row.ProcessId);
    if (!Number.isInteger(pid) || pid < 0) continue;
    const info: ProcessInfo = { pid, ppid: Number(row.ParentProcessId) || 0, name: String(row.Name ?? "") };
    if (typeof row.CommandLine === "string" && row.CommandLine) info.commandLine = row.CommandLine;
    if (typeof row.ExecutablePath === "string" && row.ExecutablePath) info.executablePath = row.ExecutablePath;
    out.push(info);
  }
  return out;
}

/** Parse `ps -A -o pid=,ppid=,args=` output. */
export function parsePs(output: string): ProcessInfo[] {
  const out: ProcessInfo[] = [];
  for (const line of String(output).split(/\r?\n/)) {
    const m = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
    if (!m) continue;
    const commandLine = m[3].trim();
    const argv0 = commandLine.split(/\s+/)[0] ?? "";
    const info: ProcessInfo = { pid: Number(m[1]), ppid: Number(m[2]), name: basename(argv0) };
    if (commandLine) info.commandLine = commandLine;
    out.push(info);
  }
  return out;
}
