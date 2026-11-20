import { createReadStream, existsSync, statSync } from "node:fs";
import { open, readFile, stat } from "node:fs/promises";
import { basename, dirname, extname, join } from "node:path";
import { createInterface } from "node:readline";
import { sizeFromHeader } from "./imagesize.js";
import { folderOf, IMAGE_EXTS, normPath } from "./paths.js";
import type { MeshInfo, MeshTexture } from "./types.js";

// 3D models in the library: .glb, .gltf and .obj files, and sets (several OBJ parts named, with their
// colours, in a <name>.json beside them: TRELLIS's colour groups and toejam's Blender exports). What's
// read here is cheap: a .glb's JSON chunk and its textures' headers, never the whole 60 MB; an .obj line
// by line. The pictures come from the app, which draws them (Benhäus, with three.js).

const stemOf = (p: string) => basename(p).replace(/\.[^.]+$/, "");
const isImg = (f: string) => IMAGE_EXTS.has(extname(f).toLowerCase());

/** The OBJ parts a set's sidecar names (TRELLIS { groups: [{ file }] }, Blender { files: [{ file }] }). */
export function partsOf(json: unknown): string[] {
  if (!json || typeof json !== "object") return [];
  const o = json as { groups?: unknown; files?: unknown };
  const out: string[] = [];
  for (const list of [o.groups, o.files]) {
    if (!Array.isArray(list)) continue;
    for (const x of list) {
      const f = (x as { file?: unknown } | null)?.file;
      if (typeof f === "string" && /\.obj$/i.test(f) && !/(^|[\\/])\.\.([\\/]|$)/.test(f)) out.push(f.replace(/\\/g, "/"));
    }
  }
  return out;
}

/** A JSON file's object, or undefined (not there, too big, not an object). */
export async function readJson(path: string, maxBytes = 4 * 1024 * 1024): Promise<Record<string, unknown> | undefined> {
  try {
    if ((await stat(path)).size > maxBytes) return undefined;
    const v = JSON.parse(await readFile(path, "utf8"));
    return v && typeof v === "object" && !Array.isArray(v) ? v : undefined;
  } catch {
    return undefined;
  }
}

/** A set's parts, if `jsonPath` is a set's sidecar whose parts are beside it; else undefined. */
export async function readSet(jsonPath: string): Promise<{ json: Record<string, unknown>; parts: string[] } | undefined> {
  if (!/\.json$/i.test(jsonPath) || /\.meta\.json$/i.test(jsonPath)) return undefined;
  const json = await readJson(jsonPath);
  const parts = partsOf(json);
  if (!json || !parts.length) return undefined;
  const dir = dirname(jsonPath);
  return parts.some((f) => existsSync(join(dir, f))) ? { json, parts } : undefined;
}

/** The .glb or .gltf a set's sidecar stands beside (heap.json → heap.glb), which is then the model itself. */
export function meshBeside(jsonPath: string): string | undefined {
  const base = jsonPath.slice(0, -5);
  for (const ext of [".glb", ".gltf"]) if (existsSync(base + ext)) return normPath(base + ext);
  return undefined;
}

// ── A model's sidecar ────────────────────────────────────────────────────

/**
 * The stems whose sidecars speak for a model: its own, then without a variant suffix
 * (brick-px-textured.glb shares brick-px.meta.json with brick-px.glb).
 */
export function sidecarStems(name: string): string[] {
  const stem = stemOf(name);
  const out = [stem];
  const base = stem.replace(/[-_]textured$/i, "");
  if (base !== stem) out.push(base);
  return out;
}

/** The stems a model's name could share with its concept image: its own, then without variant suffixes. */
export function conceptStems(name: string): string[] {
  const out = new Set<string>();
  let s = stemOf(name);
  out.add(s);
  for (let i = 0; i < 4; i++) {
    const next = s.replace(/[-_](textured|untextured|px|t2|pixal3d|pixal|trellis2?|hunyuan|hq|lq|mesh|model)$/i, "");
    if (next === s || !next) break;
    out.add((s = next));
  }
  return [...out];
}

export interface ModelMeta {
  /** The sidecar's object (trellis-client's <name>.meta.json: seed, image, model, quality, secs, made…). */
  meta: Record<string, unknown> | null;
  metaPath?: string;
  /** What it says the model was made from: a path, or a file name to look for. */
  conceptRef?: string;
  made?: string;
  model?: string;
  prompt?: string;
  usd?: number;
  /** The sidecar's modified time (ms), 0 without one. */
  mtime: number;
}

