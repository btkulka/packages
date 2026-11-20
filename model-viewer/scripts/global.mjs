// After tsc: the viewer and three.js bundled into one plain script that sets window.ModelView, for a page
// that can't load modules or anything from the app's folder (an MCP Apps chat block, inlined by its server).
import { build } from "esbuild";

await build({
  entryPoints: ["src/global.ts"],
  bundle: true,
  format: "iife",
  globalName: "ModelView",
  platform: "browser",
  target: ["chrome110", "firefox115", "safari16"],
  minify: true,
  legalComments: "none",
  outfile: "dist/viewer.global.js",
  logLevel: "warning",
});
