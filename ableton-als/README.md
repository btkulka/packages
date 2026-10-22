# @btkulka/ableton-als

Reads Ableton Live documents: `.als` sets, `.adg` racks and `.adv` presets, which are all gzipped UTF-8 XML. It covers what Ben's apps take out of them, and no more:

- the gzip envelope, both ways;
- the root header: Live version, document type, and the "is this really an Ableton file?" check;
- every file reference, across the Live 9/10 and Live 11/12 layouts;
- the samples a set loads that are missing on disk, for Splice recovery;
- an XML-comment helper for watermarking `.adg`/`.adv` downloads.

Node only (`node:zlib`, `node:fs`). No runtime dependencies.

```json
"dependencies": { "@btkulka/ableton-als": "file:../packages/ableton-als" }
```

## XML approach

Neither copy used an XML library: candybar-manager ran a regex over the text and the extension store sniffed the first 4 KB. This package has its own small tag scanner (`src/xml.ts`, about 150 lines). It makes one pass, honours quoted attribute values, decodes entities, and skips comments, CDATA, processing instructions and DOCTYPE. It reads only the elements it needs, so a 50 MB set costs a few hundred milliseconds and no DOM.

A full XML library wasn't worth adding for this. The regex wasn't safe to keep. Run over Ben's 253 real sets (D:\Music, Live 9.2 to 12.3, 1.6 GB of XML), it:

- skipped 1,294 `<Path>` values that contain an apostrophe (Splice packs like "David Herrero's Organic House Beats"), so those samples were never checked;
- left `&amp;` encoded (2,936 occurrences): files with `&` in the path were reported missing although present, and missing ones were remapped into folders literally named `…&amp;…`;
- reported plugin DLLs (`VstPluginInfo/Path`), device presets, Core Library device folders, grooves and Max devices as "missing samples": 363 preset and plugin false positives plus about 600 device-folder and moved-project ones in the Live 11/12 sets alone;
- found nothing at all in Live 9/10 sets (142 of the 253), which store paths differently.

The package handles all of these. On the same 253 sets it ran at about 135 MB/s, two full passes plus the existence checks included.

## API

```ts
import {
  readAbletonXmlSync, readAbletonXml, decodeAbletonXml, encodeAbletonXml, isGzip, AbletonFormatError,
  readAbletonHeader, listFileRefs, findMissingSamples, isSplicePath, sampleSearchKey, insertXmlComment,
} from "@btkulka/ableton-als";

const xml = readAbletonXmlSync("D:/Music/Song Project/Song.als"); // or: await readAbletonXml(path)

readAbletonHeader(xml);
// { majorVersion: "5", minorVersion: "12.0_12203", schemaChangeCount: 3, creator: "Ableton Live 12.2.5",
//   revision: "…", liveVersion: "12.2.5", liveMajor: 12, documentType: "LiveSet" }   (null if the root isn't <Ableton>)

listFileRefs(xml);
// [{ path: "C:/Users/…/Splice/Samples/packs/…/kick.wav", relativePath: "", relativeTo: "none", name: "kick.wav", owner: "SampleRef" }, …]

findMissingSamples("D:/Music/Song Project/Song.als");
// { alsPath, totalRefs, spliceRefs, unresolved,
//   missing: [{ originalPath, relativePath, basename, searchKey, isSplice }] }
```

**Envelope**
- `isGzip(bytes)`: checks the gzip magic number.
- `decodeAbletonXml(bytes): string`: gunzips and strips a BOM. Anything that isn't gzip, or is corrupt gzip, throws `AbletonFormatError`.
- `encodeAbletonXml(xml): Buffer`: gzips.
- `readAbletonXmlSync(path)` / `readAbletonXml(path)`: read the file and decode it. A missing file throws the usual `ENOENT`.
- `insertXmlComment(xml, text)`: puts `<!-- text -->` right after the `<?xml …?>` declaration, or at the very top when there is none. `--` in the text is split so the comment stays well-formed.

**Header**
- `readAbletonHeader(xml): AbletonHeader | null`. `liveVersion`/`liveMajor` come from `Creator`, and `liveMajor` falls back to the prefix of `MinorVersion`. `documentType` is the first child of `<Ableton>`: `LiveSet`, `GroupDevicePreset`, … It stops after that child, so it is cheap on big sets. A bare `<Ableton><GroupDevicePreset/></Ableton>` still gets a header, with null versions.

