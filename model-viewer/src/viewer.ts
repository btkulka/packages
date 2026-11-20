import {
  Box3,
  Color,
  DirectionalLight,
  Group,
  HemisphereLight,
  MeshBasicMaterial,
  NeutralToneMapping,
  PerspectiveCamera,
  PMREMGenerator,
  Scene,
  Sphere,
  SRGBColorSpace,
  Vector2,
  Vector3,
  WebGLRenderer,
  type Material,
  type Mesh,
  type Texture,
} from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { RoomEnvironment } from "three/addons/environments/RoomEnvironment.js";
import { loadModel, type LoadedModel, type ModelSource, type ModelStats } from "./load.js";

// The viewer: one model on a canvas. Drag turns it (right-drag or Shift-drag pans), scroll zooms, a
// double-click goes back to the three-quarter view. Lit is the model's own materials under a soft room
// light and a key light that follows the camera, so the side you look at is always lit; unlit is its base
// colour alone (texture, vertex colours or flat colour), the way the concept art reads; wireframe shows
// the triangles. It draws only when something moves, so a page of them idles at nothing.

export type Shading = "lit" | "unlit";

export interface ViewerOptions {
  /** A CSS colour behind the model, or "transparent" (the default) to show the page through. */
  background?: string;
  shading?: Shading;
  wireframe?: boolean;
  /** Turn slowly by itself. */
  turntable?: boolean;
  /** Turn, pan and zoom with the pointer. Default true for a viewer in the page, false offscreen. */
  controls?: boolean;
  /** Offscreen (no container): the canvas's size in pixels. */
  size?: { width: number; height: number };
}

export interface SnapshotOptions {
  width: number;
  height: number;
  /** Default image/jpeg. */
  type?: string;
  quality?: number;
  /** "three-quarter" (default) frames the model the way thumbnails do; "current" keeps the camera where it is. */
  view?: "three-quarter" | "current";
  background?: string;
}

/** The three-quarter view: from the front-right, a little above (the model faces +Z, Y up). */
const THREE_QUARTER = new Vector3(0.62, 0.46, 0.64).normalize();

type WithWire = Material & { wireframe?: boolean };

function toUnlit(m: Material): Material {
  const s = m as Material & { map?: Texture | null; color?: Color; vertexColors?: boolean; alphaMap?: Texture | null; alphaTest?: number };
  const b = new MeshBasicMaterial({
    map: s.map ?? null,
    color: s.color ? s.color.clone() : new Color(0xffffff),
    vertexColors: !!s.vertexColors,
    side: m.side,
    transparent: m.transparent,
    opacity: m.opacity,
    alphaMap: s.alphaMap ?? null,
    alphaTest: s.alphaTest ?? 0,
  });
  b.name = m.name;
  return b;
}

function disposeMaterial(m: Material) {
  for (const v of Object.values(m)) if (v && typeof v === "object" && (v as Texture).isTexture) (v as Texture).dispose();
  m.dispose();
}

export class ModelViewer {
  readonly canvas: HTMLCanvasElement;
  private renderer: WebGLRenderer;
  private scene = new Scene();
  private camera = new PerspectiveCamera(32, 1, 0.01, 1000);
  private controls?: OrbitControls;
  private pivot = new Group();
  private model?: LoadedModel;
  private lit = new Map<Mesh, Material | Material[]>();
  private flat = new Map<Mesh, Material | Material[]>();
  /** The unlit copies, which share their textures with the lit materials. */
  private copies = new WeakSet<Material>();
  private o: { background: string; shading: Shading; wireframe: boolean; turntable: boolean };
  private sphere = new Sphere(new Vector3(), 1);
  private raf = 0;
  private last = 0;
  private dirty = true;
  private ro?: ResizeObserver;
  private own = false;
  private loadSeq = 0;
  private gone = false;