/** Reads a model's <name>.meta.json (or its base variant's). */
export async function readModelMeta(modelPath: string): Promise<ModelMeta> {
  const dir = dirname(modelPath);
  for (const stem of sidecarStems(basename(modelPath))) {
    const metaPath = join(dir, `${stem}.meta.json`);
    const meta = await readJson(metaPath);
    if (!meta) continue;
    const ref = ["concept", "image", "imagePath", "source_image", "input"].map((k) => meta[k]).find((v): v is string => typeof v === "string" && isImg(v));
    const made = ["made", "at", "created"].map((k) => meta[k]).find((v): v is string => typeof v === "string" && !Number.isNaN(Date.parse(v)));
    let mtime = 0;
    try {
      mtime = Math.round(statSync(metaPath).mtimeMs);
    } catch {}
    return {
      meta,
      metaPath: normPath(metaPath),
      conceptRef: ref,
      made,
      model: typeof meta.model === "string" ? meta.model : undefined,
      prompt: typeof meta.prompt === "string" ? meta.prompt : undefined,
      usd: typeof meta.usd === "number" ? meta.usd : undefined,
      mtime,
    };
  }
  return { meta: null, mtime: 0 };
}

// ── What's in a model ────────────────────────────────────────────────────

type Gltf = {
  scene?: number;
  scenes?: { nodes?: number[] }[];
  nodes?: { mesh?: number; children?: number[] }[];
  meshes?: { primitives?: { attributes?: Record<string, number>; indices?: number; mode?: number }[] }[];
  accessors?: { count?: number; min?: number[]; max?: number[] }[];
  bufferViews?: { buffer?: number; byteOffset?: number; byteLength?: number }[];
  images?: { uri?: string; bufferView?: number; mimeType?: string; name?: string }[];
  textures?: { source?: number; extensions?: Record<string, { source?: number }> }[];
  materials?: Record<string, unknown>[];
  extensionsRequired?: string[];
};

const ROLES: [string, (m: Record<string, unknown>) => unknown][] = [
  ["base colour", (m) => (m.pbrMetallicRoughness as Record<string, unknown> | undefined)?.baseColorTexture],
  ["metal/rough", (m) => (m.pbrMetallicRoughness as Record<string, unknown> | undefined)?.metallicRoughnessTexture],
  ["normal", (m) => m.normalTexture],
  ["occlusion", (m) => m.occlusionTexture],
  ["emissive", (m) => m.emissiveTexture],
];

async function headOf(path: string, at = 0, n = 64 * 1024): Promise<Buffer> {
  const fh = await open(path, "r");
  try {
    const b = Buffer.alloc(n);
    const { bytesRead } = await fh.read(b, 0, n, at);
    return b.subarray(0, bytesRead);
  } finally {
    await fh.close();
  }
}

