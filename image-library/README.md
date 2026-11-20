# @btkulka/image-library

A library of images, videos and 3D models on disk, kept in one SQLite file. It has:

- nested virtual collections (an image can be in several, and filing one never moves its file);
- tags, and a star (the `starred` tag, `STARRED`), which a pick from a chat also sets. It was `picked` until 2026-11-19: a library's old `picked` tag folds into `starred` each time it opens;
- view counts: how often each item has been opened large (`markViewed`), and when last;
- search by words (name, folder, prompt, model, note, tags), `tag:` `model:` `is:starred` `is:video` `is:model` `is:image` `in:"Collection"` `ext:` `-word` `"phrases"`, collections, tags, model and dates, sorted by date, name, size, cost or views;
- watched folders whose new images come in by themselves and are filed into a collection;
- the prompt, model and cost from the `<name>.json` sidecar that `gemini-image` (`@btkulka/gemini-client`) writes beside each image;
- moving and renaming files on disk with their sidecars, the library following;
- the Benhäus Claude panel's carousel lines (`![#12 name](path)`, one per line) and its pick message (`Picked 2 of 4: … (path)`) read back;
- videos as items too: `.mp4`, `.m4v`, `.mov`, `.webm`, `.mkv`, `.avi`, with ffprobe's facts (length, frame size, upright for a rotated phone clip, frame rate, video and audio codecs, bitrate, container) and an ffmpeg frame for the thumbnail, both through `@btkulka/media-kit` (no ffprobe: the video still comes in, its facts blank and `error` saying why). A `<name>.json` beside a video is read like a picture's;
- 3D models as items too: `.glb`, `.gltf`, `.obj`, and sets of OBJ parts named in a `<name>.json` (TRELLIS colour groups, Blender exports), with their triangles, vertices, textures (sizes and what they're for), vertex colours, size and parts, the concept image each came from (trellis-client's `<name>.meta.json` names it, or they share a name), and the files that go with a model when it moves or is deleted. A set's parts are one model, not one each.

Several processes can share the file (WAL). Gallery runs this way: Benhäus's Gallery page holds the library, watching the folders and drawing thumbnails, while Gallery's MCP server (`D:/source/gallery`) gives Claude the same file. Each one notices the other's writes through `dataVersion()`.

It never imports a driver or Electron. The app hands in node:sqlite's `DatabaseSync`, and for thumbnails, Electron's `nativeImage`. Built on `@btkulka/sqlite-store` and `@btkulka/media-kit` (which finds ffmpeg and ffprobe). ESM and CommonJS. Node 22.13+ (node:sqlite unflagged).

```json
"dependencies": { "@btkulka/image-library": "file:../packages/image-library" }
```

```ts
import { DatabaseSync } from "node:sqlite";
import { markdownImages, openLibrary } from "@btkulka/image-library";

const lib = openLibrary(DatabaseSync, "D:/source/gallery/data/gallery.db");
const art = lib.ensureCollectionPath("toejam > Money Warehouse > Concept art");
const w = lib.addWatch({ folder: "D:/source/toejam/pieces/money/concept", collectionId: art.id });
await lib.scanWatch(w.id);                                   // { seen, added, updated, missing, errors }
const { items } = lib.search({ text: "uplight model:pro", collectionId: art.id, limit: 8 });
markdownImages(items);                                       // the carousel lines
await lib.pick({ text: "Picked 2 of 8: #45 uplight-2 (D:/…/uplight-2.jpg)" });
```

## API

### Opening

