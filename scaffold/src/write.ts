import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ProjectFile } from "./files.js";

// Putting the files on disk, and the first commit.

/** A folder that exists and has something in it. */
export function isTaken(dir: string): boolean {
  if (!existsSync(dir)) return false;
  try {
    return readdirSync(dir).length > 0;
  } catch {
    return true;
  }
}

/** Writes the files under `dir` (created as needed). Refuses a folder with files in it unless `overwrite`. Returns the paths written. */
export function writeProject(dir: string, files: ProjectFile[], opts: { overwrite?: boolean } = {}): string[] {
  if (!opts.overwrite && isTaken(dir)) throw new Error(`${dir} already has files in it.`);
  mkdirSync(dir, { recursive: true });
  const written: string[] = [];
  for (const f of files) {
    const path = join(dir, ...f.path.split("/"));
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, f.contents, "utf8");
    written.push(path);
  }
  return written;
}

/** `git init` and a first commit of everything in `dir`. False when git isn't there or refused (the folder is left as it is). */
export function initGit(dir: string, message = "New project, scaffolded by Benhäus"): boolean {
  const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, stdio: ["ignore", "ignore", "ignore"], windowsHide: true });
  try {
    if (!existsSync(join(dir, ".git"))) git("init", "-q", "-b", "main");
    git("add", "-A");
    git("commit", "-q", "-m", message);
    return true;
  } catch {
    return false;
  }
}
