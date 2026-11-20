# @btkulka/chat-blocks

Embedded chat blocks are things Claude puts in a conversation for the person to answer, and waits on: pick an image (one carousel, or a group of carousels picked one at a time and sent together), choose, confirm, fill in a few fields, Claude Code's AskUserQuestion, or a page an app draws itself. Every block has the same parts:

- **a spec**: the `kind`, plus `title`, `body` and `props`
- **an answer**: a `value`, or words typed instead, plus `said`, the answer in words
- **a frame**: title, body, actions, then the answer said back. Its states are waiting, answered and expired.

A block is a tool call. In a [claude-kit](../claude-kit) chat, Claude calls `await_feedback({ kind, title, props })`, the chat draws the block on that call's row, and the call returns the answer as JSON. The transcript keeps the call and its result, so a conversation read back after a restart shows every block as it was answered.

| Import | Runs in | What's in it |
|---|---|---|
| `@btkulka/chat-blocks` | anywhere | The block types; `checkSpec` and `checkProps` (a spec from Claude, tidied, or what's wrong in words Claude can fix); `answerFor` (an answer checked against its block, with `said`); `outcomeOf`, `outcomeText`, `readOutcome` and `settled` (the JSON Claude gets back, and reading it onto the block again); `pickWords`. Also the MCP Apps protocol constants and the policy helpers (`M`, `MCP_APP_MIME`, `withPolicy`, `styleVariables`). |
| `@btkulka/chat-blocks/bridge` | an app's block page | `connect()`: the page side of an app block. |
| `@btkulka/chat-blocks/swipe` | browser | `swipe(el, { onSwipe, ignore?, enabled?, follow?, distance?, wheel? })`: a lightbox's ← and → by a finger, a mouse drag or a trackpad's sideways swipe (pointer events). The bridge carries it too, as `ChatBlocks.swipe` in a `blockPage`. |
| `@btkulka/chat-blocks/page` | anywhere (an MCP server) | `blockPage({ body, script, style })`: a self-contained page with the look and the bridge inlined. `blockResource(uri, html, csp?)`: the resources/read answer for it. |
| `@btkulka/chat-blocks/frame.css` | browser | The frame and its controls (`.cb-frame`, `.cb-btn`, `.cb-options`, `.cb-option`, `.cb-field`, `.cb-said`), drawn with claude-kit's `--ck-*` variables. claude-kit's `styles.css` carries it. |
| `@btkulka/chat-blocks/page.css` | an app's block page | `--ck-*` defaults for a page, from the MCP Apps standard variables where the host sets them. |

ESM and CommonJS. No dependencies.

## Kinds

| kind | props | value |
|---|---|---|
| `pick` | `images: [{ ref, alt?, name? }]` (a path, an http(s) or data: address, or a kept image's id; strings work too), `multi?` | `{ index, ref, alt }`, or a list with `multi` |
| `pick`, grouped | `groups: [{ label, images, multi? }]` (up to 20 groups of 24) | one entry per group, in order: `{ group, index, ref, alt }`, `{ group, picks: [...] }` for a multi group, or `{ group, skipped: true }` |
| `choice` | `options: [{ label, description? }]` (strings work too), `multi?` | the label, or a list with `multi` |
| `confirm` | `yes?`, `no?`, `danger?` | `true` or `false` |
| `form` | `fields: [{ name, label?, type?: text, textarea, number, select or checkbox, options? (select), required?, placeholder?, value? }]`, `submit?` | the values by name (numbers as numbers, checkboxes as booleans) |
| `questions` | `questions: [{ question, header?, options, multiSelect? }]` (AskUserQuestion's input) | the answers by question (a multi answer comma-joined, as Claude Code takes them) |
| a `ui://` address, with `app` | whatever the app's page takes | whatever the page sends |

Words typed in the chat's box answer any block: `{ text, said: 'Answered in words instead: "…"' }`. A pick says itself the way the markdown carousel always has, `Picked 2 of 4: the misty harbor (D:\renders\harbor.png)`. A grouped pick says one line per group, with skipped groups saying "skipped".

What Claude gets back, as JSON text: `{ "answered": true, "value": …, "said": "…" }` (with `text` instead of `value` when the answer was typed), or `{ "expired": true, "reason": "Ben stopped this turn." }`.

## App blocks

An app's own block is a page its MCP server serves as an [MCP Apps](https://github.com/modelcontextprotocol/ext-apps) (SEP-1865) `ui://` resource. The app needs no web server of its own, so an Electron app whose MCP server runs over stdio can still serve one. Claude asks for it like any other block, with `kind` set to the page's address and `app` to the server:

```
await_feedback({ kind: "ui://gallery/picker", app: "gallery", title: "Pick the keepers", props: { ids: [12, 13, 14] } })
```

The chat reads the page through the chat's own Claude Code session (`readMcpResource`). It puts the page's policy first in its head: the spec's defaults, plus only the domains the resource declares in `_meta.ui.csp`. One loosening of the defaults: `connect-src` takes the page's own `blob:` and `data:` addresses (nothing on the network), so a loader that fetches what it unpacked itself, such as three.js's GLTFLoader with a model's textures, works. Then it draws the page in an iframe sandboxed to scripts only, and talks to it over postMessage.

On the server, with [mcp-kit](../mcp-kit):

```ts
import { blockPage, blockResource } from "@btkulka/chat-blocks/page";
import { MCP_APP_MIME } from "@btkulka/chat-blocks";

const PICKER = blockPage({
  title: "Picker",
  body: `<div class="cb-body"><div id="pics"></div><div class="cb-actions"><button class="cb-btn is-primary" id="go">Keep these</button></div></div>`,
  script: `ChatBlocks.connect().then(async (block) => {
    for (const ref of block.props.refs) { const img = new Image(); img.src = await block.image(ref); pics.append(img); }
    go.onclick = () => block.answer({ keep: block.props.ids }, "Kept " + block.props.ids.length);
  });`,
});

createToolServer({
  name: "gallery", version, tools,
  resources: [{ uri: "ui://gallery/picker", name: "Gallery picker", mimeType: MCP_APP_MIME, read: () => blockResource("ui://gallery/picker", PICKER) }],
});
```

Then tell Claude, in a tool's result or the server's instructions, to call `await_feedback` with that address.

**The bridge** (`connect()`, or `window.ChatBlocks.connect()` in a `blockPage`) does the handshake. It puts the chat's theme on the page, so `frame.css` classes match the chat in either theme, and keeps the chat told of the page's height. It resolves with:

- `props`: the block's props (the MCP Apps tool input).
- `answer(value, words?)`: answers the block. In a claude-kit chat it resolves the `await_feedback` call Claude is waiting on (`awaited` is true). In another MCP Apps host, such as Claude Desktop, it sends `words` as the person's message instead.
- `image(ref)`: a chat image (a path, an address, a kept id) as a `data:` address an `<img>` draws. A sandboxed page can't load the app's files itself.
- `file(ref)`: a file as `{ bytes, type, name, size }` (an ArrayBuffer, handed over rather than copied). Only a path the block's props name, or a file in that path's folder or below it (a .gltf's .bin, an .obj's .mtl and textures, the parts a set's sidecar lists), up to 512 MB. It rejects with "This chat can't read files." where the chat doesn't offer it.
- `displayMode(mode)`: `"fullscreen"` asks the chat to show the page over the whole window (an expand button), `"inline"` back in the conversation. Resolves with where the page is now, `"inline"` where the chat can't. Pass `displayModes: ["inline", "fullscreen"]` to `connect()` so the chat knows the page can; `context.displayMode` and `onContext` follow the change, and in a claude-kit chat its Back to the chat button or Esc bring it back inline. Keys pressed inside the page stay there, so a page with an expand button handles Esc itself (`displayMode("inline")`).
- `message(text)`, `openLink(url)`, `onSettled(cb)` (answered here, typed in the chat's box, or cut short), `onContext(cb)`.

**Swiping.** A page that steps through pages (a lightbox of several pictures, videos or models) gets ← and → by swiping from `ChatBlocks.swipe(stage, { onSwipe: (d) => go(at + d) })`: `d` is 1 for a swipe to the left (the next one), -1 to the right. It takes a finger, a mouse drag (the click a drag ends in is swallowed, so a picture that zooms on a click doesn't) and a trackpad's sideways swipe (one step per flick). A vertical drag is left to scroll. `ignore(e)` leaves pointers alone where a drag means something else (a 3D view that turns, a player's controls); `enabled()` says whether there's anywhere to go; `follow` slides with the drag and springs back. Claude-kit's lightbox and Benhäus's Gallery page use the same function.

The page speaks the spec's methods (`ui/initialize`, `ui/notifications/tool-input`, `tool-result`, `tool-cancelled`, `size-changed`, `host-context-changed`, `ui/message`, `ui/open-link`, `ui/request-display-mode`). This package adds three of its own under `hostCapabilities.experimental["btkulka/blocks"]`: `btkulka/blocks/answer`, `btkulka/blocks/image` and `btkulka/blocks/file` (the flags `answer`, `image` and `file` say which the chat offers). claude-kit doesn't offer the page `tools/call` or `resources/read` on its own server: the Agent SDK has no public way to make those calls yet.

## Working on it

`npm run build` runs `scripts/inline.mjs`, which bundles the bridge as a plain script and writes it with both stylesheets into `src/generated.ts` (not committed) for `page.ts`. Then it runs tsc for both builds and copies the CSS and `bridge.global.js` into `dist/`. `npm test` covers the specs, the answers and their wording, the outcomes read back, the page policy, and the page maker.
