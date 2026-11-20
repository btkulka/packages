import { statSync } from "node:fs";
import { basename, dirname, extname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// The files an app block's page may read (the bridge's file()): a path its
// props name, or a file in that path's folder or below it, so a page showing
// a model gets the model, its .bin, .mtl and textures, and the parts a set's
// sidecar lists, and nothing else. The props are Claude's, so this is what
// Claude asked to show; a page can't reach past it.

/** The most a page reads at once. */
export const MAX_FILE_BYTES = 512 * 1024 * 1024;

const TYPES: Record<string, string> = {
  ".glb": "model/gltf-binary",
  ".gltf": "model/gltf+json",
  ".obj": "model/obj",
  ".mtl": "text/plain",
  ".json": "application/json",
  ".bin": "application/octet-stream",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".bmp": "image/bmp",
  ".avif": "image/avif",
  ".ktx2": "image/ktx2",
  ".tga": "image/x-tga",
  ".tif": "image/tiff",
  ".tiff": "image/tiff",
};

/** A file's type from its extension. */
export const fileType = (path: string) => TYPES[extname(path).toLowerCase()] ?? "application/octet-stream";

/** A path or file: address as an absolute path, or undefined for anything else (a relative path, an http address). */
export function absPath(ref: string): string | undefined {
  const s = ref.trim();
  if (!s) return undefined;
  if (/^file:/i.test(s)) {
    try {
      return resolve(fileURLToPath(s));
    } catch {
      return undefined;
    }
  }
  if (/^[a-z][a-z0-9+.-]+:\/\//i.test(s)) return undefined;
  return isAbsolute(s) ? resolve(s) : undefined;
}

/** One spelling to compare paths by: forward slashes, and on Windows any case. */
const key = (p: string) => {
  const s = p.replace(/\\/g, "/").replace(/\/+$/, "");
  return process.platform === "win32" ? s.toLowerCase() : s;
};

/** Every string in the props (any depth) that is an absolute path or a file: address, as a path. */
export function namedPaths(props: unknown, out: string[] = [], depth = 0): string[] {
  if (depth > 8) return out;
  if (typeof props === "string") {
    const p = absPath(props);
    if (p) out.push(p);
  } else if (Array.isArray(props)) for (const v of props) namedPaths(v, out, depth + 1);
  else if (props && typeof props === "object") for (const v of Object.values(props)) namedPaths(v, out, depth + 1);
  return out;
}

const isFile = (p: string) => {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
};

/**
 * The path a page may read for `ref`, or a plain error saying why not: it has
 * to be a path the props name, or sit in the folder of a named file (one that's
 * there and is a file, so a named folder or drive opens nothing) or below it.
 */
export function readablePath(ref: string, props: unknown): string {
  const path = absPath(ref);
  if (!path) throw new Error(`${ref} isn't a file's path.`);
  const want = key(path);
  for (const named of namedPaths(props)) {
    if (key(named) === want) return path;
    if (!isFile(named)) continue;
    const folder = dirname(named);
    // A file at a drive's or the disk's root opens nothing beside it.
    if (dirname(folder) === folder) continue;
    if (want.startsWith(`${key(folder)}/`)) return path;
  }
  throw new Error(`The block didn't name ${basename(path)}, and it isn't beside a file it named.`);
}
