// findExecutable: a synchronous PATH lookup, like `where` / `which`, without
// spawning either.
//
// Windows: a bare name is tried with each PATHEXT extension in order (.COM,
// .EXE, .BAT, .CMD by default), so `ffmpeg` finds ffmpeg.exe and `npm` finds
// npm.cmd; a name that already ends in one of them (`claude.exe`) is looked up
// as given. Extensionless files (the sh shims npm puts beside its .cmd ones)
// are never returned on Windows: Windows can't run them. Unlike cmd.exe, the
// current directory isn't searched.

import { accessSync, constants, statSync } from "node:fs";
import { delimiter, extname, isAbsolute, join, resolve } from "node:path";

export interface FindExecutableOptions {
  /** Directories to search after PATH, in order (an app's bundled or usual install folders). */
  extraDirs?: string[];
}

/**
 * The absolute path of the executable `name` on PATH, then in `extraDirs`, or
 * null. A name with a directory in it (`./bin/tool`, `C:\tools\ffmpeg`) is
 * checked where it points instead of searched for.
 *
 * On Windows a `.cmd` / `.bat` result needs a shell to run (`shell: true`, or
 * `cmd.exe /d /s /c`): Node refuses to spawn them directly.
 */
export function findExecutable(name: string, opts: FindExecutableOptions = {}): string | null {
  if (!name) return null;
  const win = process.platform === "win32";
  const names = candidateNames(name, win);
  if (hasDir(name)) {
    for (const n of names) {
      const p = resolve(n);
      if (isRunnable(p, win)) return p;
    }
    return null;
  }
  const dirs = [...pathDirs(), ...(opts.extraDirs ?? [])];
  for (const dir of dirs) {
    for (const n of names) {
      const p = join(dir, n);
      if (isRunnable(p, win)) return isAbsolute(p) ? p : resolve(p);
    }
  }
  return null;
}

/** The PATHEXT extensions, lower-cased, in order. */
function pathExts(): string[] {
  const raw = process.env.PATHEXT || ".COM;.EXE;.BAT;.CMD";
  const exts = raw
    .split(";")
    .map((e) => e.trim().toLowerCase())
    .filter((e) => e.startsWith("."));
  return exts.length ? exts : [".com", ".exe", ".bat", ".cmd"];
}

function candidateNames(name: string, win: boolean): string[] {
  if (!win) return [name];
  const exts = pathExts();
  const ext = extname(name).toLowerCase();
  if (ext && exts.includes(ext)) return [name];
  return exts.map((e) => name + e);
}

function pathDirs(): string[] {
  const raw = process.env.PATH ?? process.env.Path ?? "";
  return raw
    .split(delimiter)
    .map((d) => d.trim().replace(/^"(.*)"$/, "$1"))
    .filter(Boolean);
}

const hasDir = (name: string): boolean => name.includes("/") || name.includes("\\") || isAbsolute(name);

function isRunnable(p: string, win: boolean): boolean {
  try {
    if (!statSync(p).isFile()) return false;
    if (win) return true;
    accessSync(p, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}
