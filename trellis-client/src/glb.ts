// A GLB (glTF 2.0 binary) read into triangles with their vertex colours, the faces grouped by colour (k-means in
// OKLab), and written as Wavefront OBJ files, one per group, with a manifest: what TouchDesigner (one Geometry COMP
// per material), Blender or a game kit wants from a vertex-painted TRELLIS mesh. No dependencies.
import fs from "node:fs";
import path from "node:path";

import { TrellisError } from "./server.js";

export interface GlbMesh {
  /** Flat xyz, in the scene's space (node transforms applied). */
  positions: Float32Array;
  /** Flat xyz, or null when the file has none. */
  normals: Float32Array | null;
  /** Flat rgb, 0..1 linear as stored (glTF vertex colours are linear), or null. */
  colors: Float32Array | null;
  /** Triangle vertex indices. */
  indices: Uint32Array;
  name: string;
}

interface Gltf {
  asset?: { version?: string };
  scene?: number;
  scenes?: { nodes?: number[] }[];
  nodes?: { mesh?: number; children?: number[]; matrix?: number[]; translation?: number[]; rotation?: number[]; scale?: number[]; name?: string }[];
  meshes?: { name?: string; primitives: { attributes: Record<string, number>; indices?: number; mode?: number }[] }[];
  accessors?: { bufferView?: number; byteOffset?: number; componentType: number; count: number; type: string; normalized?: boolean }[];
  bufferViews?: { buffer: number; byteOffset?: number; byteLength: number; byteStride?: number }[];
}

const COMPONENTS: Record<string, number> = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT4: 16 };

function readAccessor(g: Gltf, bin: Buffer, index: number): { data: Float32Array; comps: number } {
  const a = g.accessors?.[index];
  if (!a) throw new TrellisError("bad-glb", `no accessor ${index}`);
  const comps = COMPONENTS[a.type] ?? 1;
  const out = new Float32Array(a.count * comps);
  if (a.bufferView == null) return { data: out, comps };
  const bv = g.bufferViews?.[a.bufferView];
  if (!bv) throw new TrellisError("bad-glb", `no bufferView ${a.bufferView}`);
  const base = (bv.byteOffset ?? 0) + (a.byteOffset ?? 0);
  const sizes: Record<number, number> = { 5120: 1, 5121: 1, 5122: 2, 5123: 2, 5125: 4, 5126: 4 };
  const size = sizes[a.componentType];
  if (!size) throw new TrellisError("bad-glb", `component type ${a.componentType}`);
  const stride = bv.byteStride ?? size * comps;
  const view = new DataView(bin.buffer, bin.byteOffset, bin.byteLength);
  for (let i = 0; i < a.count; i++) {
    for (let c = 0; c < comps; c++) {
      const at = base + i * stride + c * size;
      let v: number;
      switch (a.componentType) {
        case 5120: v = view.getInt8(at); if (a.normalized) v = Math.max(v / 127, -1); break;
        case 5121: v = view.getUint8(at); if (a.normalized) v /= 255; break;
        case 5122: v = view.getInt16(at, true); if (a.normalized) v = Math.max(v / 32767, -1); break;
        case 5123: v = view.getUint16(at, true); if (a.normalized) v /= 65535; break;
        case 5125: v = view.getUint32(at, true); break;
        default: v = view.getFloat32(at, true);
      }
      out[i * comps + c] = v;
    }
  }
  return { data: out, comps };
}

