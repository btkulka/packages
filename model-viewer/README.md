# @btkulka/model-viewer

A three.js viewer for 3D models on disk, made for Gallery's page in Benhäus and its model block in Claude chats.

- **Reads** `.glb`, `.gltf` (with its `.bin` and textures), `.obj` (with its `.mtl` and maps), and **sets**: a model kept as several OBJ parts named in a `<name>.json` beside them, drawn in the sidecar's colours. TRELLIS / Pixal3D's colour groups (`{ groups: [{ file, hex }] }`, from `@btkulka/trellis-client`'s `obj --colors`) and toejam's Blender exports (`{ files: [{ file, part, material, color, roughness, metallic, emission, emission_strength }] }`, linear colours) are both sets.
- **Shows** one model on a canvas: drag turns it (right-drag or Shift-drag pans), scroll zooms, a double-click goes back to the three-quarter view. A turntable; **lit** (the model's own materials under a soft room light and a key light riding with the camera) or **unlit** (base colour only: texture, vertex colours or flat colour, the way concept art reads); **wireframe**. It draws only when something moves.
- **Thumbnails**: `renderThumbnail(source, { size, background })` draws the three-quarter view on the page's background with one shared offscreen renderer, one model at a time, so a grid never holds more than one model or WebGL context.
- **Reads through you.** Every file comes through a `ModelSource`, `{ name, read(rel) }`: the model itself (`rel` "") and anything beside it by a relative path. The loaders get blob: addresses, never the disk or the network, so the same viewer draws from an Electron protocol (`gallery://`), a sandboxed MCP Apps chat block (`block.file()` from `@btkulka/chat-blocks`) or `fetchSource(name, url)`.

ESM for apps that bundle it (Benhäus's renderer, through Vite; three.js comes with it), and one self-contained script, `@btkulka/model-viewer/viewer.global.js` (`window.ModelView`, about 680 KB, nearly all three.js), for a page that can't load modules, which an MCP server inlines into its block page. `@btkulka/model-viewer/sets` is the sidecar reader alone, without three.js.

```json
"dependencies": { "@btkulka/model-viewer": "file:../packages/model-viewer" }
```

```ts
import { fetchSource, ModelViewer, renderThumbnail } from "@btkulka/model-viewer";

const viewer = new ModelViewer(document.getElementById("stage")!, { background: "transparent" });
const stats = await viewer.load(fetchSource("ufo.glb", "gallery://file/12"));   // { triangles, vertices, textures, vertexColors, size, missing, … }
viewer.setTurntable(true);
viewer.setShading("unlit");
viewer.setWireframe(true);
viewer.resetView();
const jpeg = await viewer.snapshot({ width: 480, height: 480, background: "#0c0c0e" });
viewer.dispose();

const { blob } = await renderThumbnail(fetchSource("heap.json", "file:///D:/m/heap.json"), { size: 480, background: "#0c0c0e" });
```

## API

- **`new ModelViewer(container, options?)`**: a viewer filling `container` (it adds a canvas and follows the container's size), or offscreen with `container` null and `options.size`. Options: `background` (a CSS colour or `"transparent"`), `shading` (`"lit"` or `"unlit"`), `wireframe`, `turntable`, `controls` (pointer controls, default on for a viewer in the page).
  - `load(source)` → `ModelStats`; the model before it goes. A load that a newer one overtakes (or that finishes after `dispose()`) rejects with "Superseded…".
  - `clear()`, `setShading(s)`, `setWireframe(on)`, `setTurntable(on)`, `setBackground(css)`, `resetView()`, `snapshot({ width, height, type?, quality?, view?: "three-quarter" | "current", background? })` → `Blob`, `dispose()`. `stats`, `shading`, `wireframe`, `turntable`.
- **`renderThumbnail(source, { size?, background?, shading?, type?, quality? })`** → `{ blob, stats }`, queued.
- **`loadModel(source)`** → `{ root, stats, release() }`, the three.js objects without a viewer. **`statsOf(root, format)`** counts them.
- **`formatOf(name)`**: `"glb"`, `"gltf"`, `"obj"`, `"set"` (a `.json`) or undefined.
- **`setParts(json)`** → `SetPart[]` (`{ file, label, hex?, srgb?, linear?, roughness?, metalness?, emissive?, emissiveStrength? }`), **`setFiles(json)`** → the part file names.
- **`fetchSource(name, url, besideUrl?)`**: a source that fetches the model at `url` and what's beside it at `besideUrl(rel)` (by default the same URL space).

`ModelStats`: `{ format, triangles, vertices, meshes, materials, textures: [{ name, width, height }], vertexColors, size: [w, h, d], missing: [files it names that couldn't be read] }`.

The three-quarter view looks from the front-right and a little above, with the model facing +Z and Y up (glTF's convention, and toejam's "metres, y up, facing +z"). It frames the corners of the model's box, so a long or flat model fills the frame.

## Working on it

`npm run build` runs tsc (ESM only: three.js's addons are ESM) and then `scripts/global.mjs`, which bundles `src/global.ts` with three.js into `dist/viewer.global.js`. `npm test` loads models in Node (a hand-made `.glb`, OBJs, sets) and checks the counts; drawing needs a browser.
