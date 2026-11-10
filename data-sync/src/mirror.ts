import { copyFileSync, existsSync, mkdirSync, readdirSync, renameSync, statSync, utimesSync } from "node:fs";
import { basename, dirname, join, relative, sep } from "node:path";
import { tailnetFor } from "./tailnets.js";

export interface MirrorOptions {
  /** The app's own folder of files: resumes, artwork. */
  local: string;
  /** The app's id: its folder in the sync folder. */
  app: string;
  /** This folder's name under the app's: "resumes", "media". */
  name: string;
  /** The sync folder. Default: the app's tailnet's. */
  dir?: string;
  /** Only files this says yes to (their path relative to the folder, forward slashes). Default every file. */
  include?: (path: string) => boolean;
  /** Into subfolders too. Default true; false mirrors only the folder's own files (loose artwork in a data folder that also holds a browser profile). */
  recursive?: boolean;
}

export interface MirrorResult {
  /** Paths (relative, forward slashes) copied from the sync folder into the app's. */
  copiedIn: string[];
  /** Copied from the app's folder out to the sync folder. */
  copiedOut: string[];
}

/** Clocks and file systems round mtimes differently (FAT keeps 2 s); closer than this counts as the same time. */
const SLACK_MS = 2000;

const skip = (name: string) => name.startsWith(".") || name.startsWith("~syncthing~") || name.includes(".sync-conflict-");

function files(root: string, include: (path: string) => boolean = () => true, recursive = true): Map<string, number> {
  const out = new Map<string, number>();
  const walk = (dir: string) => {
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      return;
    }
    for (const n of names) {
      if (skip(n)) continue;
      const p = join(dir, n);
      const s = statSync(p);
      if (s.isDirectory()) {
        if (recursive) walk(p);
        continue;
      }
      const rel = relative(root, p).split(sep).join("/");
      if (s.isFile() && include(rel)) out.set(rel, s.mtimeMs);
    }
  };
  walk(root);
  return out;
}

function copy(from: string, to: string, mtimeMs: number) {
  mkdirSync(dirname(to), { recursive: true });
  // A temp name Syncthing never picks up, then a rename, so the other machine never sees half a file.
  const tmp = join(dirname(to), `.syncthing.${basename(to)}.tmp`);
  copyFileSync(from, tmp);
  const t = new Date(mtimeMs);
  utimesSync(tmp, t, t);
  renameSync(tmp, to);
}

/**
 * Keep a folder of the app's files the same on every machine, through `<sync>/<app>/<name>`: each file
 * that's missing on one side, or newer on the other, is copied across (its time kept). Nothing is ever
 * deleted, so a file removed on one machine comes back from the other; delete it from both. Call it
 * before serving and after the app adds or changes a file.
 */
export function mirrorFolder(options: MirrorOptions): MirrorResult {
  const remote = join(options.dir ?? tailnetFor(options.app).syncDir, options.app, options.name);
  const here = files(options.local, options.include, options.recursive !== false);
  const there = existsSync(remote) ? files(remote, options.include, options.recursive !== false) : new Map<string, number>();
  const result: MirrorResult = { copiedIn: [], copiedOut: [] };
  for (const [path, mtime] of here) {
    const theirs = there.get(path);
    if (theirs === undefined || mtime > theirs + SLACK_MS) {
      copy(join(options.local, path), join(remote, path), mtime);
      result.copiedOut.push(path);
    }
  }
  for (const [path, mtime] of there) {
    const mine = here.get(path);
    if (mine === undefined || mtime > mine + SLACK_MS) {
      copy(join(remote, path), join(options.local, path), mtime);
      result.copiedIn.push(path);
    }
  }
  return result;
}