type Mat4 = number[];
const IDENT: Mat4 = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
function mul(a: Mat4, b: Mat4): Mat4 {
  const o = new Array<number>(16).fill(0);
  for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) for (let k = 0; k < 4; k++) o[c * 4 + r] += a[k * 4 + r] * b[c * 4 + k];
  return o;
}
function trs(n: NonNullable<Gltf["nodes"]>[number]): Mat4 {
  if (n.matrix?.length === 16) return n.matrix;
  const [tx, ty, tz] = n.translation ?? [0, 0, 0];
  const [qx, qy, qz, qw] = n.rotation ?? [0, 0, 0, 1];
  const [sx, sy, sz] = n.scale ?? [1, 1, 1];
  const xx = qx * qx, yy = qy * qy, zz = qz * qz, xy = qx * qy, xz = qx * qz, yz = qy * qz, wx = qw * qx, wy = qw * qy, wz = qw * qz;
  return [
    (1 - 2 * (yy + zz)) * sx, 2 * (xy + wz) * sx, 2 * (xz - wy) * sx, 0,
    2 * (xy - wz) * sy, (1 - 2 * (xx + zz)) * sy, 2 * (yz + wx) * sy, 0,
    2 * (xz + wy) * sz, 2 * (yz - wx) * sz, (1 - 2 * (xx + yy)) * sz, 0,
    tx, ty, tz, 1,
  ];
}
function apply(m: Mat4, p: Float32Array, normal: boolean): Float32Array {
  const out = new Float32Array(p.length);
  for (let i = 0; i < p.length; i += 3) {
    const x = p[i], y = p[i + 1], z = p[i + 2];
    out[i] = m[0] * x + m[4] * y + m[8] * z + (normal ? 0 : m[12]);
    out[i + 1] = m[1] * x + m[5] * y + m[9] * z + (normal ? 0 : m[13]);
    out[i + 2] = m[2] * x + m[6] * y + m[10] * z + (normal ? 0 : m[14]);
    if (normal) {
      const l = Math.hypot(out[i], out[i + 1], out[i + 2]) || 1;
      out[i] /= l; out[i + 1] /= l; out[i + 2] /= l;
    }
  }
  return out;
}

/** Every triangle primitive of the file's default scene, in scene space, one GlbMesh per primitive. */
export function parseGlb(buf: Buffer): GlbMesh[] {
  if (buf.length < 20 || buf.readUInt32LE(0) !== 0x46546c67) throw new TrellisError("bad-glb", "not a GLB (no glTF magic)");
  const total = buf.readUInt32LE(8);
  let at = 12;
  let json: Gltf | null = null;
  let bin: Buffer | null = null;
  while (at + 8 <= Math.min(total, buf.length)) {
    const len = buf.readUInt32LE(at);
    const type = buf.readUInt32LE(at + 4);
    const chunk = buf.subarray(at + 8, at + 8 + len);
    if (type === 0x4e4f534a) json = JSON.parse(chunk.toString("utf8")) as Gltf;
    else if (type === 0x004e4942) bin = chunk;
    at += 8 + len;
  }
  if (!json) throw new TrellisError("bad-glb", "no JSON chunk");
  const binBuf = bin ?? Buffer.alloc(0);
  const out: GlbMesh[] = [];
  const nodes = json.nodes ?? [];
  const roots = json.scenes?.[json.scene ?? 0]?.nodes ?? nodes.map((_, i) => i);
  const visit = (ni: number, parent: Mat4) => {
    const n = nodes[ni];
    if (!n) return;
    const m = mul(parent, trs(n));
    if (n.mesh != null) {
      const mesh = json!.meshes?.[n.mesh];
      mesh?.primitives.forEach((p, pi) => {
        if ((p.mode ?? 4) !== 4 || p.attributes.POSITION == null) return;
        const pos = readAccessor(json!, binBuf, p.attributes.POSITION).data;
        const nrm = p.attributes.NORMAL != null ? readAccessor(json!, binBuf, p.attributes.NORMAL).data : null;
        let col: Float32Array | null = null;
        if (p.attributes.COLOR_0 != null) {
          const c = readAccessor(json!, binBuf, p.attributes.COLOR_0);
          col = new Float32Array((pos.length / 3) * 3);
          for (let i = 0; i < pos.length / 3; i++) for (let k = 0; k < 3; k++) col[i * 3 + k] = c.data[i * c.comps + k];
        }
        let idx: Uint32Array;
        if (p.indices != null) idx = Uint32Array.from(readAccessor(json!, binBuf, p.indices).data);
        else idx = Uint32Array.from({ length: pos.length / 3 }, (_, i) => i);
        out.push({ positions: apply(m, pos, false), normals: nrm ? apply(m, nrm, true) : null, colors: col, indices: idx, name: `${mesh.name ?? n.name ?? `mesh${n.mesh}`}${mesh.primitives.length > 1 ? `_${pi}` : ""}` });
      });
    }
    for (const c of n.children ?? []) visit(c, m);
  };
  for (const r of roots) visit(r, IDENT);
  return out;
}

