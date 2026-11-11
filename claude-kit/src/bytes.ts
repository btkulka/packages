/** Bytes as they arrive: a Uint8Array (IPC, fetch), an ArrayBuffer, or a Node Buffer written as JSON ({type: "Buffer", data: […]}). */
export function asBytes(b: unknown): Uint8Array {
  if (b instanceof Uint8Array) return b;
  if (b instanceof ArrayBuffer) return new Uint8Array(b);
  const j = b as { type?: string; data?: number[] } | null;
  if (j && j.type === "Buffer" && Array.isArray(j.data)) return Uint8Array.from(j.data);
  if (Array.isArray(b)) return Uint8Array.from(b as number[]);
  throw new Error("That image came back in a shape the screen can't read.");
}
