import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { readdir, stat, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, extname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ChatImage, NewChatImage, ThumbSize } from "../types.js";

// A chat's images: what's attached to a message, what a tool hands back (a
// screenshot, an image file Claude read), and what Claude shows in a reply as
// markdown (![…](a path or an address)). Attached and returned ones are kept
// by their hash in <dataDir>/chat-images, so a chat's rows name them by id and
// the screens draw them, open them large and save them without the bytes
// riding along in every update.

const TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".bmp": "image/bmp",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".avif": "image/avif",
};
const EXT: Record<string, string> = { "image/png": ".png", "image/jpeg": ".jpg", "image/gif": ".gif", "image/webp": ".webp", "image/bmp": ".bmp", "image/svg+xml": ".svg", "image/x-icon": ".ico", "image/avif": ".avif" };

/** What Claude reads: the API takes these four. */
export const SENDABLE = ["image/png", "image/jpeg", "image/gif", "image/webp"];
/** The API's limit is 5 MB of base64 per image; this is that as bytes, with room. */
export const MAX_SEND_BYTES = Math.floor(3.7 * 1024 * 1024);
const MAX_READ_BYTES = 50 * 1024 * 1024;
const ID = /^[a-f0-9]{24}\.[a-z]{3,4}$/;
/** A kept image no chat has had in this long goes; its transcript still has it, and reading the chat in keeps it again. */
const PRUNE_AFTER_MS = 30 * 24 * 60 * 60_000;
/** The boxes thumbnails draw in (styles.css's .ck-pic--md and --lg), at twice the size for a sharp picture on a high-density screen. */
const THUMB = { md: { width: 480, height: 320 }, lg: { width: 1400, height: 560 } } as const;
/** Kinds the image tools scale; a GIF (it may move), an SVG and the rest come as they are. */
const SCALES = new Set(["image/png", "image/jpeg", "image/webp", "image/bmp"]);

export interface ImageBytes {
  bytes: Buffer;
  type: string;
  /** A file name for it: its own, or one made from its id. */
  name: string;
}

/**
 * Measuring and scaling images, which plain Node can't do: Electron's
 * nativeImage (electron/main's nativeImageTools), sharp, or nothing. Without
 * them thumbnails are the whole image and an image over Claude's limit is
 * refused instead of scaled down.
 */
export interface ImageTools {
  size(bytes: Buffer): { width: number; height: number } | undefined;
  resize(bytes: Buffer, to: { width: number; height: number }, as: "png" | "jpeg", quality?: number): Buffer;
}

const typeOfPath = (p: string) => TYPES[extname(p).toLowerCase()];

export class ImageStore {
  constructor(
    private readonly root: string,
    private readonly tools?: ImageTools,
  ) {}

  private dir(): string {
    mkdirSync(this.root, { recursive: true });
    return this.root;
  }

  /** Keeps an image by its hash (once) and names it for a chat's row. Its file's time is when a chat last had it, which pruning goes by. */
  keep(bytes: Buffer, type: string, name?: string): ChatImage {
    const id = `${createHash("sha256").update(bytes).digest("hex").slice(0, 24)}${EXT[type] ?? ".png"}`;
    const path = join(this.dir(), id);
    if (!existsSync(path)) writeFileSync(path, bytes);
    else {
      const now = new Date();
      try {
        utimesSync(path, now, now);
      } catch {
        // Read-only or in use: it's only kept a while longer.
      }
    }
    return { id, type, name: name?.trim() || undefined };
  }

  /** An image block's base64, kept. Undefined when it isn't one (a URL source, no data). */
  keepBlock(source: { type?: string; media_type?: string; data?: string } | undefined, name?: string): ChatImage | undefined {
    if (source?.type !== "base64" || !source.data) return undefined;
    try {
      return this.keep(Buffer.from(source.data, "base64"), source.media_type ?? "image/png", name);
    } catch {
      return undefined;
    }
  }

  /** Kept images (and their thumbnails) untouched for a month. */
  async prune(): Promise<number> {
    const cutoff = Date.now() - PRUNE_AFTER_MS;
    let gone = 0;
    for (const dir of [this.root, join(this.root, "thumbs")]) {
      let names: string[];
      try {
        names = await readdir(dir);
      } catch {
        continue;
      }
      for (const n of names) {
        const p = join(dir, n);
        try {
          const st = await stat(p);
          if (st.isFile() && st.mtimeMs < cutoff) {
            await unlink(p);
            gone++;
          }
        } catch {
          // In use, or gone already.
        }
      }
    }
    return gone;
  }

  /** Where a kept image's thumbnail is kept: a JPEG's as a JPEG, the rest as PNG. */
  private thumbPath(keptId: string, size: ThumbSize) {
    return join(this.root, "thumbs", `${keptId.replace(/\.\w+$/, "")}-${size}${keptId.endsWith(".jpg") ? ".jpg" : ".png"}`);
  }

  private keptThumb(keptId: string, size: ThumbSize): ImageBytes | undefined {
    const p = this.thumbPath(keptId, size);
    if (!existsSync(p)) return undefined;
    return { bytes: readFileSync(p), type: p.endsWith(".jpg") ? "image/jpeg" : "image/png", name: `image-${keptId.slice(0, 8)}${extname(keptId)}` };
  }