export function meshStats(meshes: GlbMesh[]): { meshes: number; vertices: number; triangles: number; colored: boolean; bounds: { min: number[]; max: number[] } } {
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  let vertices = 0, triangles = 0, colored = false;
  for (const m of meshes) {
    vertices += m.positions.length / 3;
    triangles += m.indices.length / 3;
    colored ||= !!m.colors;
    for (let i = 0; i < m.positions.length; i += 3) for (let k = 0; k < 3; k++) { min[k] = Math.min(min[k], m.positions[i + k]); max[k] = Math.max(max[k], m.positions[i + k]); }
  }
  return { meshes: meshes.length, vertices, triangles, colored, bounds: { min, max } };
}

// -- colour -----------------------------------------------------------------------------------------------------------

const linToSrgb = (c: number): number => (c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055);
const srgbToLin = (c: number): number => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));

/** sRGB 0..1 to OKLab. */
export function srgbToOklab(r: number, g: number, b: number): [number, number, number] {
  const lr = srgbToLin(r), lg = srgbToLin(g), lb = srgbToLin(b);
  const l = Math.cbrt(0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb);
  const m = Math.cbrt(0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb);
  const s = Math.cbrt(0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb);
  return [0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s, 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s, 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s];
}

/** OKLab to sRGB 0..1 (clamped). */
export function oklabToSrgb(L: number, a: number, b: number): [number, number, number] {
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  const lr = 4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s;
  const lg = -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s;
  const lb = -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s;
  const clamp = (v: number) => Math.min(1, Math.max(0, v));
  return [clamp(linToSrgb(lr)), clamp(linToSrgb(lg)), clamp(linToSrgb(lb))];
}

export interface ColorGroup {
  /** The group's mean colour, sRGB 0..1. */
  srgb: [number, number, number];
  hex: string;
  faces: number;
}

function hashSeed(n: number): () => number {
  let x = n >>> 0 || 1;
  return () => {
    x ^= x << 13; x >>>= 0; x ^= x >>> 17; x ^= x << 5; x >>>= 0;
    return x / 4294967296;
  };
}

/**
 * Each face's colour (the mean of its vertices', taken as linear and shown as sRGB) clustered into `k` groups by
 * k-means in OKLab (k-means++ seeding, a fixed seed, so a file always splits the same way). Returns the group of
 * every face and the groups, brightest first. A mesh without colours is one group.
 */
