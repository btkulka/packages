import { Box3, Color, DoubleSide, Group, LinearSRGBColorSpace, LoadingManager, Mesh, MeshStandardMaterial, SRGBColorSpace, Vector3, type BufferGeometry, type Material, type Object3D, type Texture } from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { MTLLoader } from "three/addons/loaders/MTLLoader.js";
import { OBJLoader } from "three/addons/loaders/OBJLoader.js";
import { setParts, type SetPart } from "./sets.js";

// Reading a model into three.js objects. Every file comes through the source's read(): the model itself
// and anything it names beside it (a .gltf's .bin and textures, an .obj's .mtl and maps, a set's parts),
// read first and handed to three's loaders as blob: addresses, so the loaders never reach the disk or the
// network themselves. That's what lets the same code draw from an Electron protocol and from a sandboxed
// chat block that can only ask its host for bytes.

/** Where a model's bytes come from. */
export interface ModelSource {
  /** The model's file name or path; its extension says what it is (.glb, .gltf, .obj, or a set's .json). */
  name: string;
  /** The model's bytes (rel ""), or a file beside it by a path relative to it ("tex/a.png", "ufo_0.obj"). */
  read(rel: string): Promise<ArrayBuffer>;
}

export type ModelFormat = "glb" | "gltf" | "obj" | "set";

export function formatOf(name: string): ModelFormat | undefined {
  const ext = /\.([a-z0-9]+)$/i.exec(name)?.[1]?.toLowerCase();
  return ext === "glb" ? "glb" : ext === "gltf" ? "gltf" : ext === "obj" ? "obj" : ext === "json" ? "set" : undefined;
}

export interface TextureStat {
  name: string;
  width: number;
  height: number;
}

/** What a loaded model holds, counted from what three.js built. */
export interface ModelStats {
  format: ModelFormat;
  triangles: number;
  vertices: number;
  meshes: number;
  materials: number;
  textures: TextureStat[];
  vertexColors: boolean;
  /** Width, height and depth in the model's own units. */
  size: [number, number, number];
  /** Files it names that couldn't be read (a set's part, a texture). */
  missing: string[];
}

export interface LoadedModel {
  root: Object3D;
  stats: ModelStats;
  /** Frees its blob: addresses (the viewer frees the GPU side). */
  release(): void;
}

