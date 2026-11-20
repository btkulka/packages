// An app's block page, made whole: its markup and script with page.css,
// frame.css and the bridge (window.ChatBlocks) inlined, since a sandboxed
// page loads nothing from the app's folder. And the MCP resource that serves
// it (the app's resources/read answer for its ui:// address).

import { MCP_APP_MIME, type PageCsp } from "./app.js";
import { BRIDGE_SCRIPT, FRAME_CSS, PAGE_CSS } from "./generated.js";

export { BRIDGE_SCRIPT, FRAME_CSS, PAGE_CSS };

export interface BlockPageOptions {
  /** The page's title (the chat draws the block's own title above it). */
  title?: string;
  /** More CSS, after page.css and frame.css. */
  style?: string;
  /** The page's markup. */
  body: string;
  /** Its script, run after the bridge: `ChatBlocks.connect().then((block) => …)`. */
  script: string;
}

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;");
/** Text that goes inside <script> or <style>: nothing in it may close the element. */
const inline = (s: string, tag: "script" | "style") => s.replace(new RegExp(`</${tag}`, "gi"), `<\\/${tag}`);

/** A self-contained page: the chat's look, the bridge, and the app's markup and script. */
export function blockPage(o: BlockPageOptions): string {
  return [
    "<!doctype html>",
    '<html lang="en">',
    "<head>",
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<title>${esc(o.title ?? "Block")}</title>`,
    `<style>${inline(PAGE_CSS, "style")}\n${inline(FRAME_CSS, "style")}${o.style ? `\n${inline(o.style, "style")}` : ""}</style>`,
    `<script>${inline(BRIDGE_SCRIPT, "script")}</script>`,
    "</head>",
    "<body>",
    o.body,
    `<script>${inline(o.script, "script")}</script>`,
    "</body>",
    "</html>",
  ].join("\n");
}

export interface BlockResource {
  uri: string;
  mimeType: string;
  text: string;
  _meta?: { ui: { csp?: PageCsp; prefersBorder?: boolean } };
}

/**
 * The resources/read contents for a block page: `{ contents: [blockResource(…)] }`.
 * `csp` names the only domains it may reach (none by default); the chat draws its
 * own frame around it, so it asks for no border.
 */
export function blockResource(uri: string, html: string, csp?: PageCsp): BlockResource {
  if (!uri.startsWith("ui://")) throw new Error(`${uri}: a block page's address starts with ui://.`);
  return { uri, mimeType: MCP_APP_MIME, text: html, _meta: { ui: { ...(csp ? { csp } : {}), prefersBorder: false } } };
}
