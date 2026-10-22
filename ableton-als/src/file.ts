// .als (Live Set), .adg (device group / rack) and .adv (device preset) files are
// gzipped UTF-8 XML. These read and write that envelope.

import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { gunzip, gunzipSync, gzipSync } from "node:zlib";

/** The bytes aren't a gzipped Ableton document (or the gzip is corrupt). */
export class AbletonFormatError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "AbletonFormatError";
  }
}

/** True when the bytes start with the gzip magic number. */
export function isGzip(bytes: Uint8Array): boolean {
  return bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b;
}

/** Gunzips an Ableton document into its XML text. Throws AbletonFormatError for anything else. */
export function decodeAbletonXml(bytes: Uint8Array): string {
  if (!isGzip(bytes)) throw new AbletonFormatError("Not a gzipped Ableton file");
  let out: Buffer;
  try {
    out = gunzipSync(bytes);
  } catch (err) {
    throw new AbletonFormatError(`Corrupt gzip data: ${err instanceof Error ? err.message : String(err)}`, { cause: err });
  }
  return stripBom(out.toString("utf8"));
}

/** Gzips XML text back into an Ableton document. */
export function encodeAbletonXml(xml: string): Buffer {
  return gzipSync(Buffer.from(xml, "utf8"));
}

/** Reads and gunzips an .als/.adg/.adv file. */
export function readAbletonXmlSync(filePath: string): string {
  return decodeAbletonXml(readFileSync(filePath));
}

/** Reads and gunzips an .als/.adg/.adv file without blocking the event loop. */
export async function readAbletonXml(filePath: string): Promise<string> {
  const bytes = await readFile(filePath);
  if (!isGzip(bytes)) throw new AbletonFormatError("Not a gzipped Ableton file");
  const out = await new Promise<Buffer>((resolve, reject) =>
    gunzip(bytes, (err, res) =>
      err ? reject(new AbletonFormatError(`Corrupt gzip data: ${err.message}`, { cause: err })) : resolve(res),
    ),
  );
  return stripBom(out.toString("utf8"));
}

/**
 * Puts an XML comment right after the `<?xml …?>` declaration (or at the very top when
 * there is none), e.g. a buyer watermark. `--` in the text is split so the comment stays
 * well-formed. The result is still a valid Ableton document.
 */
export function insertXmlComment(xml: string, text: string): string {
  const safe = text.replace(/-(?=-)/g, "- ").replace(/-$/, "- ");
  const comment = `<!-- ${safe} -->`;
  return xml.startsWith("<?xml") ? xml.replace(/\?>/, `?>\n${comment}`) : `${comment}\n${xml}`;
}

function stripBom(s: string): string {
  return s.charCodeAt(0) === 0xfeff ? s.slice(1) : s;
}
