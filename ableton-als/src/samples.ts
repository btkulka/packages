import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { readAbletonXmlSync } from "./file.js";
import { basename, listFileRefs, type AbletonFileRef } from "./refs.js";

/**
 * A path under a Splice-managed folder, on any OS:
 *   C:\Users\x\Splice\Sounds\packs\…            /Users/x/Splice/Sounds/packs/…
 *   C:/Users/x/Documents/Splice/Samples/packs/…  …/Splice - alt-account/Samples/…
 * The `\s` branch admits an account suffix ("Splice - name/…").
 */
const SPLICE_PATH_RE = /[/\\]Splice(\s|[/\\]|$)/i;

export function isSplicePath(p: string | null | undefined): boolean {
  return !!p && SPLICE_PATH_RE.test(p);
}

/**
 * What to search a sample library for: the file name without its extension and without
 * the timestamp Live's Consolidate appends ("Kick_06 [2024-08-23 203418].wav" -> "Kick_06").
 */
export function sampleSearchKey(fileName: string): string {
  const base = basename(fileName);
  const dot = base.lastIndexOf(".");
  const stem = dot > 0 ? base.slice(0, dot) : base;
  return stem.replace(/\s*\[\d{4}-\d{2}-\d{2}\s+\d+\]\s*$/, "").trim();
}

export interface MissingSample {
  /** The absolute path the set points at; without one, the project-relative path resolved against projectDir. */
  originalPath: string;
  /** As stored in the set ('' when none). */
  relativePath: string;
  basename: string;
  searchKey: string;
  isSplice: boolean;
}

export interface MissingSampleReport {
  alsPath: string;
  /** Distinct samples the set loads that could be checked. */
  totalRefs: number;
  /** How many of those sit under a Splice folder (informational). */
  spliceRefs: number;
  missing: MissingSample[];
  /**
   * Distinct samples with neither an absolute path nor a project-relative one, so they
   * can't be checked: Live 9/10 sets saved on a Mac (alias data) that point into a Pack.
   */
  unresolved: number;
}

export interface FindMissingSamplesOptions {
  /** Existence check. Default fs.existsSync. */
  exists?: (path: string) => boolean;
  /** Folder that project-relative paths resolve against. Default: the .als file's folder. */
  projectDir?: string;
  /** The decoded XML, when the caller already has it (the file is not read then). */
  xml?: string;
}

/**
 * The samples a Live Set loads that aren't on disk. Only `SampleRef`s count (audio clips,
 * Simpler/Sampler, Drum Rack pads), not device presets, Max devices, plugin binaries or the
 * "where it came from" records. A sample counts as present when either its
 * project-relative path (resolved against projectDir, as Live does when a project moves)
 * or its absolute path exists. Each distinct sample is reported once.
 */
export function findMissingSamples(alsPath: string, options: FindMissingSamplesOptions = {}): MissingSampleReport {
  const exists = options.exists ?? existsSync;
  const projectDir = options.projectDir ?? dirname(alsPath);
  const xml = options.xml ?? readAbletonXmlSync(alsPath);

  const seen = new Set<string>();
  let totalRefs = 0;
  let spliceRefs = 0;
  let unresolved = 0;
  const missing: MissingSample[] = [];

  for (const ref of listFileRefs(xml)) {
    if (ref.owner !== "SampleRef") continue;
    const key = ref.path ?? `rel:${ref.relativeTo}:${ref.relativePath}`;
    if (seen.has(key)) continue;
    seen.add(key);

    const candidates = candidatesFor(ref, projectDir);
    if (candidates.length === 0) {
      unresolved++;
      continue;
    }
    totalRefs++;
    const isSplice = isSplicePath(ref.path ?? ref.relativePath);
    if (isSplice) spliceRefs++;
    if (candidates.some((c) => exists(c))) continue;
    missing.push({
      originalPath: ref.path ?? candidates[0]!,
      relativePath: ref.relativePath,
      basename: ref.name,
      searchKey: sampleSearchKey(ref.name),
      isSplice,
    });
  }
  return { alsPath, totalRefs, spliceRefs, missing, unresolved };
}

function candidatesFor(ref: AbletonFileRef, projectDir: string): string[] {
  const out: string[] = [];
  if (ref.relativePath && (ref.relativeTo === "project" || ref.relativeTo === "external")) {
    out.push(resolve(projectDir, ref.relativePath));
  }
  if (ref.path) out.push(ref.path);
  return out;
}
