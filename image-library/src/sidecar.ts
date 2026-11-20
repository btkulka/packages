import { readFile } from "node:fs/promises";
import type { Sidecar } from "./types.js";

// The gemini-image CLI (@btkulka/gemini-client) writes <name>.png and <name>.json beside it:
// { name, prompt, system, refs: [{ path, file }], model, size, aspect, text, interaction, usage, usd, secs, at }.
// Any JSON object beside an image with a prompt or a model counts; anything else is left alone.

export function parseSidecar(text: string): Sidecar | null {
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch {
    return null;
  }
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  if (typeof o.prompt !== "string" && typeof o.model !== "string") return null;
  const s: Sidecar = { ...o };
  if (typeof o.usd !== "number") delete s.usd;
  if (!Array.isArray(o.refs)) delete s.refs;
  else s.refs = (o.refs as unknown[]).flatMap((r) => (typeof r === "string" ? [{ path: r }] : r && typeof r === "object" && typeof (r as { path?: unknown }).path === "string" ? [r as { path: string; file?: string }] : []));
  return s;
}

export async function readSidecar(path: string): Promise<Sidecar | null> {
  try {
    return parseSidecar(await readFile(path, "utf8"));
  } catch {
    return null;
  }
}