- **`openLibrary(DatabaseSync, path)`**: opens (or creates and migrates) the file with sqlite-store's pragmas (WAL, foreign keys, 5 s busy timeout) and returns a `Library`.
- `lib.once(name, step)`: a named step that runs once per file (an app's seed collections). `lib.close()`.
- `lib.dataVersion()`: SQLite's `data_version`, which moves when another connection commits. Poll it to notice another process's changes.

### Collections

A `CollectionInfo` is `{ id, parentId, name, folder, note, count, total, path }`. `count` is images filed directly in it and `total` is images in it or anywhere below. Missing files don't count. `path` reads "toejam › Money Warehouse › Concept art".

- `listCollections()`, `collection(id)`, `descendants(id)`.
- `resolveCollection(ref)`: an id (`12`, `"#12"`), a path (`>` `›` or `/` between names), or a name that's unique. Otherwise it throws a `LibraryError` naming the candidates.
- `createCollection({ name, parentId?, folder?, note? })`, `ensureCollectionPath(path)` (creates missing levels), `updateCollection(id, { name?, parentId?, folder?, note? })` (refuses to put a collection inside itself), `deleteCollection(id)` (everything below goes too; images stay).
- `fileImages(ids, collectionId, mode = "add" | "move" | "remove", fromId?)`. `move` takes them out of `fromId`, or out of every other collection.

### Images

An `ImageRow` is `{ id, kind, path, name, folder, ext, bytes, width, height, mtime, created, addedAt, missing, prompt, model, usd, tags, tris, mesh, video, views, viewedAt, stack }`. `kind` is `image`, `model` or `video`; a video's `width` and `height` are its frame's, and `video` is `{ duration (s), width, height, fps, codec, audio (null when silent), bitrate?, container?, error? }`. `created` is the sidecar's `at`, else the file's time. `image(ref)` adds `note`, the parsed `sidecar` and `collections`. Paths are absolute with forward slashes and an upper-case drive letter (`normPath`), and compared without case.

- `search(query)` → `{ total, items }`. Query fields: `text`, `collectionId` + `includeSub`, `unfiled`, `tags`, `notTags`, `untagged`, `model`, `from`/`to` (a bare date covers the whole day), `missing` (`hide` by default, `only`, `show`), `ids`, `kind`, `sort` (`newest`, `oldest`, `added`, `name`, `size`, `cost`, `views`: the most looked-at first), `limit` (200), `offset`.
- `find(ref)`, `image(ref)`, `ids(refs)` (throws naming the refs it can't find).
- `addPaths(paths, { collectionId?, tags?, recursive? })` takes files and folders → `{ added, existing, skipped }`.
- `upsertFile(path)`: reads one file in, or refreshes it when the file or its sidecar changed. A file that turns up where a missing one of the same size and time was (renamed in Explorer) takes over that row, keeping its tags and collections.
- `moveFiles(ids, folder)` → `{ moved, failed }`. The sidecar moves with its image, and a taken name gets ` (2)`. `renameImage(id, name)` keeps the extension unless one is given, and the sidecar follows.
- `removeImages(ids)` (library only; files stay), `markMissing(path)`, `purgeMissing()`, `setNote(id, note)`.
- `markViewed(ids)` → `[{ id, views }]`: counts a look at each (the app decides what a look is; Gallery's page counts an item open large for a second).
- `videoInfo(path)` (ffprobe, never throws), `videoFacts(probe)`, `videoFrame(path, out, px, duration?)` (a JPEG a tenth of the way in, at most 3 s, else the first frame), `isVideo`, `VIDEO_EXTS`.

### 3D models

A model is an item like a picture: `kind` is `"model"` (pictures are `"image"`), `width` and `height` are null, `tris` is its triangle count and `mesh` what's in it (`MeshInfo`: `{ format: "glb" | "gltf" | "obj" | "set", triangles, vertices, meshes, materials, vertexColors, uvs, textures: [{ name, role, width, height, mime, bytes, file }], size, parts, extensions, error }`). It's read cheaply: a `.glb`'s JSON chunk and its textures' headers (never the whole file), an `.obj` line by line, a set through its sidecar. A file that can't be read yet (half written) keeps `error` until it changes. `search({ kind })`, `is:model` and `is:image` filter by kind; `info().meshes` counts them.

- **Sets.** A `<name>.json` that names OBJ parts beside it (`{ groups: [{ file, hex }] }` from TRELLIS, `{ files: [{ file, part, material, color, tris }] }` from Blender) folds them into one model: the `.glb` beside it when there is one (heap.glb with heap_0…5.obj), else the sidecar itself (a Blender export's ufo.json). `walk()` skips the parts; parts that came in before their sidecar was written are taken out of the library (their files stay) when it is. `partsOf(json)`, `readSet(path)`, `isPart(path)`, `meshBeside(json)`.
- **The model's sidecar** is trellis-client's `<name>.meta.json` (a variant like `brick-px-textured.glb` reads its base's, `brick-px.meta.json`): `made` becomes `created`, `model` the model (`model:pixal3d` searches it), the whole object `sidecar` in `image()`.
- **Concept.** `conceptOf(model)` → `{ id, path, name, mtime, missing, how }`: one linked by hand (`setConcept(model, image | null)`, `how: "set"`), else the picture the sidecar names (by path, or by file name, the one nearest the model; `"sidecar"`), else a picture sharing its name in the same project (`ufo-t2-textured.glb` ↔ `ufo.png`, under the folder two above the model's; `"name"`). A sidecar naming a picture that isn't in the library yet brings it in, found under the model's project in a folder whose path says "concept". `image(picture).models` lists the models made from it.
- **Companions.** `companions(item)` (and `image().companions`): what goes with it. A picture's gemini-image sidecar; a model's `<name>.json`, `.meta.json` and `-prompt.json`, a set's or a `.glb`'s parts, an `.obj`'s own `.mtl` and its maps, a `.gltf`'s `.bin` and textures. `moveFiles` takes them along (one named after the model takes its new name; one whose name is taken there stays, said in `warnings`); `renameImage` renames a model's sidecars with it and refuses a set (its parts are named after it). `image()` is async (it reads the companions).
- **Thumbnails** can't be decoded from a model: the app draws them (Benhäus with `@btkulka/model-viewer`) and keeps them with `createThumbs(…).put(id, mtime, jpeg)` beside the pictures' (`thumbFile(dir, id, mtime)` is where).
- `onDiskChange(path)`: what a watcher calls for a changed path. An image appeared (filed into its watch's collection), changed, or went (marked missing), or a sidecar was written.

### Stacks

Versions of one thing shown as one item: a model's textured and untextured meshes. A stack is its members in order; the first is the front runner.

- **`search()`** collapses a stack to its first member that matches (the front, unless the search leaves it out). `stacks: "expand"` lists every member; `openStacks: [id]` shows those stacks' members side by side in stack order; asking by `ids` expands. Each row's `stack` is `{ id, ids, front }` (ids front first), `image().stacked` the members with their names, kinds and texture counts.
- **`stackImages(ids, frontId?)`**: one stack (stacks they're in join it); the front is `frontId`, else the front of one already stacked, else the first. **`setStackFront(id)`**, **`unstackImages(ids, whole?)`** (`whole` breaks the stacks up), **`stackItems(stackId)`**. A stack left with one member is none (a trigger sees to it when a member leaves the library).
- **Twins stack by themselves:** `brick-textured.glb` with `brick.glb` in one folder, textured in front (`stackVariants()`), as a model comes in, on opening the library and after each scan. One taken out of a stack by hand stays apart until it's stacked again by hand.

### Tags, stars and picks

- `listTags()` (with counts), `tagImages(ids, add, remove)`, `setTags(id, tags)`, `renameTag(from, to)` (into an existing tag merges them), `deleteTag(name)`. Tags left on no image are pruned, apart from `starred`.
- `pick({ id? | path? | text?, tag = "starred", unpick? })`: `text` is the panel's pick message, read by `parsePick`. A picked file not in the library yet is added.
- `markdownImages(rows)`: one `![#<id> <name>](<path>)` per line. A path markdown would trip on (spaces, brackets, `#`) goes as a `file:` URL, which `normPath` and `pick` read back.

### Watched folders

- `listWatches()` (each with `exists`), `addWatch({ folder, collectionId?, recursive? })`, `updateWatch(id, …)`, `removeWatch(id)`, `watchFor(path)`.
- `scanWatch(id)`, `scanAll()` → `{ seen, added, updated, missing, errors }`. Dot-folders, `node_modules` and `.part` files are skipped.
- **`createWatchers(lib, onChange, log)`** → `{ sync(), close() }`: `fs.watch` (recursive) on every enabled watch, debounced per path. A folder moved in rescans its watch. `sync()` follows the watch list and returns the watches that just started, so you can scan them. Call it on a timer, since a folder that doesn't exist yet starts once it does.

### Thumbnails (Electron main)

- **`createThumbs(dir, nativeImage, px = 480)`** → `{ get(id, path, mtime, kind?, duration?), put(id, mtime, jpeg) }`. Uses Windows' shell thumbnailer first, then Electron's decoder, and caches a JPEG per id, mtime and size, four at a time. Undefined when neither decoder can read the file (serve the original then). A video's is an ffmpeg frame (`duration` picks it), else the shell's; a model's is drawn by the page and kept with `put`.

### Between processes

- `requestView({ collectionId?, text?, imageId?, compare? })` / `takeViewRequest(maxAgeMs)`: one process asks the page showing the library to show something (Claude's `open_gallery`).
- `heartbeat()` / `windowAlive(withinMs)`: whether the process holding the library is up.

## Replaces

New with Gallery (2026-11-18). Gallery's first cut had this code in `D:/source/gallery/src/core` and `src/main/{watchers,thumbs}.ts`; those were deleted when it moved here. No other app had an image library.

## Working on it

```
npm run build       # ESM (dist/esm) + CommonJS (dist/cjs)
npm run typecheck
npm test            # build, then node --test on node:sqlite (temp folders, fake PNG headers, a real clip when ffmpeg is installed)
```