export function splitByColor(mesh: GlbMesh, k = 6, seed = 7): { group: Uint16Array; groups: ColorGroup[] } {
  const nf = mesh.indices.length / 3;
  const group = new Uint16Array(nf);
  if (!mesh.colors || k <= 1) return { group, groups: [{ srgb: [0.5, 0.5, 0.5], hex: "#808080", faces: nf }] };
  const lab = new Float32Array(nf * 3);
  const rgb = new Float32Array(nf * 3);
  for (let f = 0; f < nf; f++) {
    let r = 0, g = 0, b = 0;
    for (let v = 0; v < 3; v++) {
      const i = mesh.indices[f * 3 + v] * 3;
      r += mesh.colors[i]; g += mesh.colors[i + 1]; b += mesh.colors[i + 2];
    }
    const sr = linToSrgb(r / 3), sg = linToSrgb(g / 3), sb = linToSrgb(b / 3);
    rgb[f * 3] = sr; rgb[f * 3 + 1] = sg; rgb[f * 3 + 2] = sb;
    const l = srgbToOklab(sr, sg, sb);
    lab[f * 3] = l[0]; lab[f * 3 + 1] = l[1]; lab[f * 3 + 2] = l[2];
  }
  const rand = hashSeed(seed);
  const kk = Math.min(k, nf);
  const centers: number[][] = [];
  const d2 = new Float64Array(nf).fill(Infinity);
  const first = Math.floor(rand() * nf);
  centers.push([lab[first * 3], lab[first * 3 + 1], lab[first * 3 + 2]]);
  while (centers.length < kk) {
    const c = centers[centers.length - 1];
    let sum = 0;
    for (let f = 0; f < nf; f++) {
      const dd = (lab[f * 3] - c[0]) ** 2 + (lab[f * 3 + 1] - c[1]) ** 2 + (lab[f * 3 + 2] - c[2]) ** 2;
      if (dd < d2[f]) d2[f] = dd;
      sum += d2[f];
    }
    let pick = rand() * sum, chosen = nf - 1;
    for (let f = 0; f < nf; f++) { pick -= d2[f]; if (pick <= 0) { chosen = f; break; } }
    centers.push([lab[chosen * 3], lab[chosen * 3 + 1], lab[chosen * 3 + 2]]);
  }
  for (let iter = 0; iter < 25; iter++) {
    let moved = 0;
    for (let f = 0; f < nf; f++) {
      let best = 0, bd = Infinity;
      for (let c = 0; c < centers.length; c++) {
        const dd = (lab[f * 3] - centers[c][0]) ** 2 + (lab[f * 3 + 1] - centers[c][1]) ** 2 + (lab[f * 3 + 2] - centers[c][2]) ** 2;
        if (dd < bd) { bd = dd; best = c; }
      }
      if (group[f] !== best) { group[f] = best; moved++; }
    }
    const sums = centers.map(() => [0, 0, 0, 0]);
    for (let f = 0; f < nf; f++) { const s = sums[group[f]]; s[0] += lab[f * 3]; s[1] += lab[f * 3 + 1]; s[2] += lab[f * 3 + 2]; s[3]++; }
    for (let c = 0; c < centers.length; c++) if (sums[c][3]) centers[c] = [sums[c][0] / sums[c][3], sums[c][1] / sums[c][3], sums[c][2] / sums[c][3]];
    if (!moved) break;
  }
  // the groups in order of lightness, dropping empty ones
  const order = centers.map((c, i) => ({ i, L: c[0], n: 0 }));
  for (let f = 0; f < nf; f++) order[group[f]].n++;
  const kept = order.filter((o) => o.n > 0).sort((a, b) => b.L - a.L);
  const remap = new Map(kept.map((o, j) => [o.i, j]));
  const groups: ColorGroup[] = kept.map((o) => {
    const acc = [0, 0, 0];
    let n = 0;
    for (let f = 0; f < nf; f++) if (group[f] === o.i) { acc[0] += rgb[f * 3]; acc[1] += rgb[f * 3 + 1]; acc[2] += rgb[f * 3 + 2]; n++; }
    const srgb: [number, number, number] = [acc[0] / n, acc[1] / n, acc[2] / n];
    const hex = "#" + srgb.map((v) => Math.round(v * 255).toString(16).padStart(2, "0")).join("");
    return { srgb, hex, faces: n };
  });
  for (let f = 0; f < nf; f++) group[f] = remap.get(group[f]) ?? 0;
  return { group, groups };
}

export interface ObjFiles {
  /** One OBJ per colour group: `<prefix>_<k>.obj`. */
  files: string[];
  /** `<prefix>.json`: the groups' colours and face counts, and the mesh's stats. */
  manifest: string;
  groups: ColorGroup[];
}

/**
 * Write a mesh as OBJ files, one per colour group (faces of other groups left out, vertices renumbered), each with
 * positions and normals when the file has them, plus a manifest. `scale` and `yUp` fit the model to the consumer:
 * TouchDesigner and Blender both take Y up as glTF has it.
 */
