import { basename, dirname, extname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// One spelling for every path the library keeps: absolute, forward slashes, upper-case drive letter,
// no trailing slash. SQLite compares them case-insensitively (COLLATE NOCASE), as Windows does.

export const IMAGE_EXTS = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp", ".avif"]);

export function normPath(p: string): string {
  let s = p.trim().replace(/^<(.*)>$/, "$1");
  if (/^file:/i.test(s)) s = fileURLToPath(s);
  if (!isAbsolute(s)) s = resolve(s);
  s = s.replace(/\\/g, "/").replace(/\/+/g, "/");
  if (/^[a-z]:/.test(s)) s = s[0].toUpperCase() + s.slice(1);
  if (s.length > 3 && s.endsWith("/")) s = s.slice(0, -1);
  return s;
}

export const isImage = (p: string) => IMAGE_EXTS.has(extname(p).toLowerCase());

/** 3D models the library takes as items of their own (a set's .json is told by what's in it, not its name). */
export const MODEL_EXTS = new Set([".glb", ".gltf", ".obj"]);
export const isModel = (p: string) => MODEL_EXTS.has(extname(p).toLowerCase());

/** Videos the library takes as items. Chromium plays mp4, m4v, webm and most mov; mkv and avi come in all the same (ffprobe reads them, ffmpeg draws their frame). */
export const VIDEO_EXTS = new Set([".mp4", ".m4v", ".mov", ".webm", ".mkv", ".avi"]);
export const isVideo = (p: string) => VIDEO_EXTS.has(extname(p).toLowerCase());

/** The gemini-image sidecar for an image (or a video): <name>.json beside it. */
export const sidecarOf = (imagePath: string) => imagePath.slice(0, imagePath.length - extname(imagePath).length) + ".json";

export const nameOf = (p: string) => basename(p);
export const folderOf = (p: string) => normPath(dirname(p));
export const extOf = (p: string) => extname(p).slice(1).toLowerCase();

/** Is `p` inside `folder` (or the folder itself)? Both normalized. */
export function isUnder(p: string, folder: string): boolean {
  const a = p.toLowerCase();
  const b = folder.toLowerCase();
  return a === b || a.startsWith(b.endsWith("/") ? b : b + "/");
}

/** LIKE-pattern escaping for `ESCAPE '\'`. */
export const likeEscape = (s: string) => s.replace(/[\\%_]/g, (c) => "\\" + c);

/**
 * The address a markdown image uses for a file. A plain path when it's safe to write bare; a file: URL
 * when it holds a space, a bracket or anything else markdown would trip on.
 */
export function markdownSrc(p: string): string {
  if (!/[\s()<>[\]#?%]/.test(p)) return p;
  return "file:///" + encodeURI(p).replace(/\(/g, "%28").replace(/\)/g, "%29").replace(/#/g, "%23").replace(/\?/g, "%3F");
}