  /** A viewer filling `container` (it adds its canvas), or offscreen with `container` null and `o.size`. */
  constructor(container: HTMLElement | null, o: ViewerOptions = {}) {
    this.o = { background: o.background ?? "transparent", shading: o.shading ?? "lit", wireframe: !!o.wireframe, turntable: !!o.turntable };
    this.canvas = document.createElement("canvas");
    this.renderer = new WebGLRenderer({ canvas: this.canvas, antialias: true, alpha: true, preserveDrawingBuffer: !container });
    this.renderer.setPixelRatio(container ? Math.min(window.devicePixelRatio || 1, 2) : 1);
    this.renderer.outputColorSpace = SRGBColorSpace;
    this.renderer.toneMapping = NeutralToneMapping;
    this.renderer.toneMappingExposure = 1.15;
    this.setBackground(this.o.background);

    const pmrem = new PMREMGenerator(this.renderer);
    const room = new RoomEnvironment();
    this.scene.environment = pmrem.fromScene(room, 0.04).texture;
    // Image-to-3D models often come marked fully metallic, and a metal only shows what it reflects: the room
    // is bright enough for those to read, the lights for the rest.
    this.scene.environmentIntensity = 1.5;
    room.dispose();
    pmrem.dispose();
    this.scene.add(new HemisphereLight(0xffffff, 0x50505a, 0.9));
    // The key light rides with the camera, up and to the left of it.
    const key = new DirectionalLight(0xffffff, 2.2);
    key.position.set(-0.6, 1, 0.8);
    key.target.position.set(0, 0, -1);
    this.camera.add(key, key.target);
    this.scene.add(this.camera, this.pivot);

    if (container) {
      this.own = true;
      Object.assign(this.canvas.style, { display: "block", width: "100%", height: "100%", touchAction: "none", outline: "none" });
      container.appendChild(this.canvas);
      if (o.controls !== false) {
        const c = new OrbitControls(this.camera, this.canvas);
        c.enableDamping = true;
        c.dampingFactor = 0.12;
        c.zoomToCursor = true;
        c.autoRotateSpeed = 1.6;
        c.autoRotate = this.o.turntable;
        c.addEventListener("change", this.redraw);
        c.addEventListener("start", this.kick);
        this.controls = c;
        this.canvas.addEventListener("dblclick", () => this.resetView());
      }
      this.ro = new ResizeObserver(() => this.resize());
      this.ro.observe(container);
      this.resize();
    } else {
      this.renderer.setSize(o.size?.width ?? 480, o.size?.height ?? 480, false);
      this.camera.aspect = (o.size?.width ?? 480) / (o.size?.height ?? 480);
      this.camera.updateProjectionMatrix();
    }
  }

  /** The model on screen's counts, once one is loaded. */
  get stats(): ModelStats | undefined {
    return this.model?.stats;
  }

  /** Shows a model (the one before it goes) at the three-quarter view. */
  async load(src: ModelSource): Promise<ModelStats> {
    const seq = ++this.loadSeq;
    const m = await loadModel(src);
    if (seq !== this.loadSeq || this.gone) {
      // Another load started meanwhile (or the viewer went): this one's already stale.
      this.drop(m);
      throw new Error(this.gone ? "Superseded: the viewer was closed." : "Superseded by another model.");
    }
    this.clear();
    this.model = m;
    this.pivot.add(m.root);
    this.look();
    this.resetView();
    return m.stats;
  }

  /** Takes the model away. */
  clear() {
    if (!this.model) return;
    this.pivot.remove(this.model.root);
    this.drop(this.model);
    this.model = undefined;
    this.redraw();
  }

  private drop(m: LoadedModel) {
    const mats = new Set<Material>();
    m.root.traverse((o) => {
      const mesh = o as Mesh;
      if (!mesh.isMesh) return;
      mesh.geometry.dispose();
      for (const x of [this.lit.get(mesh) ?? mesh.material, this.flat.get(mesh) ?? []].flat()) mats.add(x);
      this.lit.delete(mesh);
      this.flat.delete(mesh);
    });
    // An unlit copy shares its textures with the lit one: each texture goes once, with the lit material.
    mats.forEach((x) => (this.copies.has(x) ? x.dispose() : disposeMaterial(x)));
    m.release();
  }

