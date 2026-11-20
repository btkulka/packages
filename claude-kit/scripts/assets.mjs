// After tsc: the stylesheet into dist/ (with @btkulka/chat-blocks' frame.css
// after it, so blocks look the same in every chat and in the pages apps serve),
// and the <claude-widget> element bundled with React inside into dist/element/
// (with its stylesheet beside it, for the http handler's /claude/styles.css).
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { build } from "esbuild";

const frame = readFileSync(createRequire(import.meta.url).resolve("@btkulka/chat-blocks/frame.css"), "utf8");
const css = `${readFileSync("src/styles.css", "utf8")}
${frame}`;
mkdirSync("dist/element", { recursive: true });
writeFileSync("dist/styles.css", css);
writeFileSync("dist/element/claude-kit.css", css);

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