async function gltfInfo(g: Gltf, format: "glb" | "gltf", path: string, binStart: number | undefined): Promise<MeshInfo> {
  const acc = g.accessors ?? [];
  const perMesh = (g.meshes ?? []).map((m) => {
    let tris = 0;
    let verts = 0;
    let colors = false;
    let uvs = false;
    for (const p of m.primitives ?? []) {
      const pos = p.attributes?.POSITION;
      const n = p.indices != null ? (acc[p.indices]?.count ?? 0) : pos != null ? (acc[pos]?.count ?? 0) : 0;
      const mode = p.mode ?? 4;
      tris += mode === 4 ? Math.floor(n / 3) : mode === 5 || mode === 6 ? Math.max(0, n - 2) : 0;
      verts += pos != null ? (acc[pos]?.count ?? 0) : 0;
      colors ||= p.attributes?.COLOR_0 != null;
      uvs ||= p.attributes?.TEXCOORD_0 != null;
    }
    return { tris, verts, colors, uvs };
  });
  // Count each mesh as often as the scene uses it.
  const uses = new Array(perMesh.length).fill(0);
  const roots = g.scenes?.[g.scene ?? 0]?.nodes;
  if (roots && g.nodes) {
    const seen = new Set<number>();
    const visit = (i: number) => {
      if (seen.has(i) || !g.nodes![i]) return;
      seen.add(i);
      const n = g.nodes![i];
      if (n.mesh != null && n.mesh < uses.length) uses[n.mesh]++;
      n.children?.forEach(visit);
    };
    roots.forEach(visit);
  } else uses.fill(1);
  let triangles = 0;
  let vertices = 0;
  perMesh.forEach((m, i) => ((triangles += m.tris * uses[i]), (vertices += m.verts * uses[i])));

  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (const m of g.meshes ?? [])
    for (const p of m.primitives ?? []) {
      const a = p.attributes?.POSITION != null ? acc[p.attributes.POSITION] : undefined;
      if (a?.min && a.max) for (let k = 0; k < 3; k++) ((min[k] = Math.min(min[k], a.min[k])), (max[k] = Math.max(max[k], a.max[k])));
    }

  // Each image once, with what the materials use it for.
  const roles = new Map<number, Set<string>>();
  for (const m of g.materials ?? [])
    for (const [role, get] of ROLES) {
      const t = get(m) as { index?: number } | undefined;
      const tex = t?.index != null ? g.textures?.[t.index] : undefined;
      const src = tex?.source ?? Object.values(tex?.extensions ?? {}).find((e) => e?.source != null)?.source;
      if (src != null) roles.set(src, (roles.get(src) ?? new Set()).add(role));
    }
  const textures: MeshTexture[] = [];
  for (const [i, img] of (g.images ?? []).entries()) {
    const t: MeshTexture = { name: img.name || `image ${i + 1}`, role: [...(roles.get(i) ?? [])].join(", ") || undefined, mime: img.mimeType };
    try {
      if (img.bufferView != null && binStart != null) {
        const bv = g.bufferViews?.[img.bufferView];
        if (bv) {
          t.bytes = bv.byteLength;
          const s = sizeFromHeader(await headOf(path, binStart + (bv.byteOffset ?? 0), Math.min(64 * 1024, bv.byteLength ?? 64 * 1024)));
          if (s) ((t.width = s.width), (t.height = s.height));
        }
      } else if (img.uri?.startsWith("data:")) {
        const b64 = img.uri.slice(img.uri.indexOf(",") + 1);
        const bytes = Buffer.from(b64.slice(0, 90_000), "base64");
        const s = sizeFromHeader(bytes);
        if (s) ((t.width = s.width), (t.height = s.height));
        t.mime ??= /^data:([^;,]+)/.exec(img.uri)?.[1];
      } else if (img.uri) {
        const file = join(dirname(path), decodeURIComponent(img.uri));
        t.file = normPath(file);
        t.bytes = (await stat(file)).size;
        const s = sizeFromHeader(await headOf(file));
        if (s) ((t.width = s.width), (t.height = s.height));
      }
    } catch {}
    textures.push(t);
  }
  return {
    format,
    triangles,
    vertices,
    meshes: g.meshes?.length ?? 0,
    materials: g.materials?.length ?? 0,
    vertexColors: perMesh.some((m) => m.colors),
    uvs: perMesh.some((m) => m.uvs),
    textures,
    ...(Number.isFinite(min[0]) ? { size: [0, 1, 2].map((k) => round(max[k] - min[k])) as [number, number, number] } : {}),
    ...(g.extensionsRequired?.length ? { extensions: g.extensionsRequired } : {}),
  };
}

const round = (n: number) => Math.round(n * 1000) / 1000;

async function glbInfo(path: string): Promise<MeshInfo> {
  const h = await headOf(path, 0, 20);
  if (h.length < 20 || h.readUInt32LE(0) !== 0x46546c67) throw new Error("not a .glb (no glTF header)");
  const len = h.readUInt32LE(12);
  if (h.readUInt32LE(16) !== 0x4e4f534a) throw new Error("its first chunk isn't JSON");
  const json = JSON.parse((await headOf(path, 20, len)).toString("utf8")) as Gltf;
  return gltfInfo(json, "glb", path, 20 + len + 8);
}