  setShading(s: Shading) {
    this.o.shading = s;
    this.look();
  }
  setWireframe(on: boolean) {
    this.o.wireframe = on;
    this.look();
  }
  setTurntable(on: boolean) {
    this.o.turntable = on;
    if (this.controls) this.controls.autoRotate = on;
    this.kick();
  }
  get shading() {
    return this.o.shading;
  }
  get wireframe() {
    return this.o.wireframe;
  }
  get turntable() {
    return this.o.turntable;
  }

  setBackground(css: string) {
    this.o.background = css;
    if (!css || css === "transparent") this.renderer.setClearColor(0x000000, 0);
    else this.renderer.setClearColor(new Color(css), 1);
    this.redraw();
  }

  /** Lit or unlit materials, wireframe or not, on every mesh. */
  private look() {
    this.model?.root.traverse((o) => {
      const mesh = o as Mesh;
      if (!mesh.isMesh) return;
      if (!this.lit.has(mesh)) this.lit.set(mesh, mesh.material);
      let mat = this.lit.get(mesh)!;
      if (this.o.shading === "unlit") {
        if (!this.flat.has(mesh)) {
          const copy = Array.isArray(mat) ? mat.map(toUnlit) : toUnlit(mat);
          [copy].flat().forEach((c) => this.copies.add(c));
          this.flat.set(mesh, copy);
        }
        mat = this.flat.get(mesh)!;
      }
      mesh.material = mat;
      for (const x of [mat].flat() as WithWire[]) if ("wireframe" in x) x.wireframe = this.o.wireframe;
    });
    this.redraw();
  }

  /** Back to the three-quarter view, the whole model in frame. */
  resetView() {
    this.frame(this.camera.aspect);
    this.controls?.update();
    this.redraw();
  }

  /**
   * The camera at the three-quarter view, as close as it can be with the whole model in frame: each corner
   * of its box is projected onto the view, so a long or flat model fills the frame instead of a sphere round it.
   */
  private frame(aspect: number) {
    const root = this.model?.root;
    if (!root) return;
    const box = new Box3().setFromObject(root);
    box.getBoundingSphere(this.sphere);
    const r = this.sphere.radius > 0 ? this.sphere.radius : 1;
    const c = this.sphere.center;
    const ty = Math.tan((this.camera.fov * Math.PI) / 360) * 0.9;
    const tx = ty * aspect;
    const right = new Vector3().crossVectors(new Vector3(0, 1, 0), THREE_QUARTER).normalize();
    const up = new Vector3().crossVectors(THREE_QUARTER, right).normalize();
    let d = 0;
    const p = new Vector3();
    for (let i = 0; i < 8; i++) {
      p.set(i & 1 ? box.max.x : box.min.x, i & 2 ? box.max.y : box.min.y, i & 4 ? box.max.z : box.min.z).sub(c);
      const z = p.dot(THREE_QUARTER);
      d = Math.max(d, z + Math.abs(p.dot(right)) / tx, z + Math.abs(p.dot(up)) / ty);
    }
    if (!(d > 0)) d = r * 3;
    this.camera.position.copy(c).addScaledVector(THREE_QUARTER, d);
    this.camera.near = d / 200;
    this.camera.far = d * 50;
    this.camera.updateProjectionMatrix();
    this.camera.lookAt(this.sphere.center);
    if (this.controls) {
      this.controls.target.copy(this.sphere.center);
      this.controls.minDistance = r * 0.05;
      this.controls.maxDistance = d * 8;
    }
  }

  private resize() {
    const box = this.canvas.parentElement;
    if (!box) return;
    const w = Math.max(1, box.clientWidth);
    const h = Math.max(1, box.clientHeight);
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.redraw();
  }

