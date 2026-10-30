# @btkulka/scaffold

How a new app of Ben's starts. Benhäus's New app screen runs it: Ben says what he wants, Claude plans it and asks the two or three things it can't decide, and the folder appears in `D:\source` with its first files, a placeholder icon, a Benhäus entry and a Claude Code session already briefed. This package is the part that isn't Benhäus: the plan, the questions, the files for each kind of project, the icon, the hand-off brief, and the writing. `btkulka-scaffold` runs the same from a terminal, without Claude.

Every project it writes builds on the shared packages in BPM wherever one fits, and its brief says to keep doing so: look in BPM before writing infrastructure, and make a new package when something is clearly reusable.

Node only. ESM and CommonJS builds. No runtime dependencies.

```json
"dependencies": { "@btkulka/scaffold": "file:../packages/scaffold" }
```

Build it first (`npm run build` here); apps load `dist/`.

## What it makes

| Kind | Files | Starts from |
|---|---|---|
| `electron` | electron-vite + React, main/preload/renderer, `scripts/run.mjs` | electron-kit (window state, loading, IPC, links, crashes), proc-kit (a clean Electron environment) |
| `web` | Vite + React on a fixed port | — |
| `service` | a Node HTTP server with `/health` | proc-kit (probe the port, free a dead copy) |
| `cli` | a `bin` with `parseArgs` | proc-kit |
| `mcp` | a stdio MCP server with one tool | mcp-kit (`createToolServer`, `serveStdio`, `runMain`) |
| `bot` | a discord.js bot with `.env` | proc-kit |
| `package` | the dual ESM+CJS layout the packages home uses, with a test | — |

Every project also gets `CLAUDE.md` (the brief: what Ben asked for, what he answered, the BPM rules, the icon, the first steps), `README.md`, `.gitignore` and `icon.svg` (a monogram on the Benhäus app-icon plate, tinted for its vertical). Other packages the description calls for (sqlite-store, llm-kit, media-kit, the API clients…) are linked in `package.json` too, as `file:` paths.

## API

```ts
import {
  // the plan
  planPrompt, PLAN_SCHEMA, normalizePlan, fallbackPlan,
  slugify, uniqueSlug, nameFromDescription, firstSentence, findVertical, verticalFromWords, packagesFor, defaultFirstSteps, DEFAULT_VERTICALS,
  // what exists
  KINDS, kindOf, kindFromWords, readCatalogue, suggestPackages, findPackage, shortName,
  // the files
  renderProject, packageDeps, packageNames, linkSpec, appIconSvg, monogram, ICON_TINTS, handoffPrompt,
  // the disk
  writeProject, initGit, isTaken,
} from "@btkulka/scaffold";
```

### The plan

- **`planPrompt(req, ctx)`** is the prompt that asks Claude for a plan, and **`PLAN_SCHEMA`** the JSON schema it answers in (the Agent SDK's `outputFormat`, or `claude -p --json-schema`). `req` is `{ description, answers?, name? }`; `ctx` is `{ catalogue, verticals, taken, defaultVertical? }`: the BPM packages (`{ name, dir, description }`), Ben's verticals (`{ id, name, line? }`), folder names already taken, and where a plan lands when nothing says otherwise.
- **`normalizePlan(raw, req, ctx)`** turns whatever came back into an `AppPlan` that's safe to build from: a real kind, one of the verticals, a free slug, only packages that exist (plus the kind's own), and only the questions not yet answered, with `ANYTHING_ELSE` ("Anything else?", `freeform: true`: a multiline note, optional; id `else`, then `else-2`…) appended to every round that asks. `ready` is true when there are none. `isNote(answer)` picks those answers out; the prompt tells Claude to fold them into the plan, and `fallbackPlan` takes them, a line each, as the vision.
- **`fallbackPlan(req, ctx, why?)`** does the same without Claude: the kind, vertical and name from the description's words, else fixed questions (`kind`, `vertical`, `name`), the packages from the kind and the description.
- An `AppPlan` is `{ name, slug, kind, vertical, summary, description, answers, packages, newPackage?, questions, ready, firstSteps, note? }`. A question is `{ id, text, options, other?, freeform? }`; an answer `{ id?, question, answer }`.

### The files

- **`renderProject(plan, { dir, packagesHome, catalogue, date? })`** returns `{ path, contents }[]` for the kind. Package links are `file:` paths relative to `dir`.
- **`handoffPrompt(plan, { dir, packagesHome, catalogue, packagesBuilt? })`** is the first message for the Claude Code session in the new folder.
- **`appIconSvg({ name, title?, vertical?, glyph? })`** is the placeholder icon; `ICON_TINTS` has each vertical's highlight, face and shade.
- **`writeProject(dir, files, { overwrite? })`** writes them (refusing a folder with files in it), **`initGit(dir, message?)`** makes the first commit (false when git isn't there), **`isTaken(dir)`** says whether a folder has anything in it.

## The command

```sh
btkulka-scaffold "a set list planner for NHI shows" --kind electron --vertical nhi --name "Set List"
btkulka-scaffold "an MCP server over my ComfyUI queue" --dry-run      # lists the files; asks for what's missing
```

Flags: `--kind`, `--name`, `--vertical`, `--dir` (default `D:/source`), `--packages-home` (default `<dir>/packages`), `--packages a,b`, `--no-git`, `--dry-run`, `--prompt` (print the hand-off), `--json` (print the plan). It never asks interactively: what it can't tell, it lists and exits 2.

## Working on it

`npm run build` here (or in the packages home), `npm test` runs the tests in `src/*.test.ts`. Source imports use `.js` extensions; no `import.meta` or top-level `await` (the CommonJS build needs neither). The templates are plain strings in `src/files.ts`; the versions they pin are at the top of that file.