async function objInfo(path: string): Promise<MeshInfo> {
  let triangles = 0;
  let vertices = 0;
  let vertexColors = false;
  let uvs = false;
  const libs: string[] = [];
  const mats = new Set<string>();
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  const rl = createInterface({ input: createReadStream(path, { encoding: "utf8" }), crlfDelay: Infinity });
  for await (const line of rl) {
    const c0 = line.charCodeAt(0);
    if (c0 === 118 /* v */) {
      const c1 = line.charCodeAt(1);
      if (c1 === 32 || c1 === 9) {
        vertices++;
        const p = line.trim().split(/\s+/);
        for (let k = 0; k < 3; k++) {
          const x = Number(p[k + 1]);
          if (x < min[k]) min[k] = x;
          if (x > max[k]) max[k] = x;
        }
        if (p.length >= 7) vertexColors = true;
      } else if (c1 === 116 /* t */) uvs = true;
    } else if (c0 === 102 /* f */ && (line.charCodeAt(1) === 32 || line.charCodeAt(1) === 9)) {
      const n = line.trim().split(/\s+/).length - 1;
      if (n >= 3) triangles += n - 2;
    } else if (line.startsWith("mtllib ")) libs.push(line.slice(7).trim());
    else if (line.startsWith("usemtl ")) mats.add(line.slice(7).trim());
  }
  const textures: MeshTexture[] = [];
  for (const lib of libs.slice(0, 1)) {
    const mtlPath = join(dirname(path), lib);
    let text: string;
    try {
      text = await readFile(mtlPath, "utf8");
    } catch {
      continue;
    }
    const role: Record<string, string> = { map_kd: "base colour", map_ka: "ambient", map_ks: "specular", map_bump: "normal", bump: "normal", norm: "normal", map_d: "alpha", map_pr: "roughness", map_pm: "metalness", map_ke: "emissive", disp: "displacement" };
    const seen = new Set<string>();
    for (const m of text.matchAll(/^\s*(map_\w+|bump|disp|norm)\s+(.+?)\s*$/gim)) {
      const file = m[2].split(/\s+/).pop()!;
      if (seen.has(file.toLowerCase())) continue;
      seen.add(file.toLowerCase());
      const full = join(dirname(mtlPath), file);
      const t: MeshTexture = { name: basename(file), role: role[m[1].toLowerCase()] ?? m[1], file: normPath(full) };
      try {
        t.bytes = (await stat(full)).size;
        const s = sizeFromHeader(await headOf(full));
        if (s) ((t.width = s.width), (t.height = s.height));
      } catch {}
      textures.push(t);
    }
  }
  return {
    format: "obj",
    triangles,
    vertices,
    materials: mats.size,
    vertexColors,
    uvs,
    textures,
    ...(Number.isFinite(min[0]) ? { size: [0, 1, 2].map((k) => round(max[k] - min[k])) as [number, number, number] } : {}),
  };
}

const hexOf = (rgb: unknown, linear: boolean) => {
  if (!Array.isArray(rgb) || rgb.length < 3) return undefined;
  const ch = (v: number) => {
    const s = linear ? (v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(v, 1 / 2.4) - 0.055) : v;
    return Math.round(Math.max(0, Math.min(1, s)) * 255).toString(16).padStart(2, "0");
  };
  return "#" + rgb.slice(0, 3).map((v) => ch(Number(v))).join("");
};

async function setInfo(path: string): Promise<MeshInfo> {
  const set = await readSet(path);
  if (!set) throw new Error("names no OBJ parts beside it");
  const { json } = set;
  const dir = dirname(path);
  const parts: NonNullable<MeshInfo["parts"]> = [];
  let triangles = 0;
  let known = true;
  const groups = Array.isArray(json.groups) ? (json.groups as Record<string, unknown>[]) : [];
  const files = Array.isArray(json.files) ? (json.files as Record<string, unknown>[]) : [];
  for (const g of groups) {
    if (typeof g?.file !== "string" || !/\.obj$/i.test(g.file)) continue;
    const t = typeof g.faces === "number" ? g.faces : undefined;
    parts.push({ file: g.file, label: typeof g.hex === "string" ? g.hex : g.file, color: typeof g.hex === "string" ? g.hex : hexOf(g.srgb, false), triangles: t, missing: !existsSync(join(dir, g.file)) || undefined });
  }
  for (const f of files) {
    if (typeof f?.file !== "string" || !/\.obj$/i.test(f.file)) continue;
    const t = typeof f.tris === "number" ? f.tris : undefined;
    parts.push({ file: f.file, label: [f.part, f.material].filter((x) => typeof x === "string" && x).join(" · ") || f.file, color: hexOf(f.color, true), triangles: t, missing: !existsSync(join(dir, f.file)) || undefined });
  }
  for (const p of parts) {
    if (p.triangles == null && !p.missing) {
      try {
        p.triangles = (await objInfo(join(dir, p.file))).triangles ?? undefined;
      } catch {}
    }
    if (p.triangles == null) known = false;
    else triangles += p.triangles;
  }
  const stats = json.stats as { vertices?: number; bounds?: { min?: number[]; max?: number[] } } | undefined;
  const size = Array.isArray(json.size) && json.size.length >= 3 ? (json.size.slice(0, 3).map(Number) as [number, number, number]) : stats?.bounds?.min && stats.bounds.max ? ([0, 1, 2].map((k) => round(stats.bounds!.max![k] - stats.bounds!.min![k])) as [number, number, number]) : undefined;
  return {
    format: "set",
    triangles: known ? triangles : typeof json.tris === "number" ? json.tris : triangles || null,
    vertices: typeof stats?.vertices === "number" ? stats.vertices : null,
    materials: parts.length,
    vertexColors: false,
    textures: [],
    parts,
    ...(size ? { size: size.map(round) as [number, number, number] } : {}),
  };
}

