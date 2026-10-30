import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { AppKind } from "./kinds.js";

// The shared packages a plan can build on. The app passes the live list in
// (Benhäus reads it from BPM; the CLI reads the packages home); this file
// knows what each one is for, so a plan picks them by what the new app does,
// with or without Claude.

export interface CatalogueEntry {
  /** The npm name, as package.json has it: @btkulka/proc-kit, @datrapscallion/comfy-client. */
  name: string;
  /** Its folder name in the packages home. */
  dir: string;
  description?: string;
}

/** The short name a plan uses: the npm name without its scope. */
export const shortName = (name: string) => name.replace(/^@[^/]+\//, "");

/** When a package fits: kinds it always serves, and words in a description that call for it. */
const HINTS: Record<string, { kinds?: AppKind[]; words: RegExp }> = {
  "mcp-kit": { kinds: ["mcp"], words: /\bmcp\b|tools? for claude|claude (can|should) (read|see|use|call)/ },
  "electron-kit": { kinds: ["electron"], words: /\belectron\b|desktop app|its own window|\btray\b/ },
  "proc-kit": { kinds: ["electron", "service", "cli", "bot"], words: /\bport\b|process|spawn|launch|daemon|background|watch(es|ing)? a (folder|server)|\bpid\b/ },
  "sqlite-store": { words: /\bsqlite\b|database|\bdb\b|\bstore\b|\bsave\b|remember|history|catalog|library|track(s|ing)?\b|\blog(s|ging)? (every|each)|record(s|ing)?\b/ },
  "llm-kit": { words: /\bllm\b|\bai\b|claude|\bgpt\b|ollama|kobold|\bmodel\b|generat(e|es|ing)\b|summari[sz]|classif|rewrite|chat(bot)?|prompt/ },
  "media-kit": { words: /ffmpeg|ffprobe|yt-dlp|youtube|video|audio|\bclip|transcod|convert(s|ing)? (audio|video)|loudness|download(s|ing)? (a |the )?(video|track|audio)|\bmp[34]\b|\bwav\b/ },
  "comfy-client": { words: /comfy|stable diffusion|sdxl|illustrious|image gen|generat(e|es|ing) (an )?(image|art|picture|cover)|txt2img|img2img|controlnet/ },
  "lora-train": { words: /\blora\b|fine[- ]?tun|train(s|ing)? (a |an )?(model|style)/ },
  "lore-core": { words: /\blore\b|knowledge (base|store)|embedding|retriev|\brag\b|world[- ]?building|\bcanon\b/ },
  "elevenlabs-client": { words: /elevenlabs|text[- ]to[- ]speech|\btts\b|voice(over)?|narrat|speak(s|ing)?\b/ },
  "spotify-client": { words: /spotify|playlist/ },
  "soundcloud-client": { words: /soundcloud/ },
  "ableton-als": { words: /ableton|\.als\b|live set|\badg\b|\badv\b/ },
};

/** The packages a new app of `kind` described by `text` should build on, in catalogue order; only ones in the catalogue. */
export function suggestPackages(kind: AppKind, text: string, catalogue: CatalogueEntry[]): string[] {
  const t = text.toLowerCase();
  return catalogue
    .map((e) => shortName(e.name))
    .filter((n) => {
      const h = HINTS[n];
      return h ? (h.kinds?.includes(kind) ?? false) || h.words.test(t) : false;
    });
}

/** The catalogue entry a plan's package name points at: by short name, npm name or folder. */
export function findPackage(name: string, catalogue: CatalogueEntry[]): CatalogueEntry | undefined {
  const n = shortName(name).trim().toLowerCase();
  return catalogue.find((e) => shortName(e.name).toLowerCase() === n || e.name.toLowerCase() === n || e.dir.toLowerCase() === n);
}

/** Every folder in the packages home with a package.json, as the catalogue (what the CLI uses; Benhäus has BPM's list). */
export function readCatalogue(packagesHome: string): CatalogueEntry[] {
  let dirs: string[];
  try {
    dirs = readdirSync(packagesHome, { withFileTypes: true })
      .filter((d) => d.isDirectory() && d.name !== "node_modules" && !d.name.startsWith(".") && existsSync(join(packagesHome, d.name, "package.json")))
      .map((d) => d.name);
  } catch {
    return [];
  }
  const entries: CatalogueEntry[] = [];
  for (const dir of dirs) {
    try {
      const m = JSON.parse(readFileSync(join(packagesHome, dir, "package.json"), "utf8")) as { name?: string; description?: string };
      entries.push({ name: m.name ?? dir, dir, description: m.description });
    } catch {
      entries.push({ name: dir, dir });
    }
  }
  return entries;
}
