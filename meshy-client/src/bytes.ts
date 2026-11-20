// Images to data URIs with atob/btoa, which browsers and Node 16+ both have. No Buffer.

/** The image types Meshy takes for image to 3D: JPG, JPEG, PNG, WebP. */
export type ImageMimeType = "image/png" | "image/jpeg" | "image/webp";

/** File extensions to the type Meshy is sent. */
export const IMAGE_TYPES: Readonly<Record<string, ImageMimeType>> = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp" };

/** The largest image Meshy takes: 20 MB. */
export const MAX_IMAGE_BYTES = 20 * 1024 * 1024;

/** The type for a file name by its extension, or undefined for one Meshy doesn't take. */
export function imageTypeOf(fileName: string): ImageMimeType | undefined {
  const m = /\.[^./\\]+$/.exec(fileName.toLowerCase());
  return m ? IMAGE_TYPES[m[0]] : undefined;
}

/** Bytes to standard base64, in chunks so a big image doesn't overflow the call stack. */
export function bytesToBase64(bytes: Uint8Array): string {
  let bin = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  return btoa(bin);
}

/** `data:<type>;base64,<data>`: how a local image goes to Meshy (no upload step). */
export function dataUri(bytes: Uint8Array, mimeType: ImageMimeType): string {
  return `data:${mimeType};base64,${bytesToBase64(bytes)}`;
}

/** A data URI shortened for printing: `data:image/png;base64,<1.2 MB>`. */
export function shortDataUri(uri: string): string {
  const m = /^(data:[^;,]+;base64,)(.*)$/s.exec(uri);
  if (!m) return uri;
  const bytes = Math.floor((m[2]!.length * 3) / 4);
  const size = bytes >= 1024 * 1024 ? `${(bytes / (1024 * 1024)).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${m[1]}<${size}>`;
}