  private redraw = () => {
    this.dirty = true;
    this.kick();
  };

  private kick = () => {
    if (this.gone) return;
    if (!this.raf && this.own) this.raf = requestAnimationFrame(this.tick);
    else if (!this.own && this.dirty) this.draw();
  };

  private tick = (t: number) => {
    this.raf = 0;
    const dt = this.last ? Math.min(0.1, (t - this.last) / 1000) : 1 / 60;
    this.last = t;
    const moved = this.controls?.update(dt) ?? false;
    if (moved || this.dirty) this.draw();
    if (moved || this.o.turntable) this.kick();
    else this.last = 0;
  };

  private draw() {
    this.dirty = false;
    this.renderer.render(this.scene, this.camera);
  }

  /** A picture of the model: the three-quarter view (or the current one) at this size. */
  snapshot(o: SnapshotOptions): Promise<Blob> {
    const size = this.renderer.getSize(new Vector2());
    const keep = { aspect: this.camera.aspect, pos: this.camera.position.clone(), quat: this.camera.quaternion.clone(), near: this.camera.near, far: this.camera.far, bg: this.o.background, ratio: this.renderer.getPixelRatio() };
    this.renderer.setPixelRatio(1);
    this.renderer.setSize(o.width, o.height, false);
    if (o.background) this.setBackground(o.background);
    if ((o.view ?? "three-quarter") === "three-quarter") this.frame(o.width / o.height);
    else {
      this.camera.aspect = o.width / o.height;
      this.camera.updateProjectionMatrix();
    }
    this.draw();
    const shot = new Promise<Blob>((resolve, reject) => this.canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("The canvas gave no picture."))), o.type ?? "image/jpeg", o.quality ?? 0.86));
    // Put the canvas back as it was.
    this.renderer.setPixelRatio(keep.ratio);
    this.renderer.setSize(size.x, size.y, false);
    this.camera.aspect = keep.aspect;
    this.camera.position.copy(keep.pos);
    this.camera.quaternion.copy(keep.quat);
    this.camera.near = keep.near;
    this.camera.far = keep.far;
    this.camera.updateProjectionMatrix();
    if (o.background) this.setBackground(keep.bg);
    this.redraw();
    return shot;
  }

  dispose() {
    this.gone = true;
    cancelAnimationFrame(this.raf);
    this.raf = 0;
    this.ro?.disconnect();
    this.controls?.dispose();
    this.clear();
    (this.scene.environment as Texture | null)?.dispose();
    this.renderer.dispose();
    if (this.own) this.canvas.remove();
  }
}

// ── Thumbnails ─────────────────────────────────────────────────────────────

let shared: ModelViewer | undefined;
let queue: Promise<unknown> = Promise.resolve();

export interface ThumbnailOptions {
  /** Square, in pixels. Default 480. */
  size?: number;
  /** The page's background, behind the model. */
  background?: string;
  shading?: Shading;
  type?: string;
  quality?: number;
}

/**
 * A model's thumbnail: the three-quarter view on the page's background, drawn by one shared offscreen
 * renderer, one model at a time (so a grid of them never holds more than one model or WebGL context).
 */
export function renderThumbnail(src: ModelSource, o: ThumbnailOptions = {}): Promise<{ blob: Blob; stats: ModelStats }> {
  const size = o.size ?? 480;
  const run = async () => {
    shared ??= new ModelViewer(null, { size: { width: size, height: size } });
    shared.setShading(o.shading ?? "lit");
    try {
      const stats = await shared.load(src);
      const blob = await shared.snapshot({ width: size, height: size, background: o.background ?? "#16161a", type: o.type, quality: o.quality });
      return { blob, stats };
    } finally {
      shared.clear();
    }
  };
  const p = queue.then(run, run);
  queue = p.catch(() => {});
  return p;
}
