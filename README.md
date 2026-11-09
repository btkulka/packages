# Packages

The home for Ben's shared packages: code more than one app uses, kept in one place instead of copied between repos. Benhäus lists everything here in BPM (Benhäus Package Manager), with who depends on each package; Claude sees the same through the `benhaus` MCP server (`list_packages`, and `search_code` to find code that should move here).

| Package | What it is | Used by |
|---|---|---|
| [`comfy-client`](comfy-client) (`@datrapscallion/comfy-client`) | ComfyUI client: queue, workflows, ControlNet conditioning, cutouts | orson, starfall |
| [`lora-train`](lora-train) | Image/style LoRA training engine | orson, nhi-album-art-gen |
| [`lore-core`](lore-core) (`@datrapscallion/lore-core`) | LanceDB knowledge store for game lore | orson |
| [`mcp-kit`](mcp-kit) | MCP server plumbing: results, stdio and HTTP serving, parent watchdog, stdio↔HTTP bridge; one SDK and zod for every app | (migrating) |
| [`sqlite-store`](sqlite-store) | SQLite open with pragmas, migrations, transactions, JSON and settings helpers, for better-sqlite3 or node:sqlite passed in by the app | (migrating) |
| [`data-sync`](data-sync) | An app's SQLite data on every machine without a server: look on the tailnet for the app already serving and pass this machine's port through to it, else pull the newest snapshot from the Syncthing folder and serve, pushing a snapshot after each change; both changed means backed up and held for Ben | (habit-tracker, next) |
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
