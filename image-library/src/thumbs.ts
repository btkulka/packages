import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { videoFrame } from "./video.js";

// Grid thumbnails in an Electron main process: Windows' own shell thumbnailer first (fast, async, every
// format Explorer can show), then Electron's decoder, cached as JPEG in a folder, keyed on the image id,
// its mtime and the size. Four at a time, so a screenful of 2K PNGs doesn't stall the main process.
// The app hands in Electron's nativeImage. A 3D model's thumbnail can't be decoded from its file: the
// page draws it (three.js, @btkulka/model-viewer) and hands it back with put(), into the same cache. A
// video's is a frame ffmpeg takes a tenth of the way in (Explorer's own adds a film strip), else Explorer's.

export const THUMB_PX = 480;

/** Where an item's cached thumbnail lives (made or not). */
export const thumbFile = (dir: string, id: number, mtime: number, px = THUMB_PX) => join(dir, `${id}-${mtime}-${px}.jpg`);

/** The parts of Electron's NativeImage used here (structural, so the package never needs electron). */
export interface NativeImageLike {
  isEmpty(): boolean;
  getSize(): { width: number; height: number };
  resize(o: { width: number; height: number; quality?: "good" | "better" | "best" }): NativeImageLike;
  toJPEG(quality: number): Buffer;
}

/** Electron's `nativeImage` module, handed in by the app. */
export interface NativeImageApi {
  createThumbnailFromPath(path: string, size: { width: number; height: number }): Promise<NativeImageLike>;
  createFromPath(path: string): NativeImageLike;
}

export function createThumbs(dir: string, nativeImage: NativeImageApi, px = THUMB_PX) {
  const inflight = new Map<string, Promise<string | undefined>>();
  let running = 0;
  const queue: (() => void)[] = [];
  const slot = () => new Promise<void>((r) => (running < 4 ? (running++, r()) : queue.push(() => (running++, r()))));
  const release = () => {
    running--;
    queue.shift()?.();
  };

  async function make(path: string, out: string, video: boolean, duration?: number | null): Promise<string | undefined> {
    await slot();
    try {
      if (video && (await videoFrame(path, out, px, duration))) return out;
      let img: NativeImageLike | undefined;
      try {
        img = await nativeImage.createThumbnailFromPath(path, { width: px, height: px });
      } catch {}
      if (!img || img.isEmpty()) {
        const full = nativeImage.createFromPath(path);
        if (!full.isEmpty()) {
          const { width, height } = full.getSize();
          const k = Math.min(1, px / Math.max(width, height));
          img = full.resize({ width: Math.max(1, Math.round(width * k)), height: Math.max(1, Math.round(height * k)), quality: "good" });
        }
      }
      if (!img || img.isEmpty()) return undefined;
      await mkdir(dir, { recursive: true });
      await writeFile(out, img.toJPEG(84));
      return out;
    } finally {
      release();
    }
  }

  return {
    /** The cached thumbnail's path, made if needed; undefined when neither decoder could read the file (or it's a model nobody has drawn yet). A video's `duration` (seconds) picks its frame. */
    get(id: number, path: string, mtime: number, kind: "image" | "model" | "video" = "image", duration?: number | null): Promise<string | undefined> {
      const out = thumbFile(dir, id, mtime, px);
      if (existsSync(out)) return Promise.resolve(out);
      if (kind === "model") return Promise.resolve(undefined);
      let p = inflight.get(out);
      if (!p) {
        p = make(path, out, kind === "video", duration).finally(() => inflight.delete(out));
        inflight.set(out, p);
      }
      return p;
    },
    /** Keeps a thumbnail the page drew (a model's, as JPEG bytes). */
    async put(id: number, mtime: number, jpeg: Uint8Array): Promise<string> {
      const out = thumbFile(dir, id, mtime, px);
      await mkdir(dir, { recursive: true });
      await writeFile(out, jpeg);
      return out;
    },
  };
}