export function writeObj(mesh: GlbMesh, group: Uint16Array, groups: ColorGroup[], prefix: string, opts: { scale?: number; precision?: number } = {}): ObjFiles {
  const scale = opts.scale ?? 1;
  const prec = opts.precision ?? 5;
  fs.mkdirSync(path.dirname(prefix), { recursive: true });
  const files: string[] = [];
  const nf = mesh.indices.length / 3;
  groups.forEach((g, k) => {
    const file = `${prefix}_${k}.obj`;
    const lines: string[] = [`# ${path.basename(prefix)} group ${k}: ${g.hex}, ${g.faces} faces (@btkulka/trellis-client)`, `o ${path.basename(prefix)}_${k}`];
    const remap = new Map<number, number>();
    const faces: number[][] = [];
    for (let f = 0; f < nf; f++) {
      if (group[f] !== k) continue;
      const tri: number[] = [];
      for (let v = 0; v < 3; v++) {
        const i = mesh.indices[f * 3 + v];
        let j = remap.get(i);
        if (j == null) {
          j = remap.size + 1;
          remap.set(i, j);
          const p = mesh.positions;
          lines.push(`v ${(p[i * 3] * scale).toFixed(prec)} ${(p[i * 3 + 1] * scale).toFixed(prec)} ${(p[i * 3 + 2] * scale).toFixed(prec)}`);
          if (mesh.normals) lines.push(`vn ${mesh.normals[i * 3].toFixed(4)} ${mesh.normals[i * 3 + 1].toFixed(4)} ${mesh.normals[i * 3 + 2].toFixed(4)}`);
        }
        tri.push(j);
      }
      faces.push(tri);
    }
    for (const t of faces) lines.push(mesh.normals ? `f ${t[0]}//${t[0]} ${t[1]}//${t[1]} ${t[2]}//${t[2]}` : `f ${t[0]} ${t[1]} ${t[2]}`);
    fs.writeFileSync(file, lines.join("\n") + "\n");
    files.push(file);
  });
  const manifest = `${prefix}.json`;
  fs.writeFileSync(manifest, JSON.stringify({ name: path.basename(prefix), source: mesh.name, scale, stats: meshStats([mesh]), groups: groups.map((g, k) => ({ file: path.basename(files[k]), hex: g.hex, srgb: g.srgb, faces: g.faces })) }, null, 1));
  return { files, manifest, groups };
}

export interface GlbToObjOptions {
  /** Colour groups (default 6; 0 or 1 keeps everything in one file). */
  colors?: number;
  scale?: number;
  /** Merge every primitive into one mesh first (default true). */
  merge?: boolean;
}

/** A GLB file to OBJ files split by colour, written as `<prefix>_<k>.obj` with `<prefix>.json`. */
export function glbToObj(glbPath: string, prefix: string, opts: GlbToObjOptions = {}): ObjFiles {
  const meshes = parseGlb(fs.readFileSync(glbPath));
  if (!meshes.length) throw new TrellisError("bad-glb", `${glbPath} has no triangle meshes`);
  let mesh = meshes[0];
  if ((opts.merge ?? true) && meshes.length > 1) {
    const nv = meshes.reduce((n, m) => n + m.positions.length / 3, 0);
    const positions = new Float32Array(nv * 3);
    const normals = meshes.every((m) => m.normals) ? new Float32Array(nv * 3) : null;
    const colors = meshes.every((m) => m.colors) ? new Float32Array(nv * 3) : null;
    const indices = new Uint32Array(meshes.reduce((n, m) => n + m.indices.length, 0));
    let vo = 0, io = 0;
    for (const m of meshes) {
      positions.set(m.positions, vo * 3);
      if (normals && m.normals) normals.set(m.normals, vo * 3);
      if (colors && m.colors) colors.set(m.colors, vo * 3);
      for (let i = 0; i < m.indices.length; i++) indices[io + i] = m.indices[i] + vo;
      vo += m.positions.length / 3;
      io += m.indices.length;
    }
    mesh = { positions, normals, colors, indices, name: path.basename(glbPath, ".glb") };
  }
  const { group, groups } = splitByColor(mesh, opts.colors ?? 6);
  return writeObj(mesh, group, groups, prefix, { scale: opts.scale });
}
