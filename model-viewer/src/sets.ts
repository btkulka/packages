// A set: a model kept as several OBJ files with a <name>.json beside them that names each one and its
// colour. Two pipelines write them:
// - TRELLIS / Pixal3D (@btkulka/trellis-client's `obj --colors`): { groups: [{ file, hex, srgb, faces }] },
//   the mesh split by colour into heap_0.obj … heap_5.obj;
// - toejam's Blender exports: { files: [{ file, part, material, color, roughness, metallic, emission,
//   emission_strength }] }, colours in linear RGB as Blender keeps them.
// Pure, no three.js: the library uses it to fold the parts into one model, the viewer to colour them.

export interface SetPart {
  /** The part's OBJ, relative to the sidecar. */
  file: string;
  /** What it is: the part and material for a Blender export, the colour for a TRELLIS group. */
  label: string;
  /** sRGB hex ("#aca38f"), when the sidecar gives one. */
  hex?: string;
  /** sRGB 0–1 without a hex. */
  srgb?: [number, number, number];
  /** Linear RGB 0–1 (Blender's own values). */
  linear?: [number, number, number];
  roughness?: number;
  metalness?: number;
  /** Linear RGB, and how strongly it glows (0 for none). */
  emissive?: [number, number, number];
  emissiveStrength?: number;
}

const rgb = (v: unknown): [number, number, number] | undefined =>
  Array.isArray(v) && v.length >= 3 && v.slice(0, 3).every((x) => typeof x === "number" && Number.isFinite(x)) ? [v[0], v[1], v[2]] : undefined;
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
const isObj = (f: unknown): f is string => typeof f === "string" && /\.obj$/i.test(f) && !/(^|[\\/])\.\.([\\/]|$)/.test(f);

/** The OBJ parts a sidecar names, with their colours; [] when it isn't a set's sidecar. */
export function setParts(json: unknown): SetPart[] {
  if (!json || typeof json !== "object") return [];
  const o = json as Record<string, unknown>;
  const out: SetPart[] = [];
  if (Array.isArray(o.groups)) {
    for (const g of o.groups as Record<string, unknown>[]) {
      if (!g || !isObj(g.file)) continue;
      const hex = typeof g.hex === "string" && /^#[0-9a-f]{6}$/i.test(g.hex) ? g.hex : undefined;
      out.push({ file: g.file, label: hex ?? g.file, hex, ...(hex ? {} : { srgb: rgb(g.srgb) }) });
    }
  }
  if (Array.isArray(o.files)) {
    for (const f of o.files as Record<string, unknown>[]) {
      if (!f || !isObj(f.file)) continue;
      const strength = num(f.emission_strength) ?? 0;
      out.push({
        file: f.file,
        label: [f.part, f.material].filter((x) => typeof x === "string" && x).join(" · ") || f.file,
        linear: rgb(f.color),
        roughness: num(f.roughness),
        metalness: num(f.metallic),
        ...(strength > 0 && rgb(f.emission) ? { emissive: rgb(f.emission), emissiveStrength: strength } : {}),
      });
    }
  }
  return out;
}

/** The parts' file names only. */
export const setFiles = (json: unknown) => setParts(json).map((p) => p.file);