const td = new TextDecoder();
const clean = (u: string) => {
  let s = u.replace(/\\/g, "/").replace(/^\.\//, "");
  try {
    s = decodeURIComponent(s);
  } catch {}
  return s;
};
const dirOf = (rel: string) => (rel.includes("/") ? rel.slice(0, rel.lastIndexOf("/") + 1) : "");
const MIME: Record<string, string> = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp", ktx2: "image/ktx2", bin: "application/octet-stream" };

/** Files beside the model, read once and named by blob: addresses the loaders get through a LoadingManager. */
class Beside {
  private urls = new Map<string, string>();
  readonly missing: string[] = [];
  constructor(private src: ModelSource) {}
  async add(rel: string) {
    const key = clean(rel);
    if (!key || /^(data|blob|https?):/i.test(key) || this.urls.has(key)) return;
    try {
      const bytes = await this.src.read(key);
      const type = MIME[/\.([a-z0-9]+)$/i.exec(key)?.[1]?.toLowerCase() ?? ""] ?? "";
      this.urls.set(key, URL.createObjectURL(new Blob([bytes], type ? { type } : {})));
    } catch {
      this.missing.push(key);
    }
  }
  private mgr?: LoadingManager;
  private pending = 0;
  private waiters: (() => void)[] = [];
  /** One manager for every loader of this model, so idle() knows when the textures are in. */
  manager(): LoadingManager {
    if (this.mgr) return this.mgr;
    const m = new LoadingManager();
    m.setURLModifier((url) => this.urls.get(clean(url)) ?? url);
    const start = m.itemStart.bind(m);
    const end = m.itemEnd.bind(m);
    m.itemStart = (url) => (this.pending++, start(url));
    m.itemEnd = (url) => {
      end(url);
      if (--this.pending <= 0) this.waiters.splice(0).forEach((f) => f());
    };
    return (this.mgr = m);
  }
  /** Resolves once everything the loaders started (an .mtl's maps) has loaded or failed; 30 s at most. */
  idle(): Promise<void> {
    if (this.pending <= 0) return Promise.resolve();
    return new Promise((r) => {
      this.waiters.push(r);
      setTimeout(r, 30_000);
    });
  }
  release() {
    this.urls.forEach((u) => URL.revokeObjectURL(u));
    this.urls.clear();
  }
}

/** The JSON chunk of a .glb. */
function glbJson(buf: ArrayBuffer): Record<string, unknown> | undefined {
  const v = new DataView(buf);
  if (buf.byteLength < 20 || v.getUint32(0, true) !== 0x46546c67) return undefined;
  const len = v.getUint32(12, true);
  if (v.getUint32(16, true) !== 0x4e4f534a || 20 + len > buf.byteLength) return undefined;
  return JSON.parse(td.decode(new Uint8Array(buf, 20, len)));
}

/** The files a glTF names outside itself (buffers and images with a uri that isn't data:). */
const gltfFiles = (j: Record<string, unknown> | undefined) =>
  [...((j?.buffers as { uri?: string }[] | undefined) ?? []), ...((j?.images as { uri?: string }[] | undefined) ?? [])].flatMap((x) => (x.uri && !/^data:/i.test(x.uri) ? [x.uri] : []));

async function loadGltf(src: ModelSource, buf: ArrayBuffer, binary: boolean, beside: Beside): Promise<Object3D> {
  const text = binary ? undefined : td.decode(buf);
  const json = binary ? glbJson(buf) : (JSON.parse(text!) as Record<string, unknown>);
  for (const f of gltfFiles(json)) await beside.add(f);
  const gltf = await new GLTFLoader(beside.manager()).parseAsync(binary ? buf : text!, "");
  return gltf.scene;
}

/** A grey for meshes that bring no material of their own (an OBJ without .mtl). */
const plain = (vertexColors: boolean) => new MeshStandardMaterial({ color: vertexColors ? 0xffffff : 0xbdbdbd, vertexColors, roughness: 0.78, metalness: 0, side: DoubleSide });

function normals(root: Object3D) {
  root.traverse((o) => {
    const g = (o as Mesh).geometry as BufferGeometry | undefined;
    if ((o as Mesh).isMesh && g && !g.attributes.normal) g.computeVertexNormals();
  });
}

async function loadObj(src: ModelSource, buf: ArrayBuffer, beside: Beside): Promise<Object3D> {
  const text = td.decode(buf);
  const libs = [...text.matchAll(/^mtllib\s+(.+?)\s*$/gm)].map((m) => m[1]);
  const loader = new OBJLoader();
  let withMtl = false;
  for (const lib of libs.slice(0, 1)) {
    let mtl: string;
    try {
      mtl = td.decode(await src.read(clean(lib)));
    } catch {
      beside.missing.push(clean(lib));
      continue;
    }
    const dir = dirOf(clean(lib));
    // A map line is "map_Kd [options] file"; the file is what's left after the options.
    for (const m of mtl.matchAll(/^\s*(?:map_\w+|bump|disp|decal|norm|refl)\s+(.+?)\s*$/gim)) {
      const file = m[1].split(/\s+/).filter((t, i, a) => !t.startsWith("-") && !(i > 0 && a[i - 1].startsWith("-") && /^[-\d.]+$/.test(t))).pop();
      if (file) await beside.add(dir + file);
    }
    const materials = new MTLLoader(beside.manager()).parse(mtl, dir);
    materials.preload();
    loader.setMaterials(materials);
    withMtl = true;
  }
  const root = loader.parse(text);
  await beside.idle();
  normals(root);
  if (!withMtl)
    root.traverse((o) => {
      const mesh = o as Mesh;
      if (mesh.isMesh) mesh.material = plain(!!mesh.geometry.attributes.color);
    });
  return root;
}

/** A set part's look, from its sidecar. */
function partMaterial(p: SetPart, vertexColors: boolean): MeshStandardMaterial {
  const color = new Color(0xbdbdbd);
  if (p.hex) color.set(p.hex);
  else if (p.srgb) color.setRGB(p.srgb[0], p.srgb[1], p.srgb[2], SRGBColorSpace);
  else if (p.linear) color.setRGB(p.linear[0], p.linear[1], p.linear[2], LinearSRGBColorSpace);
  const m = new MeshStandardMaterial({ color, roughness: p.roughness ?? 0.7, metalness: p.metalness ?? 0, side: DoubleSide, vertexColors });
  m.name = p.label;
  // Without bloom a strong emission is just a flat bright colour, so it's held to a glow you can still read.
  if (p.emissive && p.emissiveStrength) {
    m.emissive.setRGB(p.emissive[0], p.emissive[1], p.emissive[2], LinearSRGBColorSpace);
    m.emissiveIntensity = Math.min(1.6, 0.4 + p.emissiveStrength / 6);
  }
  return m;
}

async function loadSet(src: ModelSource, buf: ArrayBuffer, beside: Beside): Promise<Object3D> {
  const parts = setParts(JSON.parse(td.decode(buf)));
  if (!parts.length) throw new Error(`${src.name} names no OBJ parts.`);
  const root = new Group();
  for (const p of parts) {
    let text: string;
    try {
      text = td.decode(await src.read(clean(p.file)));
    } catch {
      beside.missing.push(p.file);
      continue;
    }
    const part = new OBJLoader().parse(text);
    part.name = p.label;
    normals(part);
    part.traverse((o) => {
      const mesh = o as Mesh;
      if (mesh.isMesh) mesh.material = partMaterial(p, !!mesh.geometry.attributes.color);
    });
    root.add(part);
  }
  if (!root.children.length) throw new Error(`None of ${src.name}'s parts could be read.`);
  return root;
}

const MAPS = ["map", "normalMap", "roughnessMap", "metalnessMap", "emissiveMap", "aoMap", "alphaMap", "bumpMap"] as const;

/** Counts what three.js built: triangles, vertices, materials, textures, colours, size. */
export function statsOf(root: Object3D, format: ModelFormat, missing: string[] = []): ModelStats {
  let triangles = 0;
  let vertices = 0;
  let meshes = 0;
  let vertexColors = false;
  const mats = new Set<Material>();
  const tex = new Map<Texture, TextureStat>();
  root.updateMatrixWorld(true);
  root.traverse((o) => {
    const mesh = o as Mesh;
    if (!mesh.isMesh) return;
    meshes++;
    const g = mesh.geometry;
    const pos = g.attributes.position;
    if (!pos) return;
    vertices += pos.count;
    triangles += Math.floor((g.index ? g.index.count : pos.count) / 3);
    vertexColors ||= !!g.attributes.color;
    for (const m of [mesh.material].flat()) {
      mats.add(m);
      for (const k of MAPS) {
        const t = (m as unknown as Record<string, Texture | null | undefined>)[k];
        const img = t?.image as { width?: number; height?: number } | undefined;
        if (t && !tex.has(t)) tex.set(t, { name: t.name || k.replace(/Map$/, "").replace(/^map$/, "base colour"), width: img?.width ?? 0, height: img?.height ?? 0 });
      }
    }
  });
  const size = new Box3().setFromObject(root).getSize(new Vector3());
  return { format, triangles, vertices, meshes, materials: mats.size, textures: [...tex.values()], vertexColors, size: [size.x, size.y, size.z], missing };
}

/** Reads a model: .glb, .gltf, .obj (with its .mtl), or a set's .json with its parts. */
export async function loadModel(src: ModelSource): Promise<LoadedModel> {
  const format = formatOf(src.name);
  if (!format) throw new Error(`${src.name} isn't a model this viewer reads (.glb, .gltf, .obj, or a set's .json).`);
  const buf = await src.read("");
  const beside = new Beside(src);
  try {
    const root = format === "glb" || format === "gltf" ? await loadGltf(src, buf, format === "glb", beside) : format === "obj" ? await loadObj(src, buf, beside) : await loadSet(src, buf, beside);
    return { root, stats: statsOf(root, format, beside.missing), release: () => beside.release() };
  } catch (e) {
    beside.release();
    throw e;
  }
}