**File references**: `listFileRefs(xml): AbletonFileRef[]`, in document order, duplicates kept.
- `path`: the absolute path as Live saved it, entities decoded. Live 11+ writes `/` even on Windows. Live 9/10 keep it in hex `<Data>`: decoded when it's a Windows path (UTF-16LE), null when it's a macOS alias record.
- `relativePath`: `/`-separated, `..` for a parent folder (Live 9/10 write that as an empty `Dir`), `''` when none.
- `relativeTo`: from `RelativePathType`: `none` (0), `external` (1, outside the project, reached from its folder with `..`), `project` (3), `library` (5, Core Library or a Pack), `user-library` (6), `built-in` (7), else `unknown`.
- `name`: the file name.
- `owner`: the element holding the reference, which says what the file is for. `SampleRef` is audio Live loads (clips, Simpler, Sampler, Drum Rack pads). `OriginalFileRef` is where something came from before it was imported. `FilePresetRef` / `AbletonDefaultPresetRef` are device presets. `MxPatchRef` / `MxDPatchRef` are Max for Live devices.

**Missing samples**: `findMissingSamples(alsPath, { exists?, projectDir?, xml? })`
- Only `SampleRef` references count. Each distinct sample is checked once.
- A sample is present when its project-relative path (for `project`/`external`, resolved against `projectDir`, which defaults to the set's folder) or its absolute path exists. That is how Live finds samples after a project moves.
- `originalPath` is the absolute path from the set. When there is none, it's the resolved relative path.
- `unresolved` counts samples with neither path: Live 9/10 sets saved on a Mac that point into a Pack. They can't be checked, so they aren't reported as missing.
- `exists` defaults to `fs.existsSync`. Pass `xml` to skip reading the file.
- `isSplicePath(p)`: under a `Splice` folder (`/Splice/`, `\Splice\`, or `Splice - account/`), on any OS.
- `sampleSearchKey(fileName)`: the file name without its extension and without the ` [YYYY-MM-DD HHMMSS]` suffix that Live's Consolidate adds.

Also exported: `windowsPathFromData(hex)` and `decodeXmlEntities(s)`.

## Replaces

| Repo | File | What | Replaced by |
|---|---|---|---|
| candybar-manager | `lib/alsParser.mjs` | the whole file: `decompressAls`, `PATH_RE`, `extractAllPaths`, `SPLICE_PATH_RE`, `findMissingSpliceSamples` | `findMissingSamples` (+ `isSplicePath`, `sampleSearchKey`) |
| candybar-manager | `scripts/debug-als-paths.mjs` | gunzip + the same regex, printing paths | `readAbletonXmlSync` + `listFileRefs` + `isSplicePath`, or delete it |
| candybar-manager | `src/lib/spliceRecovery.ts` | `AlsParserModule` (L73–75), the lazy `import(spliceLibUrl('alsParser.mjs'))` in `getAlsParser` (L87, L91–94), `scan()` (L202–206) | a static `import { findMissingSamples }` |
| candybar-manager | `splice-recover.mjs` | `import { findMissingSpliceSamples } from './lib/alsParser.mjs'` (L23, used L42) | `import { findMissingSamples } from '@btkulka/ableton-als'` |
| ableton-extensions-store | `server/src/scanner.js` | the `.adg`/`.adv` branch of `scanFile` (L109–117): gunzip, then sniff `<?xml`/`<Ableton` in the first 4 KB | `decodeAbletonXml` + `readAbletonHeader` |
| ableton-extensions-store | `server/src/licensing.js` | the `.adg`/`.adv` branch of `stampArtifact` (L110–120): gunzip, insert a comment, gzip | `encodeAbletonXml(insertXmlComment(decodeAbletonXml(src), …))` |

Checked and not copies:
- toejam: all nine files that mention Ableton (`toejam/params.py`, `build.py`, `tdnotes.py`, `bus/__init__.py`, `bus/beat.py`, `pieces/ophanim/piece.py`, `app/src/live.js`, `app/src/ui.js`, `app/demo/data.js`) are about Ableton **Link** tempo sync through TouchDesigner's `abletonlinkCHOP`, and the Python stays Python anyway. None reads a set.
- ableton-extensions-store: `server/test/harness.js` and `test/unit/scanner.test.js` gzip XML fixtures (they can keep `zlib` or use `encodeAbletonXml`); `loader/src/install.js` (routes installs into the User Library, sniffs `.amxd` headers); `cli/src/alx.js` (User Library and `Log.txt` paths).
- candybar-manager: `lib/abletonLibrary.mjs` (finds the User Library from `Library.cfg`) and `lib/xmlUtils.mjs` (Rekordbox XML).

## Migrating

### candybar-manager

1. Add the dependency. Electron main (CommonJS through electron-vite, deps externalized) loads `dist/cjs`; the root `.mjs` scripts load `dist/esm`.
2. `src/lib/spliceRecovery.ts`: delete `AlsParserModule`, `alsParserMod` and `getAlsParser()`. Then:
   ```ts
   import { findMissingSamples } from '@btkulka/ableton-als';
   export async function scan(alsPath: string): Promise<SpliceScanResult> {
     if (!fs.existsSync(alsPath)) throw new Error(`File not found: ${alsPath}`);
     return findMissingSamples(alsPath);
   }
   ```
   `SpliceScanResult` / `SpliceMissingSample` stay structurally compatible: same `alsPath`, `totalRefs`, `spliceRefs`, `missing[].originalPath/basename/searchKey`, plus `unresolved`, `relativePath` and `isSplice`, which you can adopt or ignore.
3. `splice-recover.mjs`: import `findMissingSamples` from the package and call it where `findMissingSpliceSamples` was called.
4. Delete `lib/alsParser.mjs`. Rewrite `scripts/debug-als-paths.mjs` on `listFileRefs`, or delete it.

Behaviour changes (all intended, measured on Ben's sets):
- Only samples count. Presets, Max devices, Core Library device folders, grooves, plugin DLLs and "original source" records are no longer "missing", so far fewer pointless Splice searches.
- Paths are entity-decoded. Present files with `&` in their path stop being reported. `remapToLocalSpliceRoot` now builds `Drum & Bass/…`, not `Drum &amp; Bass/…`.
- Paths with apostrophes are found. These are mostly Splice packs, so expect more real missing samples than before.
- A moved project's samples count as present when they exist under its folder (`Samples/Imported/…`). Samples that are still missing keep the old absolute path in `originalPath`, as before; `relativePath` is there if you'd rather restore into the project.
- Live 9/10 sets now return their samples (Windows paths decoded from `<Data>`); before they returned none. Their `originalPath` uses backslashes.
- `totalRefs` counts distinct samples, not distinct `<Path>` strings, so it is lower.
- `searchKey` and the Splice test are unchanged; `isSplicePath` uses `alsParser.mjs`'s wider regex (admits `Splice - account`), not the debug script's narrower one.

### ableton-extensions-store

**Check deployment before migrating.** The server ships as a Docker image on Fly. The `Dockerfile` copies only this repo and runs `npm ci`, so a `file:../packages/ableton-als` dependency can't resolve inside the build. The options are:

- build with a context that includes `D:\source\packages` (Dockerfile and `fly.toml` changes);
- vendor a packed tarball (`npm pack`) into the repo;
- leave these ten lines on `zlib` and adopt the package only where nothing deploys.

Ask Ben which.

If it goes ahead (ESM server):

```js
import { decodeAbletonXml, encodeAbletonXml, insertXmlComment, readAbletonHeader } from '@btkulka/ableton-als';

// scanner.js, .adg/.adv branch
let xml;
try {
  xml = decodeAbletonXml(fs.readFileSync(filePath));
} catch {
  return { status: 'failed', findings: [{ severity: 'fatal', message: 'Not a valid .adg/.adv (corrupt gzip)', where: fileName }] };
}
if (!readAbletonHeader(xml)) {
  findings.push({ severity: 'medium', message: 'Does not look like an Ableton preset (unexpected content)', where: fileName });
}

// licensing.js, .adg/.adv branch
try {
  out = encodeAbletonXml(insertXmlComment(decodeAbletonXml(src), `ALX license ${key} · buyer #${user.id}`));
} catch {
  return null; // not valid gzip: leave the original untouched
}
```

Watch for:
- The content check is stricter. Before, anything with `<?xml` in its first 4 KB passed; now the root element must be `<Ableton>`. The existing scanner tests still pass (the clean fixture's root is `<Ableton>`; the corrupt one fails at decode).
- The scanner now decodes the whole file into a string (it already gunzipped all of it before); fine for presets.
- The watermark output is byte-for-byte the same (`<!-- ALX license … · buyer #N -->` after the declaration, default gzip settings). `--` in the text is now made safe; license keys never contain it.

## Develop

`npm run build`, `npm run typecheck`, `npm test` (builds, then runs `dist/esm/**/*.test.js` on `node:test`). The tests build small gzipped Live 12 and Live 10 fixtures in temp dirs; they don't need real sets.