  /** An image no larger than its thumbnail's box needs: scaled down (once, for a kept one) when it's bigger and there are tools to scale it. */
  private thumbnail(img: ImageBytes, size: ThumbSize, keptId?: string): ImageBytes {
    const tools = this.tools;
    if (!tools || !SCALES.has(img.type)) return img;
    const jpeg = img.type === "image/jpeg";
    const box = THUMB[size];
    const dims = tools.size(img.bytes);
    if (!dims?.width || !dims.height) return img;
    const scale = Math.min(box.width / dims.width, box.height / dims.height);
    if (scale >= 1) return img;
    const bytes = tools.resize(img.bytes, { width: Math.max(1, Math.round(dims.width * scale)), height: Math.max(1, Math.round(dims.height * scale)) }, jpeg ? "jpeg" : "png", 85);
    if (keptId) {
      try {
        mkdirSync(join(this.root, "thumbs"), { recursive: true });
        writeFileSync(this.thumbPath(keptId, size), bytes);
      } catch {
        // Drawn from memory this time.
      }
    }
    return { bytes, type: jpeg ? "image/jpeg" : "image/png", name: img.name };
  }

  /**
   * An image by what a screen names it with: a kept id, a data: or http(s)
   * address, a file: URL, or a path (absolute, or relative to `folder`, the
   * chat's). Only image files are read. With `thumb`, no larger than that
   * thumbnail's box needs.
   */
  async read(ref: string, folder?: string, thumb?: ThumbSize): Promise<ImageBytes> {
    const r = ref.trim().replace(/^<(.*)>$/, "$1");
    if (!thumb || !THUMB[thumb]) return this.readWhole(r, folder);
    const kept = ID.test(r) ? r : undefined;
    return (kept && this.keptThumb(kept, thumb)) || this.thumbnail(await this.readWhole(r, folder), thumb, kept);
  }

  private async readWhole(r: string, folder?: string): Promise<ImageBytes> {
    if (ID.test(r)) {
      const path = join(this.root, r);
      if (!existsSync(path)) throw new Error(`Image ${r} isn't kept any more.`);
      return { bytes: readFileSync(path), type: typeOfPath(path) ?? "image/png", name: `image-${r.slice(0, 8)}${extname(r)}` };
    }
    const data = /^data:(image\/[\w.+-]+);base64,(.*)$/s.exec(r);
    if (data) return { bytes: Buffer.from(data[2], "base64"), type: data[1], name: `image${EXT[data[1]] ?? ".png"}` };
    if (/^https?:\/\//i.test(r)) {
      const res = await fetch(r, { signal: AbortSignal.timeout(20_000) });
      if (!res.ok) throw new Error(`${r} answered ${res.status}.`);
      const type = res.headers.get("content-type")?.split(";")[0].trim() ?? "";
      if (!type.startsWith("image/")) throw new Error(`${r} isn't an image (${type || "no type"}).`);
      const bytes = Buffer.from(await res.arrayBuffer());
      const last = decodeURIComponent(new URL(r).pathname.split("/").pop() ?? "");
      return { bytes, type, name: extname(last) ? last : `image${EXT[type] ?? ".png"}` };
    }
    const path = /^file:/i.test(r) ? fileURLToPath(r) : isAbsolute(r) ? r : resolve(folder ?? homedir(), r);
    const type = typeOfPath(path);
    if (!type) throw new Error(`${path} isn't an image file.`);
    if (!existsSync(path)) throw new Error(`${path} isn't there.`);
    if (statSync(path).size > MAX_READ_BYTES) throw new Error(`${path} is over 50 MB.`);
    return { bytes: readFileSync(path), type, name: basename(path) };
  }

  /** A file name to save as: the image's own, with the extension its type wants. */
  fileName(img: ImageBytes, name?: string): string {
    const n = (name?.trim() || img.name).replace(/[<>:"/\\|?*\x00-\x1f]/g, "_");
    return extname(n) ? n : `${n}${EXT[img.type] ?? ".png"}`;
  }

  /** Saves a copy where it's told: a file, or a folder (keeping the image's name). */
  async saveTo(ref: string, to: string, o: { folder?: string; name?: string } = {}): Promise<string> {
    const img = await this.read(ref, o.folder);
    const target = existsSync(to) && statSync(to).isDirectory() ? join(to, this.fileName(img, o.name)) : to;
    writeFileSync(target, img.bytes);
    return target;
  }

  /**
   * An image to send to Claude: one a screen prepared (base64, already within
   * the limits) or a file named by path. A PNG or JPEG over the limit is scaled
   * down when there are tools to; other kinds over it, or kinds Claude can't
   * read, are refused.
   */
  async incoming(i: NewChatImage, folder?: string): Promise<{ bytes: Buffer; type: string; name?: string }> {
    let bytes: Buffer;
    let type: string;
    let name = i.name;
    if ("path" in i) {
      const img = await this.read(i.path, folder);
      bytes = img.bytes;
      type = img.type;
      name ??= img.name;
    } else {
      bytes = Buffer.from(i.data, "base64");
      type = i.type;
    }
    if (!SENDABLE.includes(type)) throw new Error(`Claude reads PNG, JPEG, GIF and WebP images; ${name ?? "this one"} is ${type}.`);
    if (bytes.length <= MAX_SEND_BYTES) return { bytes, type, name };
    const tooBig = `${name ?? "That image"} is ${(bytes.length / 1048576).toFixed(1)} MB; Claude takes up to ${(MAX_SEND_BYTES / 1048576).toFixed(1)} MB.`;
    const tools = this.tools;
    if (!tools || (type !== "image/png" && type !== "image/jpeg")) throw new Error(tooBig);
    let cur = bytes;
    for (let tries = 0; tries < 5; tries++) {
      const dims = tools.size(cur);
      if (!dims) break;
      cur = tools.resize(cur, { width: Math.round(dims.width * 0.75), height: Math.round(dims.height * 0.75) }, "jpeg", 88);
      if (cur.length <= MAX_SEND_BYTES) return { bytes: cur, type: "image/jpeg", name };
    }
    throw new Error(`${name ?? "That image"} is too big to send even scaled down.`);
  }
}
