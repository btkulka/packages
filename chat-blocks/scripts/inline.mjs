// Before tsc: the bridge bundled as a plain script (window.ChatBlocks), and
// the stylesheets, as strings in src/generated.ts for page.ts to inline into
// an app's block page. After tsc (--copy): the stylesheets and the script into
// dist/ for apps that serve them themselves.
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { build } from "esbuild";

if (process.argv.includes("--copy")) {
  mkdirSync("dist", { recursive: true });
  copyFileSync("src/frame.css", "dist/frame.css");
  copyFileSync("src/page.css", "dist/page.css");
  copyFileSync(".bridge.global.js", "dist/bridge.global.js");
  process.exit(0);
}

const out = await build({
  entryPoints: ["src/bridge.ts"],
  bundle: true,
  format: "iife",
  globalName: "ChatBlocks",
  platform: "browser",
  target: ["chrome110", "firefox115", "safari16"],
  minify: true,
  legalComments: "none",
  write: false,
  logLevel: "warning",
});
const bridge = out.outputFiles[0].text.trim();
writeFileSync(".bridge.global.js", bridge + "\n");
const s = (v) => JSON.stringify(v);
writeFileSync(
  "src/generated.ts",
  [
    "// Made by scripts/inline.mjs from bridge.ts, page.css and frame.css: don't edit.",
    `export const BRIDGE_SCRIPT = ${s(bridge)};`,
    `export const PAGE_CSS = ${s(readFileSync("src/page.css", "utf8"))};`,
    `export const FRAME_CSS = ${s(readFileSync("src/frame.css", "utf8"))};`,
    "",
  ].join("\n"),
);
