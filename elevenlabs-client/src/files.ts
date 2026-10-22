// Node helpers for the audio the client returns: write it safely, and memoize
// renders on disk so re-runs don't re-bill. Node only.

import { createHash } from "node:crypto";
import { mkdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

/**
 * Writes audio to `path`, creating folders. Writes a temp file and renames it into place,
 * so a crash or abort never leaves a truncated file that a cache would later trust.
 * Retries the rename briefly on EPERM/EBUSY/EACCES: on Windows, antivirus and the indexer
 * hold freshly written files for a moment.
 */
export async function writeAudioFile(path: string, bytes: Uint8Array): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}.part`;
  try {
    await writeFile(tmp, bytes);
    for (let attempt = 0; ; attempt++) {
      try {
        await rename(tmp, path);
        return;
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (attempt >= 5 || (code !== "EPERM" && code !== "EBUSY" && code !== "EACCES")) throw err;
        await new Promise((r) => setTimeout(r, 50 * (attempt + 1)));
      }
    }
  } catch (err) {
    await rm(tmp, { force: true }).catch(() => {});
    throw err;
  }
}

/**
 * A stable short hash of a request, for cache file names:
 * sha1 of JSON.stringify(value), hex, first `length` characters.
 * Key order matters, exactly as JSON.stringify sees it.
 */
export function requestHash(value: unknown, length = 20): string {
  return createHash("sha1").update(JSON.stringify(value)).digest("hex").slice(0, length);
}

/**
 * Disk memo: returns `path` when it already holds audio, otherwise calls `render`,
 * writes the result there (atomically) and returns it. An empty file counts as missing.
 * `force` re-renders even when the file exists.
 */
export async function cachedAudio(
  path: string,
  render: () => Promise<Uint8Array>,
  options: { force?: boolean } = {},
): Promise<{ path: string; cached: boolean }> {
  if (!options.force) {
    const size = await stat(path).then(
      (s) => (s.isFile() ? s.size : 0),
      () => 0,
    );
    if (size > 0) return { path, cached: true };
  }
  const bytes = await render();
  await writeAudioFile(path, bytes);
  return { path, cached: false };
}
