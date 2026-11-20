import { open } from "node:fs/promises";

// An image's pixel size from its header: PNG, JPEG, GIF, WebP, BMP. Reads the first 64 KB (a JPEG whose
// frame header sits after a big EXIF block gets up to 1 MB). Undefined when it can't tell.

export interface Size {
  width: number;
  height: number;
}

export function sizeFromHeader(b: Buffer): Size | undefined {
  if (b.length >= 24 && b.readUInt32BE(0) === 0x89504e47 && b.toString("ascii", 12, 16) === "IHDR") {
    return { width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
  }
  if (b.length >= 10 && b.toString("ascii", 0, 3) === "GIF") {
    return { width: b.readUInt16LE(6), height: b.readUInt16LE(8) };
  }
  if (b.length >= 26 && b.toString("ascii", 0, 2) === "BM") {
    return { width: b.readInt32LE(18), height: Math.abs(b.readInt32LE(22)) };
  }
  if (b.length >= 30 && b.toString("ascii", 0, 4) === "RIFF" && b.toString("ascii", 8, 12) === "WEBP") {
    const kind = b.toString("ascii", 12, 16);
    if (kind === "VP8 " && b.length >= 30) return { width: b.readUInt16LE(26) & 0x3fff, height: b.readUInt16LE(28) & 0x3fff };
    if (kind === "VP8L" && b.length >= 25) {
      const v = b.readUInt32LE(21);
      return { width: (v & 0x3fff) + 1, height: ((v >> 14) & 0x3fff) + 1 };
    }
    if (kind === "VP8X" && b.length >= 30) return { width: b.readUIntLE(24, 3) + 1, height: b.readUIntLE(27, 3) + 1 };
  }
  if (b.length >= 4 && b[0] === 0xff && b[1] === 0xd8) {
    let i = 2;
    while (i + 9 < b.length) {
      if (b[i] !== 0xff) {
        i++;
        continue;
      }
      const marker = b[i + 1];
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
        i += 2;
        continue;
      }
      const len = b.readUInt16BE(i + 2);
      // Start-of-frame markers (not DHT C4, JPG C8, DAC CC) carry the size.
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { height: b.readUInt16BE(i + 5), width: b.readUInt16BE(i + 7) };
      }
      i += 2 + len;
    }
  }
  return undefined;
}

export async function imageSize(path: string): Promise<Size | undefined> {
  const fh = await open(path, "r");
  try {
    for (const n of [64 * 1024, 1024 * 1024]) {
      const buf = Buffer.alloc(n);
      const { bytesRead } = await fh.read(buf, 0, n, 0);
      const s = sizeFromHeader(buf.subarray(0, bytesRead));
      if (s || bytesRead < n) return s;
    }
    return undefined;
  } finally {
    await fh.close();
  }
}
