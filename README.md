# Packages

The home for Ben's shared packages: code more than one app uses, kept in one place instead of copied between repos. Benhäus lists everything here in BPM (Benhäus Package Manager), with who depends on each package; Claude sees the same through the `benhaus` MCP server (`list_packages`, and `search_code` to find code that should move here).

| Package | What it is | Used by |
|---|---|---|
| [`comfy-client`](comfy-client) (`@datrapscallion/comfy-client`) | ComfyUI client: queue, workflows, ControlNet conditioning, cutouts | orson, starfall |
| [`lora-train`](lora-train) | Image/style LoRA training engine | orson, nhi-album-art-gen |
| [`runpod-client`](runpod-client) (`@btkulka/runpod-client`) | Rent a GPU by the minute on RunPod: the REST API v2 (GPU catalog with prices; pods: create, logs, run a command, terminate) and a guarded rental (a plan and worst-case cost before spending, a budget, a hard deadline kept by a detached watchdog, a sweep for strays) and Benhäus credential adapter (`runpod/shared`); `btkulka-runpod` to look and clean up | trellis-client |
| [`trellis-client`](trellis-client) (`@btkulka/trellis-client`) | TRELLIS.2 image-to-3D through a dedicated ComfyUI: the weights, the server guarded for a small machine (one at a time, a free-memory floor, half the cores, low priority), one model from an image or a text prompt (ComfyUI's own template turned into an API prompt) to a vertex-painted GLB, and the GLB read into OBJ files split by colour for TouchDesigner, Blender or a game; `btkulka-trellis` from a terminal | notion-tome-adventures, (toejam, next) |
| [`meshy-client`](meshy-client) (`@btkulka/meshy-client`) | The Meshy 3D API: image to 3D (a local image sent as a data URI, polled with backoff, the GLB and texture maps downloaded), the balance, a credit table per model and texture, and Benhäus credential adapter (`meshy`); `meshy-3d` turns concept images or a jobs file into `<name>.glb` files with a `.meta.json` each and a `meshy-<stamp>.json` run record (plan and credits first, `--yes` to spend) | (toejam, next) |
| [`lore-core`](lore-core) (`@datrapscallion/lore-core`) | LanceDB knowledge store for game lore | orson |
| [`mcp-kit`](mcp-kit) | MCP server plumbing: results, stdio and HTTP serving, parent watchdog, stdio↔HTTP bridge; one SDK and zod for every app | (migrating) |
| [`sqlite-store`](sqlite-store) | SQLite open with pragmas, migrations, transactions, JSON and settings helpers, for better-sqlite3 or node:sqlite passed in by the app | (migrating) |
| [`image-library`](image-library) | A library of images on disk in one SQLite file: nested virtual collections, tags and picks, search (words, tags, model, dates), watched folders that file new images by themselves, gemini-image's prompt and cost sidecars, moving and renaming files with their sidecars, the Benhäus panel's carousel lines and pick messages; thumbnails through Electron's nativeImage; node:sqlite handed in | benhaus (the Gallery page), gallery (its MCP server) |
| [`data-sync`](data-sync) | An app's SQLite data on every machine without a server: look on the tailnet for the app already serving and pass this machine's port through to it, else pull the newest snapshot from the Syncthing folder and serve, pushing a snapshot after each change; both changed means backed up and held for Ben | (habit-tracker, next) |
| [`app-server`](app-server) | The one-process server Ben's web apps share: the API and the page on one port, Vite inside it in dev or `dist/` in production, a second `npm run dev` attaching to the running copy, a router with JSON helpers, a cross-site write guard, a file log, and listening on this machine and Tailscale only (phones come in through Benhäus's remote) | fridge-planner, habit-tracker |
| [`ui-kit`](ui-kit) | The controls Ben's web apps share, in React and themed by `--ui-*` CSS variables: buttons (busy, two-tap confirm), checks that draw themselves, switches, a segmented control with a sliding thumb, tiles, chips, tag input, a press-and-hold stepper, token-completing and growing fields, a date strip, sheets that follow a drag (focus kept, keyboard-aware), context menus by long press, right-click or the menu key, swipeable rows, lists that fold and re-sort smoothly, toasts with Undo, a tab bar with a gliding pill, a page header with a slim sticky bar, an icon picker; motion that settles and never bounces, Safari-safe | fridge-planner |
| [`remote-access`](remote-access) | Who may sign in to a remote and what each may do: the owner's key, guests with keys of their own and the tools they may use, cookie sessions kept as hashes, and the policy checks (calls, settings, events, ports, notices) | benhaus (Settings › People) |
| [`electron-kit`](electron-kit) | Electron main and preload scaffolding: typed IPC, single instance, window state, tray, window controls, safe external links, and a web host that serves the app as a web app (its page and IPC over HTTP, for a Benhäus tab) | (migrating) |
| [`proc-kit`](proc-kit) | Process and dev tooling: port owners, free a port, kill a tree, detached spawn, wait for port or HTTP, Electron env, PATH lookup | (migrating), media-kit, llm-kit |
| [`llm-kit`](llm-kit) | LLM transport: `claude` CLI runs, OpenAI-compatible and Ollama chat, JSON from model output | (migrating) |
| [`media-kit`](media-kit) | ffmpeg, ffprobe and yt-dlp: find, run with progress, probe, convert, loudness | (migrating) |
| [`elevenlabs-client`](elevenlabs-client) | ElevenLabs TTS, sound generation and voices, with retries | (migrating) |
| [`spotify-client`](spotify-client) | Spotify client-credentials API client; browser-safe | (migrating) |
| [`soundcloud-client`](soundcloud-client) | SoundCloud API client, OAuth and public | (migrating) |
| [`benhaus-client`](benhaus-client) | Call Benhäus from a local app: its Google sign-ins (Gmail search, threads, replies; calendar events, free/busy included) and notifications, found through `~/.benhaus/mcp.json` | honeycomber |
| [`http-kit`](http-kit) | The fetch plumbing under the API clients: timeouts, retries with Retry-After, a typed HttpError; browser-safe | notion-client, resend-client |
| [`notion-client`](notion-client) | Notion API client: the integration's workspace, search, pages, databases and rows, blocks as text, page writes, ids from notion.so addresses; browser-safe | benhaus (Settings › Accounts › Notion, `search_notion`, `read_notion`) |
| [`resend-client`](resend-client) | Resend API client: emails (Idempotency-Key, batches of 100), domains, global contacts with an upsert by email, segments and their members, broadcasts as drafts sent on call; merge tags, the unsubscribe link and a throttle; browser-safe | (nhi-dash, next) |
| [`gemini-client`](gemini-client) | Gemini API (Google AI Studio) client and Benhäus credential adapter: models, video with Gemini Omni Flash (start, wait, download the MP4; Veo left the Gemini API in Oct 2026), a per-second price table; browser-safe, plus the `gemini-video` CLI (prompt or jobs file to `<name>.mp4`, estimate first, `--yes` to spend) | (toejam, next) |
| [`ableton-als`](ableton-als) | Read Ableton Live sets: header, file references, missing samples | (migrating) |
| [`chat-blocks`](chat-blocks) (`@btkulka/chat-blocks`) | Embedded chat blocks: what Claude puts in a conversation for Ben to answer (pick images, one carousel or grouped and sent at once; choose; confirm; a form; AskUserQuestion), as one spec, one answer and one frame (`frame.css`). The answer is checked and said in words, and goes back to Claude as JSON that a transcript reads again. Apps serve their own block pages as MCP Apps `ui://` resources, with a bridge (`connect`, `answer`, `image`) and a page maker that inlines it | claude-kit (`await_feedback`), benhaus, (gallery, next) |
| [`claude-kit`](claude-kit) | Claude Code chats in any app, the way the Benhäus panel has them: standing Agent SDK sessions per chat (asks, modes, models, images, past chats, the app's own MCP server), over Electron IPC or HTTP, with a corner button, drawer, panel and chat page in React or a `<claude-widget>` element for pages without React | benhaus, orange-friction, nhi-dashboard |
| [`scaffold`](scaffold) | A new app of Ben's, planned, written and handed to Claude Code: the plan and its questions, the files per kind (Electron, web, service, CLI, MCP, bot, package), a placeholder icon, the brief; `btkulka-scaffold` from a terminal | benhaus (the New app screen) |

## Using a package from an app

```json
"dependencies": { "@datrapscallion/comfy-client": "file:../packages/comfy-client" }
```

Paths are relative to the app's folder, so an app one level deeper (like `nhi/nhi-album-art-gen`) uses `file:../../packages/<folder>`. npm links the folder; the app imports what the package builds into `dist/`.

## Working here

- `npm install` here installs every package's dependencies (npm workspaces: every folder with a package.json is one).
- `npm run build` builds them all; `npm run typecheck` checks them all. Build after changing a package: apps load its `dist/`, which isn't committed.
- A new package is a new folder: `package.json` (name `@btkulka/<name>`; comfy-client and lore-core predate this and keep `@datrapscallion`, `"type": "module"`, `exports` pointing into `dist/`, `build` and `typecheck` scripts), `tsconfig.json`, `src/`. It shows up in BPM on its own.
- New packages build both ESM and CommonJS, because several apps (clipdrift, candybar-manager, nhi-dashboard) are CommonJS. See "Dual build" below.
- A linked package resolves its own dependencies from `packages/node_modules`, never from the app. So anything native or app-chosen (`better-sqlite3`, `electron`, `ffmpeg-static`, `sharp`) is passed in by the app, or is an optional peer the package never imports itself.
- Run `npm install` here one at a time: take the lock with `mkdir .npm-lock` (retry until it succeeds), install, then remove `.npm-lock`.

## Dual build

`package.json`:

```json
"type": "module",
"main": "./dist/cjs/index.js",
"types": "./dist/esm/index.d.ts",
"exports": {
  ".": {
    "types": "./dist/esm/index.d.ts",
    "import": "./dist/esm/index.js",
    "require": "./dist/cjs/index.js"
  }
},
"files": ["dist"],
"scripts": {
  "build": "tsc -p tsconfig.json && tsc -p tsconfig.cjs.json && node ../scripts/cjs-marker.mjs",
  "typecheck": "tsc -p tsconfig.json --noEmit",
  "test": "npm run build && node --test \"dist/esm/**/*.test.js\""
}
```

`tsconfig.json` is the ESM build (`module`/`moduleResolution` `NodeNext`, `outDir` `dist/esm`, `rootDir` `src`, `strict`, `declaration`, `declarationMap`, `sourceMap`, `lib` `["ES2022"]`, `types` `["node"]`). `tsconfig.cjs.json` extends it with `module` `CommonJS`, `moduleResolution` `Node10`, `outDir` `dist/cjs`, no declarations, and excludes `src/**/*.test.ts`. `scripts/cjs-marker.mjs` writes `dist/cjs/package.json` so Node reads that folder as CommonJS.

Source imports use `.js` extensions (`./thing.js`). Don't use `import.meta` or top-level `await`: neither compiles to CommonJS. Tests are `src/**/*.test.ts` on `node:test`.
- When code moves into a package, delete the copies it replaces in the same change, so there's one version.
- Keep packages free of app-specific paths, settings and secrets: the app passes them in.
