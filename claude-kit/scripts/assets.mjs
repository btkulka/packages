// After tsc: the stylesheet into dist/, and the <claude-widget> element
// bundled with React inside into dist/element/ (with its stylesheet beside it,
// for the http handler's /claude/styles.css).
import { copyFileSync, mkdirSync } from "node:fs";
import { build } from "esbuild";

mkdirSync("dist/element", { recursive: true });
copyFileSync("src/styles.css", "dist/styles.css");
copyFileSync("src/styles.css", "dist/element/claude-kit.css");

await build({
  entryPoints: ["src/element/index.tsx"],
  outfile: "dist/element/claude-kit.js",
  bundle: true,
  format: "esm",
  platform: "browser",
  target: ["chrome110", "firefox115", "safari16"],
  jsx: "automatic",
  loader: { ".css": "text" },
  minify: true,
  sourcemap: true,
  define: { "process.env.NODE_ENV": '"production"' },
  legalComments: "none",
  logLevel: "warning",
});
