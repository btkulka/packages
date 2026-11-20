# @btkulka/claude-kit

Claude Code chats in any of Ben's apps, the way the Benhäus panel has them. Each chat is a standing Claude Code session (Agent SDK) with Ben's own sign-in, settings, CLAUDE.md files, skills and MCP servers, plus the app's own MCP server, so the chat can act on the app. You get:

- **asks**: Allow, Always allow or Deny, before edits and commands
- **modes and models**
- **images** pasted, dropped, returned by tools or shown in replies, with a lightbox
- **carousels to pick from**: two or more images in a row in a reply
- **blocks**: Claude asks with `await_feedback` (pick images, one carousel or grouped; choose; confirm; a form; an app's own page) or AskUserQuestion, and waits for the answer ([chat-blocks](../chat-blocks))
- **several chats** as chips
- **Past chats**: picks up any conversation Claude Code kept, the app's own or a terminal's
- **Continue in terminal**
- **conversations read back** from the transcripts after a restart

It was lifted out of Benhäus (`src/main/claude.ts`, `shell/ClaudePanel.tsx`), and Benhäus runs on it too.

| Import | Runs in | What's in it |
|---|---|---|
| `@btkulka/claude-kit` | anywhere | Types, the change protocol (`applyChat`, `applyChats`, `applyStream`, `diffItems`), `MODES`, `chatWord`, `chatsWord`, `modelName`. |
| `@btkulka/claude-kit/host` | Node | `ChatHost`: the chats and their sessions. Also `ImageStore` and `transcriptTail`. |
| `@btkulka/claude-kit/electron/main` | Electron main | `attachIpc(host, …)` puts the host on IPC. `nativeImageTools(nativeImage)` gives thumbnails and downscaling. |
| `@btkulka/claude-kit/electron/preload` | preload | `claudeBridge(ipcRenderer)`: the IPC as a `ClaudeTransport`, to expose to the page. |
| `@btkulka/claude-kit/http` | Node server | `httpHandler(host)`: RPC, Server-Sent Events, images, and the element's files under `/claude`. |
| `@btkulka/claude-kit/client` | browser | `httpTransport("/claude")` and `createClaudeStore(transport)`. |
| `@btkulka/claude-kit/react` | browser, React 18+ | `ClaudeProvider` and `ClaudeWidget` (corner button + drawer), or the separate pieces: `ClaudeFab`, `ClaudeDrawer`, `ClaudePanel`, `ClaudeChat`, `ChatView`, `askClaude()`. |
| `@btkulka/claude-kit/styles.css` | browser | The look (Benhäus's night theme, a light one under `prefers-color-scheme`), all `--ck-*` variables. |
| `@btkulka/claude-kit/element` | browser, no React needed | `<claude-widget>`: the widget with React bundled inside, in a shadow root. `httpHandler` serves it at `/claude/element.js`. |

**The Agent SDK is the app's.** `@anthropic-ai/claude-agent-sdk` carries a ~280 MB Claude Code binary per platform, so this package never installs it. Instead the app adds it (`npm i @anthropic-ai/claude-agent-sdk`) and passes it in: `sdk: () => import("@anthropic-ai/claude-agent-sdk")`.

## The host

```ts
import { ChatHost } from "@btkulka/claude-kit/host";

const host = new ChatHost({
  sdk: () => import("@anthropic-ai/claude-agent-sdk"),
  dataDir: join(app.getPath("userData")),          // claude-chats.json and chat-images/ go here
  app: "orange-friction/0.1.0",                    // Claude Code's client id
  folder: "D:/source/orange-friction",             // where new chats work: usually the app's repo
  systemPrompt: "You're the Claude drawer in Orange Friction, Ben's hub for … Its MCP tools (orange-friction) read and change what's on screen.",
  mcpServers: { "orange-friction": { type: "http", url: "http://127.0.0.1:4410/mcp" } },
});
```

Options worth knowing:

- **`mode`, `model`** set new chats' defaults: a value, or a function read each time. Leave them out and new chats take whatever was last picked in a chat, saved with the chats. The mode then starts at `"default"`, which asks before edits and commands.
- **`mcpServers`** go beside Ben's own servers, which come in through his settings. They can be stdio (`{ command, args }`), HTTP (`{ type: "http", url }`), or an in-process SDK server from the Agent SDK's `createSdkMcpServer`.
- **`queryOptions(chat)`** passes anything else to `query()`: `allowedTools`, `settingSources`, `hooks`.
- **`pastChats`**: `"folder"` (the default) lists only the app folder's conversations, `"all"` lists every one on the machine.
- **`imageTools`** scales images for thumbnails and for sends over Claude's limit. Without it, thumbnails are the whole image and an oversize send is refused.
- **`notify(notice, chat, count)`**: an ask, or a finished reply, while nobody's looking. Undefined means clear that chat's notices.
- **`openTerminal(folder, command)`**: Continue in terminal. The default opens PowerShell on Windows and Terminal on a Mac.
- **`held()`**: chats open elsewhere, like a tab of their own, so a blank one isn't dropped as spare.
- **Limits, for chats other people use** (a guest on a phone, through Benhäus). The host enforces each one whatever a screen sends, and the screens offer only what's allowed (`ChatsState.limits`):
  - `modes: ["acceptEdits", "plan", "default"]` sets which modes a chat may be in. Another is refused, and a chat saved in one starts in the first. Bypass is only possible when it's listed (`allowDangerouslySkipPermissions` follows).
  - `pastChats: "none"` turns off Past chats: none listed, none picked up.
  - `terminal: false` turns off Continue in terminal.
  - `lockFolder: true` keeps every chat in `folder`: a screen can't start one anywhere else.
  - `verbosity: "conversational"` shows only what's said, both ways, and error notes: no tool rows. While Claude works, one plain line says what it's doing ("Making the change…", "Checking it works…"). The default `"full"` shows every tool row with its output.
  - `intro` replaces the empty chat's line ("with your skills, CLAUDE.md files and MCP servers"), which isn't true of a host that leaves them out.

  None of this keeps out Ben's settings and MCP servers. For that, pass `queryOptions: () => ({ settingSources: ["project"], extraArgs: { "strict-mcp-config": null } })`, and add PreToolUse `hooks` for which commands and paths are allowed.
- **`contextTag`** (`"app-context"`), **`person`** (`"The user"`), **`folderHint`**, **`file`**, **`legacyFile`**, **`env`**, **`unseenMs`**, **`idleMs`**.

Methods match what the screens call: `state`, `start`, `seen`, `send`, `stop`, `newChat`, `select`, `close`, `answer`, `terminal`, `configure`, `past`, `load`, `image`. There are also `on(listener)`, plus `letIdleGo(all)`, `defaultsChanged(patch)`, `restartStopped()`, `dropSessions()`, `end()` and `dispose()`. Call `host.end()` when the app quits.

`host.newChat({ text, context, about, title, folder, model })` is the app's own "Ask Claude about this". `context` goes to Claude ahead of the first message without being shown, and `about` names what the chat is about.

## Electron

```ts
// main
import { attachIpc, nativeImageTools } from "@btkulka/claude-kit/electron/main";
const host = new ChatHost({ …, imageTools: nativeImageTools(nativeImage) });
attachIpc(host, { ipcMain, BrowserWindow, dialog, app });   // dialog + app: Download uses a Save dialog
app.on("before-quit", () => host.end());

// preload
import { claudeBridge } from "@btkulka/claude-kit/electron/preload";
contextBridge.exposeInMainWorld("claude", claudeBridge(ipcRenderer, { saveDialog: true }));

// renderer
import { ClaudeProvider, ClaudeWidget } from "@btkulka/claude-kit/react";
import "@btkulka/claude-kit/styles.css";
<ClaudeProvider transport={window.claude}><App /><ClaudeWidget hotkey="ctrl+shift+k" /></ClaudeProvider>
```

The renderer's type for `window.claude` is `ClaudeTransport` (from the root). Electron's own `ipcMain`, `ipcRenderer`, `BrowserWindow`, `dialog`, `app` and `nativeImage` fit without casts; `src/electron/electron-compat.test.ts` checks that against Electron 41.

**electron-kit's web host** (the app in a Benhäus tab or a browser) carries IPC as JSON over HTTP. The kit takes JSON's quirks in stride: a left-out argument that arrives as `null` counts as left out, and image bytes that arrive as `{type: "Buffer", data}` are read back as bytes. Wire three things:

- Register through the recorded `ipcMain`, so the host can dispatch a page's calls: `attachIpc(host, { ipcMain: recordIpc(ipcMain), … })`. electron-kit's `RecordingIpcMain` has no `removeHandler` yet, so either wrap it with a no-op one or don't call attachIpc's undo.
- Send events through electron-kit's `broadcast`, which also reaches the pages it serves: `send: (channel, payload) => broadcast(BrowserWindow, channel, payload)`.
- Only offer the Save dialog in the real window: `claudeBridge(ipcRenderer, { saveDialog: process.versions.electron !== "web" })`.

**The page's CSP** has to allow `img-src blob:`, because thumbnails and the lightbox draw from object URLs. A dark-only app sets `data-ck-theme="dark"` on `<html>`, so the drawer doesn't turn light when Windows is in light mode.

**Bundling.** List the package in `devDependencies`, or add it to `externalizeDepsPlugin({ exclude: [...] })`, so electron-vite bundles it. A sandboxed preload can only `require("electron")`, so it has to bundle it. The main process must not bundle the Agent SDK: keep `@anthropic-ai/claude-agent-sdk` in `dependencies`, where electron-vite leaves it external.

## A server app (express)

```js
const { ChatHost } = require("@btkulka/claude-kit/host");
const { httpHandler } = require("@btkulka/claude-kit/http");
const host = new ChatHost({ sdk: () => import("@anthropic-ai/claude-agent-sdk"), dataDir, app: "nhi-dash/1.0.0", folder: __dirname, mcpServers: { … } });
app.use(httpHandler(host));          // everything under /claude
```

Then add this to the page layout:

```html
<script type="module" src="/claude/element.js"></script>
<claude-widget hotkey="ctrl+shift+k"></claude-widget>
```

The element takes these attributes: `base` (`/claude`), `variant` (`drawer` or `float`), `hotkey`, `title`, `theme` (`light` or `dark`; leave it out to follow the system's), and `width`. Any `--ck-*` variable the page sets on the element reaches the widget inside its shadow root, in a media query too. For example, `claude-widget { --ck-accent: #d4704a; }`, and `--ck-fab-bottom` / `--ck-fab-right` to lift the corner button above a tab bar, or `--ck-fab-display: none` to hide it (the app then opens the chat itself with `open()`). Inline on the element (its `style`), a change takes effect at once. Its methods are `open(options?)`, `close()` and `toggle()`. From any script, `window.dispatchEvent(new CustomEvent("claude-kit:open", { detail: { text, context, about } }))` opens it on a new chat.

**Who can reach it.** A chat runs Claude Code on this machine, so the handler only answers connections from this machine. The socket has to come from a loopback address, which matters for a server that also listens on its Tailscale address: a tunnel from another machine keeps `Host: localhost`. The `Host` header has to be localhost, 127.0.0.1 or ::1, which stops DNS rebinding. Pages from another origin (by `Origin` and `Sec-Fetch-Site`) and RPC that isn't JSON are turned away. To open it up on purpose, pass `allowRemote: true` with `allowHosts: ["zagreus.tailnet.ts.net"]`.

For React on the server-app side, use `httpTransport("/claude")` as the transport.

## React

```tsx
<ClaudeProvider transport={t} ui={{ openPath: (file, line) => …, emptyNote: "It stays up while the app runs." }}>
```

`ui` takes these overrides, all optional:

- `components`: the app's own `Button`, `Tooltip`, `Menu`, `SegmentedControl` and `SearchField`, with the built-ins' props
- `toast`, `openLink`, `openPath` (paths in replies become buttons), `openFolder` (Ctrl+click, Cmd+click or a middle click on a path shows it where files live; given this, bare `D:\…` paths in a reply are buttons too), `copy`

Files go with a message as images do: dropped, pasted or picked (the paperclip takes any kind). Images go to Claude as pictures; other files are listed on the message by path, and Claude reads them with its tools (PDFs, documents, code, folders). In Electron, pass `pathFor: (f) => webUtils.getPathForFile(f)` to `claudeBridge` so a dropped file goes by its path; in a browser (the phone) the bytes are uploaded and the host keeps them under `dataDir/chat-files` (50 MB each at most). `send(text, chat, images, files)` takes `{ path }` or `{ data, name, type }`.
- `phone`: a touch screen
- `signIn`: the chat offers Sign in when Claude Code is signed out
- `setMode` and `setModel`: route a pick somewhere else, like the app's settings
- `menu(items, chat, where)` and `onMenu`: add to or change the ⋯ menu
- `headerActions`
- `showPath`, `relTime`, `errorText`, `title`, `emptyNote`, `machine`
- `portal`

**Images in a reply.** `![what it is](a path or an https address)` on a line of its own draws the image. Two or more image lines in a row (blank lines between them allowed) draw as one carousel instead: cards in a strip that scrolls sideways, each with its alt text, its place ("2 of 4") and **Pick**. A card opens the lightbox on that set alone, which has Pick too (Enter presses it). Picking sends an ordinary message from the person, `Picked 2 of 4: what it is (D:\renders\b.png)` (`pickText`), and the card shows as picked. That comes from the conversation, the latest message starting "Picked" that names one of its images (`picksIn`), so it holds through a redraw and a restart. Tell Claude in `systemPrompt` that several images in a row are a carousel and that the pick comes back that way.

Keep `ui` stable with `useMemo` or a module constant. Pass `store` to keep the chats in the app's own store; it needs `getState`, `subscribe` and `setPast`.

Vite apps link the package's `dist/`, which resolves `react` from `D:\source\packages\node_modules`. **Add `resolve: { dedupe: ["react", "react-dom"] }`** to the renderer's Vite config so there's one React.

**Blocks.** With an SDK that hosts in-process tools (`createSdkMcpServer`), each session gets `mcp__blocks__await_feedback` (allowed without asking) and AskUserQuestion is let through. Turn both off with `blocks: false`. The tool takes a [chat-blocks](../chat-blocks) spec (`kind`, `title`, `body`, `props`, `app`, `timeoutS`), checks it (a bad one goes back to Claude to fix), and holds the call until the person answers. The block is drawn on the call's own row: the CLI passes each call's tool-use id in the request's `_meta`. The answer comes from `reply(id, { value } | { text })` on any transport. A text-only message sent while a block waits answers it too, and doesn't appear as a message of its own. A message with images or files ends the block instead, as do Stop, the session going, the call being cancelled, or `timeoutS`. AskUserQuestion goes through `canUseTool`, which Claude Code calls for it even in bypass mode, and its answers go back as `updatedInput.answers`. Waiting blocks are `ChatState.blocks`. A tool row that is a block carries it (`ChatItem.block`) and reads its outcome back from the result, so a transcript shows every block answered or expired. The host adds a line to the system prompt (`blocksNote`, false to leave it out). An app page (a `ui://` kind with `app`) is read through the session with `appPage(chat, app, uri)` and drawn in a sandboxed iframe. Its `file()` reads through `file(chat, block, ref)` (the host's `blockFile`; over HTTP `GET /file?chat=…&block=…&ref=…`): only for an app block in that chat, waiting or on its row, and only a path its props name or a file in that path's folder or below it (a model's textures, a set's parts), up to 512 MB. The bytes reach the page handed over, not copied. A page that asks for fullscreen (`ui/request-display-mode`) goes over the whole window: its iframe sits in a `<dialog>` shown in place, shown modally instead (the top layer, clear of the panel's transforms), so nothing reloads; Esc or Back to the chat brings it back.

The screens draw blocks with `BlockFrame` and a component per kind. Built in: `pick` (on `CarouselView`, the carousel without the markdown's message), `choice`, `confirm`, `form` and `questions`. Add your own with `registerBlock(kind, Component)`, which gets `{ block, live, answer }`. The frame's look is chat-blocks' `frame.css`, which `styles.css` carries.

**Theming.** Set any `--ck-*` variable on `.ck-root` (or deeper). The defaults are wrapped in `:where()`, so any rule wins. The main ones: `--ck-ink`, `--ck-ink-2`, `--ck-ink-3`, `--ck-surface`, `--ck-surface-2`, `--ck-surface-3`, `--ck-stroke`, `--ck-stroke-strong`, `--ck-selected`, `--ck-picked` (a carousel pick's outline and check), `--ck-accent`, `--ck-accent-ink`, `--ck-live`, `--ck-alert`, `--ck-font`, `--ck-mono`, `--ck-z`.

## Working on it

`npm run build` runs tsc for both builds, then `scripts/assets.mjs`, which copies the CSS and bundles the element with esbuild. `npm test` runs the patch tests, the carousel's rules (`src/react/picks.test.ts`), plus host, block and HTTP tests on a fake Agent SDK. `npm run typecheck` also checks the element.