/** What's in a model file (or a set's sidecar): triangles, vertices, textures, colours, size, parts. Never throws. */
export async function meshInfo(path: string): Promise<MeshInfo> {
  const ext = extname(path).toLowerCase();
  const format = ext === ".glb" ? "glb" : ext === ".gltf" ? "gltf" : ext === ".obj" ? "obj" : "set";
  try {
    if (format === "glb") return await glbInfo(path);
    if (format === "gltf") return await gltfInfo(JSON.parse(await readFile(path, "utf8")) as Gltf, "gltf", path, undefined);
    if (format === "obj") return await objInfo(path);
    return await setInfo(path);
  } catch (e) {
    return { format, triangles: null, vertices: null, vertexColors: false, textures: [], error: (e as Error).message };
  }
}

/**
 * The files that go with a model when it moves or goes to the Recycle Bin: its sidecars (<name>.json,
 * <name>.meta.json, <name>-prompt.json), a set's or a .glb's colour-group parts, an .obj's own .mtl and
 * the maps it names, a .gltf's .bin and textures. Only files that are there; never the model itself.
 */
export async function companionsOf(path: string): Promise<string[]> {
  const dir = dirname(path);
  const stem = stemOf(path);
  const ext = extname(path).toLowerCase();
  const out = new Set<string>();
  const add = (f: string) => existsSync(f) && out.add(normPath(f));
  if (ext !== ".json") add(join(dir, `${stem}.json`));
  add(join(dir, `${stem}.meta.json`));
  add(join(dir, `${stem}-prompt.json`));
  const set = await readSet(ext === ".json" ? path : join(dir, `${stem}.json`));
  set?.parts.forEach((f) => add(join(dir, f)));
  if (ext === ".obj") {
    const mtl = join(dir, `${stem}.mtl`);
    if (existsSync(mtl)) {
      add(mtl);
      const text = await readFile(mtl, "utf8").catch(() => "");
      for (const m of text.matchAll(/^\s*(?:map_\w+|bump|disp|norm)\s+(.+?)\s*$/gim)) add(join(dir, m[1].split(/\s+/).pop()!));
    }
  }
  if (ext === ".gltf") {
    const g = (await readJson(path, 64 * 1024 * 1024)) as Gltf | undefined;
    for (const x of [...((g as { buffers?: { uri?: string }[] } | undefined)?.buffers ?? []), ...(g?.images ?? [])]) if (x.uri && !x.uri.startsWith("data:")) add(join(dir, decodeURIComponent(x.uri)));
  }
  out.delete(normPath(path));
  return [...out];
}

/** Whether `path` (an .obj) is a part of a set whose sidecar sits beside it (heap_0.obj in heap.json). */
export async function isPart(path: string, cache = new Map<string, string[] | null>()): Promise<boolean> {
  if (extname(path).toLowerCase() !== ".obj") return false;
  const dir = folderOf(path);
  const name = basename(path).toLowerCase();
  // Its sidecar is named by a prefix of its own name, cut at an underscore or a dash: ufo_body_beam.obj → ufo.json.
  const stem = stemOf(path);
  for (let i = stem.length; i > 0; i--) {
    if (i < stem.length && stem[i] !== "_" && stem[i] !== "-") continue;
    const json = `${dir}/${stem.slice(0, i)}.json`;
    let parts = cache.get(json.toLowerCase());
    if (parts === undefined) {
      parts = existsSync(json) ? ((await readSet(json))?.parts.map((f) => f.toLowerCase()) ?? null) : null;
      cache.set(json.toLowerCase(), parts);
    }
    if (parts?.includes(name)) return true;
  }
  return false;
}
