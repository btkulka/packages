import { isAbsolute, join, relative } from "node:path";
import { findPackage, shortName, type CatalogueEntry } from "./catalogue.js";
import { appIconSvg } from "./icon.js";
import { kindOf, type AppKind } from "./kinds.js";
import type { AppPlan } from "./plan.js";

// The files a new project starts with, by kind. Each is small, runs as it
// is, and already imports the shared packages the kind builds on, so the
// first Claude Code session starts from working code instead of an empty
// folder. The brief (what Ben asked for, what he answered, the rules about
// BPM and the icon) goes in CLAUDE.md, where every session reads it.

export interface ProjectFile {
  /** Relative to the project folder, with forward slashes. */
  path: string;
  contents: string;
}

export interface RenderContext {
  /** The project's folder, absolute. */
  dir: string;
  packagesHome: string;
  catalogue: CatalogueEntry[];
  /** The date the brief carries; today by default. */
  date?: string;
  /** The port a web app or server listens on; the kind's own by default. */
  port?: number;
}

const V = {
  electron: "^41.3.0",
  electronVite: "^5.0.0",
  vite: "^7.3.2",
  pluginReact: "^5.2.0",
  react: "^19.2.5",
  reactDom: "^19.2.5",
  typesReact: "^19.2.14",
  typesReactDom: "^19.2.3",
  typesNode: "^22.19.17",
  typescript: "^5.9.3",
  tsx: "^4.20.0",
  discord: "^14.16.0",
};

const fwd = (p: string) => p.replace(/\\/g, "/");
const json = (o: unknown) => `${JSON.stringify(o, null, 2)}\n`;
const today = () => new Date().toISOString().slice(0, 10);
/** A string in a TypeScript double-quoted literal. */
const q = (s: string) => JSON.stringify(s);

/** The way from the project to a package's folder: relative, or absolute when they're on different drives. */
function pathTo(dir: string, pkgDir: string): string {
  const rel = relative(dir, pkgDir);
  if (isAbsolute(rel) || /^[a-zA-Z]:/.test(rel)) return fwd(pkgDir);
  const f = fwd(rel);
  return f.startsWith(".") ? f : `./${f}`;
}

/** A `file:` spec from the project to a package's folder. */
export const linkSpec = (dir: string, pkgDir: string) => `file:${pathTo(dir, pkgDir)}`;

/** The chosen packages as package.json dependencies (npm name → file: link). */
export function packageDeps(plan: AppPlan, ctx: RenderContext): Record<string, string> {
  const deps: Record<string, string> = {};
  for (const name of plan.packages) {
    const e = findPackage(name, ctx.catalogue);
    if (e) deps[e.name] = linkSpec(ctx.dir, join(ctx.packagesHome, e.dir));
  }
  return deps;
}

const sorted = (o: Record<string, string>) => Object.fromEntries(Object.entries(o).sort(([a], [b]) => a.localeCompare(b)));

function brief(plan: AppPlan, ctx: RenderContext): string {
  const pkgs = plan.packages.map((n) => {
    const e = findPackage(n, ctx.catalogue);
    return e ? `- \`${e.name}\` — ${e.description ?? ""}`.trimEnd() : `- ${n}`;
  });
  const isPackage = plan.kind === "package";
  return [
    `## Brief`,
    ``,
    `What Ben asked for:`,
    ``,
    `> ${plan.description.replace(/\r?\n/g, "\n> ")}`,
    ``,
    plan.features.length ? `The vision:\n\n${plan.features.map((f) => `- ${f}`).join("\n")}\n` : "",
    plan.answers.length ? `Decisions from the interview:\n\n${plan.answers.map((a) => `- ${a.question} → ${a.answer}`).join("\n")}\n` : "",
    `## Build on the shared packages (BPM)`,
    ``,
    `Ben's shared code lives in \`${fwd(ctx.packagesHome)}\` (BPM in Benhäus; \`benhaus list_packages\` and \`search_code\` over MCP). ${isPackage ? "This package" : "This app"} ${pkgs.length ? "depends on:" : "doesn't depend on any yet; it should as soon as one fits."}`,
    ``,
    pkgs.join("\n"),
    ``,
    `Rules:`,
    ``,
    `- Before writing anything that could be shared (processes and ports, SQLite, LLM calls, media, MCP plumbing, Electron scaffolding, API clients), look in BPM first and use the package. Link one that isn't here yet with \`"@btkulka/<name>": "file:${pathTo(ctx.dir, ctx.packagesHome)}/<name>"\` and \`npm install\`.`,
    `- When something here turns out to be reusable, make it a package in \`${fwd(ctx.packagesHome)}\` (the dual ESM+CJS layout the others have, an \`icon.svg\` in the Benhäus app-icon style designed with Claude Design) and depend on it here. Delete the copy it replaces in the same change.`,
    `- Packages load from their \`dist/\`: run \`npm run build\` in \`${fwd(ctx.packagesHome)}\` after changing one.`,
    plan.newPackage ? `- The plan calls for a new package: **${plan.newPackage.name}** — ${plan.newPackage.why} Create it first, then build on it here.` : "",
    ``,
    `## Icon`,
    ``,
    isPackage
      ? `\`icon.svg\` is a placeholder monogram in the Benhäus app-icon style, tinted for the ${plan.vertical} vertical; BPM draws it. Design the real one with Claude Design (the Benhäus design system's app-icon style) and save it over the placeholder.`
      : `\`icon.svg\` is a placeholder monogram in the Benhäus app-icon style, already wired as this tool's logo in Benhäus's config (\`logos.${plan.slug}\`). Design the real one with Claude Design (the Benhäus design system's app-icon style, tinted for the ${plan.vertical} vertical) and save it over the placeholder.`,
    ``,
    `## First steps`,
    ``,
    plan.firstSteps.map((s, i) => `${i + 1}. ${s}`).join("\n"),
    ``,
  ]
    .filter((l) => l !== "")
    .join("\n")
    .replace(/\n{3,}/g, "\n\n");
}

function claudeMd(plan: AppPlan, ctx: RenderContext): string {
  const where = plan.kind === "package" ? `BPM lists it on its own (every folder in \`${fwd(ctx.packagesHome)}\` with a package.json is a package there).` : `Benhäus lists it as the tool \`${plan.slug}\`: its page shows this folder, its git state and how it opens.`;
  return `# ${plan.name}\n\n${plan.summary}\n\nStarted ${ctx.date ?? today()} from Benhäus's New app screen; this file is the brief. ${where}\n\n${brief(plan, ctx)}`;
}

function readme(plan: AppPlan, ctx: RenderContext, run: string[]): string {
  const pkgs = plan.packages.map((n) => findPackage(n, ctx.catalogue)).filter((e): e is CatalogueEntry => Boolean(e));
  return [
    `# ${plan.name}`,
    ``,
    plan.summary,
    ``,
    `## Run`,
    ``,
    "```sh",
    ...run,
    "```",
    ``,
    pkgs.length ? `## Built on\n\n${pkgs.map((e) => `- [\`${e.name}\`](${pathTo(ctx.dir, join(ctx.packagesHome, e.dir))}) — ${e.description ?? ""}`.trimEnd()).join("\n")}\n` : "",
    `CLAUDE.md has the brief.`,
    ``,
  ]
    .filter((l) => l !== "")
    .join("\n")
    .replace(/\n{3,}/g, "\n\n");
}

const GITIGNORE = ["node_modules/", "dist/", "out/", ".env", "*.log", ".DS_Store", "Thumbs.db", ""].join("\n");

const TSCONFIG_NODE = {
  compilerOptions: { target: "ES2022", module: "ESNext", moduleResolution: "Bundler", strict: true, esModuleInterop: true, skipLibCheck: true, resolveJsonModule: true, noEmit: true, types: ["node"], lib: ["ES2023"] },
};

const TSCONFIG_WEB = {
  compilerOptions: { target: "ES2022", module: "ESNext", moduleResolution: "Bundler", jsx: "react-jsx", strict: true, esModuleInterop: true, skipLibCheck: true, noEmit: true, lib: ["ES2023", "DOM", "DOM.Iterable"] },
};

const TSCONFIG_BUILD = {
  compilerOptions: { target: "ES2022", module: "NodeNext", moduleResolution: "NodeNext", strict: true, esModuleInterop: true, skipLibCheck: true, outDir: "dist", rootDir: "src", sourceMap: true, types: ["node"], lib: ["ES2023"] },
  include: ["src/**/*"],
};

/* ----------------------------------------------------------- the kinds */

function reactPage(plan: AppPlan): ProjectFile[] {
  return [
    {
      path: "src/App.tsx",
      contents: `import { useEffect, useState } from "react";

export function App() {
  const [info, setInfo] = useState<{ name: string; version: string }>();
  useEffect(() => {
    void window.app?.info().then(setInfo);
  }, []);
  return (
    <main className="app">
      <h1>{info?.name ?? ${q(plan.name)}}</h1>
      <p>${plan.summary.replace(/[{}<>]/g, "")}</p>
      {info && <p className="dim">v{info.version}</p>}
    </main>
  );
}
`,
    },
    {
      path: "src/main.tsx",
      contents: `import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import "./styles.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
`,
    },
    {
      path: "src/styles.css",
      contents: `:root { color-scheme: dark; font-family: Inter, "Segoe UI", system-ui, sans-serif; }
html, body, #root { margin: 0; min-height: 100%; }
body { background: #0c0c0e; color: #f2f2f4; }
.app { max-width: 720px; margin: 0 auto; padding: 64px 24px; }
.app h1 { font-size: 40px; letter-spacing: -0.02em; margin: 0 0 12px; }
.app p { font-size: 17px; line-height: 1.5; margin: 0 0 8px; }
.dim { opacity: 0.55; }
`,
    },
  ];
}

function electronFiles(plan: AppPlan, ctx: RenderContext): ProjectFile[] {
  const pkg = {
    name: plan.slug,
    productName: plan.name,
    version: "0.1.0",
    private: true,
    description: plan.summary,
    type: "module",
    main: "out/main/index.cjs",
    scripts: {
      dev: "node scripts/run.mjs dev",
      build: "electron-vite build",
      start: "node scripts/run.mjs preview",
      typecheck: "tsc --noEmit -p tsconfig.node.json && tsc --noEmit -p tsconfig.web.json",
    },
    dependencies: sorted(packageDeps(plan, ctx)),
    devDependencies: {
      "@types/node": V.typesNode,
      "@types/react": V.typesReact,
      "@types/react-dom": V.typesReactDom,
      "@vitejs/plugin-react": V.pluginReact,
      electron: V.electron,
      "electron-vite": V.electronVite,
      react: V.react,
      "react-dom": V.reactDom,
      typescript: V.typescript,
      vite: V.vite,
    },
  };
  const page = reactPage(plan).map((f) => ({ ...f, path: `src/renderer/${f.path}` }));
  // The BPM packages are bundled into main and preload rather than left as require()s: the preload is sandboxed, so a require() there loads nothing and the window gets no API.
  const bundled = JSON.stringify(Object.keys(pkg.dependencies));
  return [
    { path: "package.json", contents: json(pkg) },
    { path: "README.md", contents: readme(plan, ctx, ["npm install", "npm run dev      # the window, with hot reload", "npm run build    # out/"]) },
    { path: "tsconfig.json", contents: json({ files: [], references: [{ path: "./tsconfig.node.json" }, { path: "./tsconfig.web.json" }] }) },
    { path: "tsconfig.node.json", contents: json({ ...TSCONFIG_NODE, compilerOptions: { ...TSCONFIG_NODE.compilerOptions, composite: true }, include: ["electron.vite.config.ts", "src/main/**/*", "src/preload/**/*", "src/shared/**/*"] }) },
    { path: "tsconfig.web.json", contents: json({ ...TSCONFIG_WEB, compilerOptions: { ...TSCONFIG_WEB.compilerOptions, composite: true }, include: ["src/renderer/**/*", "src/shared/**/*"] }) },
    {
      path: "electron.vite.config.ts",
      contents: `import { defineConfig, externalizeDepsPlugin } from "electron-vite";
import react from "@vitejs/plugin-react";
import { resolve } from "node:path";

// Main and preload are emitted as CommonJS (.cjs): the package is "type": "module" and a sandboxed preload must be CJS.
// The BPM packages (file: links in dependencies) are bundled in, not externalized: a sandboxed preload can't require() them.
const bundled = ${bundled};
export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin({ exclude: bundled })],
    build: { outDir: "out/main", rollupOptions: { input: resolve(__dirname, "src/main/index.ts"), output: { format: "cjs", entryFileNames: "[name].cjs" } } },
  },
  preload: {
    plugins: [externalizeDepsPlugin({ exclude: bundled })],
    build: { outDir: "out/preload", rollupOptions: { input: resolve(__dirname, "src/preload/index.ts"), output: { format: "cjs", entryFileNames: "[name].cjs" } } },
  },
  renderer: {
    root: resolve(__dirname, "src/renderer"),
    plugins: [react()],
    build: { outDir: resolve(__dirname, "out/renderer"), rollupOptions: { input: resolve(__dirname, "src/renderer/index.html") } },
  },
});
`,
    },
    {
      path: "scripts/run.mjs",
      contents: `// electron-vite with a clean environment. VS Code and Claude Code set
// ELECTRON_RUN_AS_NODE for child processes, which makes Electron start as
// plain Node; proc-kit's electronEnv() clears it.
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { electronEnv, packageBin, runAndExit } from "@btkulka/proc-kit";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
runAndExit(process.execPath, [packageBin("electron-vite", { from: ROOT }), ...process.argv.slice(2)], { cwd: ROOT, env: electronEnv() });
`,
    },
    {
      path: "src/shared/ipc.ts",
      contents: `// The channels between the window and main, typed once for both sides (electron-kit's IpcSchema).
export type AppIpc = {
  invoke: {
    "app:info": () => { name: string; version: string };
  };
};
`,
    },
    {
      path: "src/main/index.ts",
      contents: `import { app, BrowserWindow, ipcMain, screen, shell } from "electron";
import { join } from "node:path";
import * as kit from "@btkulka/electron-kit/main";
import type { AppIpc } from "../shared/ipc";

// ${plan.name}: ${plan.summary}
// The Electron plumbing (single instance, window state, loading, links,
// IPC, crashes) is electron-kit's; this file is what's particular to the app.

let win: BrowserWindow | undefined;

function createWindow() {
  const state = kit.windowState({ screen, store: kit.windowStateFile(join(app.getPath("userData"), "windows.json")), key: "main", defaults: { width: 1200, height: 800 } });
  win = new BrowserWindow({
    ...state.bounds,
    minWidth: 720,
    minHeight: 480,
    show: false,
    title: ${q(plan.name)},
    webPreferences: { preload: join(__dirname, "../preload/index.cjs"), sandbox: true },
  });
  state.attach(win);
  kit.routeNewWindowsToBrowser(win.webContents, shell);
  win.once("ready-to-show", () => win?.show());
  win.on("closed", () => (win = undefined));
  void kit.loadRenderer(win, { devUrl: process.env.ELECTRON_RENDERER_URL, file: join(__dirname, "../renderer/index.html") });
  return win;
}

kit.logCrashes((kind, error) => console.error(kind, error), { app });

if (kit.requestSingleInstance(app, { window: () => win })) {
  const ipc = kit.createIpcMain<AppIpc>(ipcMain, BrowserWindow);
  ipc.handle("app:info", () => ({ name: app.getName(), version: app.getVersion() }));
  kit.registerWindowControls(ipcMain, BrowserWindow);
  void kit.startApp(app, BrowserWindow, { ready: () => void createWindow(), createWindow });
}
`,
    },
    {
      path: "src/preload/index.ts",
      contents: `import { contextBridge, ipcRenderer } from "electron";
import { createBridge, windowControls } from "@btkulka/electron-kit/preload";
import type { AppIpc } from "../shared/ipc";

// The only door between the page and main: named, typed calls.
const { invoke } = createBridge<AppIpc>(ipcRenderer);

contextBridge.exposeInMainWorld("app", {
  info: invoke("app:info"),
  window: windowControls(ipcRenderer),
});
`,
    },
    {
      path: "src/renderer/index.html",
      contents: `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta http-equiv="Content-Security-Policy" content="default-src 'self'; style-src 'self' 'unsafe-inline'" />
    <title>${plan.name}</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="./src/main.tsx"></script>
  </body>
</html>
`,
    },
    {
      path: "src/renderer/src/window.d.ts",
      contents: `// What the preload exposes on window.app. (Not app.d.ts: beside App.tsx, tsc on Windows drops it as a duplicate.)
interface Window {
  app?: {
    info(): Promise<{ name: string; version: string }>;
    window: { minimize(): void; toggleMaximize(): void; close(): void; isMaximized(): Promise<boolean> };
  };
}
`,
    },
    ...page,
  ];
}

function webFiles(plan: AppPlan, ctx: RenderContext): ProjectFile[] {
  const port = ctx.port ?? kindOf("web")!.port!;
  const pkg = {
    name: plan.slug,
    version: "0.1.0",
    private: true,
    description: plan.summary,
    type: "module",
    scripts: {
      dev: `vite --port ${port} --strictPort`,
      build: "tsc -p tsconfig.json --noEmit && vite build",
      preview: "vite preview",
      typecheck: "tsc -p tsconfig.json --noEmit",
    },
    dependencies: sorted({ react: V.react, "react-dom": V.reactDom, ...packageDeps(plan, ctx) }),
    devDependencies: { "@types/react": V.typesReact, "@types/react-dom": V.typesReactDom, "@vitejs/plugin-react": V.pluginReact, typescript: V.typescript, vite: V.vite },
  };
  return [
    { path: "package.json", contents: json(pkg) },
    { path: "README.md", contents: readme(plan, ctx, ["npm install", `npm run dev      # http://localhost:${port}`, "npm run build    # dist/"]) },
    { path: "tsconfig.json", contents: json({ ...TSCONFIG_WEB, include: ["src", "vite.config.ts"] }) },
    {
      path: "vite.config.ts",
      contents: `import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  server: { port: ${port}, strictPort: true },
});
`,
    },
    {
      path: "index.html",
      contents: `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${plan.name}</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
`,
    },
    { path: "src/window.d.ts", contents: `// A web app has no preload; App.tsx's window.app is optional for that reason. (Not app.d.ts: beside App.tsx, tsc on Windows drops it as a duplicate.)\ninterface Window {\n  app?: { info(): Promise<{ name: string; version: string }> };\n}\n` },
    ...reactPage(plan),
  ];
}

function serviceFiles(plan: AppPlan, ctx: RenderContext): ProjectFile[] {
  const port = ctx.port ?? kindOf("service")!.port!;
  const pkg = {
    name: plan.slug,
    version: "0.1.0",
    private: true,
    description: plan.summary,
    type: "module",
    scripts: { dev: "tsx watch src/server.ts", start: "tsx src/server.ts", typecheck: "tsc -p tsconfig.json --noEmit" },
    dependencies: sorted(packageDeps(plan, ctx)),
    devDependencies: { "@types/node": V.typesNode, tsx: V.tsx, typescript: V.typescript },
  };
  return [
    { path: "package.json", contents: json(pkg) },
    { path: "README.md", contents: readme(plan, ctx, ["npm install", `npm run dev      # http://127.0.0.1:${port}, restarts on change`, "npm start"]) },
    { path: "tsconfig.json", contents: json({ ...TSCONFIG_NODE, include: ["src"] }) },
    {
      path: "src/server.ts",
      contents: `import { createServer } from "node:http";
import { freePort, probeHttp } from "@btkulka/proc-kit";

// ${plan.name}: ${plan.summary}
// Benhäus starts it and watches /health on the port.

const PORT = Number(process.env.PORT ?? ${port});
const NAME = ${q(plan.name)};

async function main() {
  const health = \`http://127.0.0.1:\${PORT}/health\`;
  if (await probeHttp(health)) {
    console.log(\`\${NAME} is already running on :\${PORT}\`);
    return;
  }
  // A dead copy still holding the port is freed; a healthy one was kept above.
  const freed = await freePort(PORT);
  if (freed.killed.length) console.log(\`freed :\${PORT} (killed \${freed.killed.join(", ")})\`);

  const server = createServer((req, res) => {
    if (req.url === "/health") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, name: NAME }));
      return;
    }
    res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
    res.end(\`\${NAME}\\n\`);
  });
  server.listen(PORT, "127.0.0.1", () => console.log(\`\${NAME} listening on http://127.0.0.1:\${PORT}\`));
}

void main();
`,
    },
  ];
}

function cliFiles(plan: AppPlan, ctx: RenderContext): ProjectFile[] {
  const pkg = {
    name: plan.slug,
    version: "0.1.0",
    private: true,
    description: plan.summary,
    type: "module",
    bin: { [plan.slug]: "./dist/cli.js" },
    scripts: { dev: "tsx src/cli.ts", build: "tsc -p tsconfig.json", typecheck: "tsc -p tsconfig.json --noEmit" },
    dependencies: sorted(packageDeps(plan, ctx)),
    devDependencies: { "@types/node": V.typesNode, tsx: V.tsx, typescript: V.typescript },
  };
  return [
    { path: "package.json", contents: json(pkg) },
    { path: "README.md", contents: readme(plan, ctx, ["npm install", "npm run dev -- --help", `npm run build && npm link    # then: ${plan.slug} --help`]) },
    { path: "tsconfig.json", contents: json(TSCONFIG_BUILD) },
    {
      path: "src/cli.ts",
      contents: `#!/usr/bin/env node
import { parseArgs } from "node:util";

// ${plan.name}: ${plan.summary}

const USAGE = \`Usage: ${plan.slug} [options]

  --help     this
  --version  the version\`;

function main(argv: string[]) {
  const { values } = parseArgs({ args: argv, options: { help: { type: "boolean", short: "h" }, version: { type: "boolean", short: "v" } }, allowPositionals: true });
  if (values.help) return console.log(USAGE);
  if (values.version) return console.log("0.1.0");
  console.log(${q(`${plan.name}: nothing to do yet. Try --help.`)});
}

main(process.argv.slice(2));
`,
    },
  ];
}

function mcpFiles(plan: AppPlan, ctx: RenderContext): ProjectFile[] {
  const pkg = {
    name: plan.slug,
    version: "0.1.0",
    private: true,
    description: plan.summary,
    type: "module",
    bin: { [plan.slug]: "./dist/server.js" },
    scripts: { dev: "tsx src/server.ts", build: "tsc -p tsconfig.json", typecheck: "tsc -p tsconfig.json --noEmit" },
    dependencies: sorted(packageDeps(plan, ctx)),
    devDependencies: { "@types/node": V.typesNode, tsx: V.tsx, typescript: V.typescript },
  };
  const entry = fwd(join(ctx.dir, "dist", "server.js"));
  return [
    { path: "package.json", contents: json(pkg) },
    { path: "README.md", contents: readme(plan, ctx, ["npm install", "npm run build", `claude mcp add ${plan.slug} -- node ${entry}    # register with Claude Code`]) },
    { path: "tsconfig.json", contents: json(TSCONFIG_BUILD) },
    {
      path: "src/server.ts",
      contents: `#!/usr/bin/env node
import { createLogger, createToolServer, runMain, serveStdio } from "@btkulka/mcp-kit";

// ${plan.name}: ${plan.summary}
// Tools for Claude over stdio. mcp-kit does the serving; the tools are here.

const NAME = ${q(plan.slug)};
const VERSION = "0.1.0";
const log = createLogger(NAME);

const tools = [
  {
    name: "status",
    description: ${q(`${plan.name}: whether it's up and what it knows.`)},
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    run: () => ({ ok: true, name: NAME, version: VERSION }),
  },
];

runMain(async () => {
  await serveStdio(createToolServer({ name: NAME, version: VERSION, instructions: ${q(plan.summary)}, tools }), { log });
  log(\`ready, \${tools.length} tool\${tools.length === 1 ? "" : "s"}\`);
});
`,
    },
  ];
}

function botFiles(plan: AppPlan, ctx: RenderContext): ProjectFile[] {
  const pkg = {
    name: plan.slug,
    version: "0.1.0",
    private: true,
    description: plan.summary,
    type: "module",
    scripts: {
      start: "node --env-file=.env --import tsx src/bot.ts",
      dev: "node --env-file=.env --import tsx --watch src/bot.ts",
      typecheck: "tsc -p tsconfig.json --noEmit",
    },
    dependencies: sorted({ "discord.js": V.discord, ...packageDeps(plan, ctx) }),
    devDependencies: { "@types/node": V.typesNode, tsx: V.tsx, typescript: V.typescript },
  };
  return [
    { path: "package.json", contents: json(pkg) },
    { path: "README.md", contents: readme(plan, ctx, ["npm install", "copy .env.example .env    # then put the bot token in it", "npm start"]) },
    { path: "tsconfig.json", contents: json({ ...TSCONFIG_NODE, include: ["src"] }) },
    { path: ".env.example", contents: "DISCORD_TOKEN=\n" },
    {
      path: "src/bot.ts",
      contents: `import { Client, Events, GatewayIntentBits } from "discord.js";

// ${plan.name}: ${plan.summary}

const token = process.env.DISCORD_TOKEN;
if (!token) {
  console.error("Put the bot's token in .env as DISCORD_TOKEN (see .env.example).");
  process.exit(1);
}

const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent] });

client.once(Events.ClientReady, (c) => console.log(\`${plan.name} is online as \${c.user.tag}\`));

client.on(Events.MessageCreate, (message) => {
  if (message.author.bot) return;
  if (message.content === "!ping") void message.reply("pong");
});

void client.login(token);
`,
    },
  ];
}

function packageFiles(plan: AppPlan, ctx: RenderContext): ProjectFile[] {
  const pkg = {
    name: `@btkulka/${plan.slug}`,
    version: "0.1.0",
    description: plan.summary,
    repository: { type: "git", url: "git+https://github.com/btkulka/packages.git", directory: plan.slug },
    publishConfig: { registry: "https://npm.pkg.github.com" },
    type: "module",
    main: "./dist/cjs/index.js",
    types: "./dist/esm/index.d.ts",
    exports: { ".": { types: "./dist/esm/index.d.ts", import: "./dist/esm/index.js", require: "./dist/cjs/index.js" } },
    files: ["dist", "!dist/**/*.test.*", "!dist/**/*.test.*.map", "README.md"],
    engines: { node: ">=22" },
    scripts: {
      build: "tsc -p tsconfig.json && tsc -p tsconfig.cjs.json && node ../scripts/cjs-marker.mjs",
      typecheck: "tsc -p tsconfig.json --noEmit",
      test: 'npm run build && node --test "dist/esm/**/*.test.js"',
      prepublishOnly: "npm run build",
    },
    ...(plan.packages.length ? { dependencies: sorted(packageDeps(plan, ctx)) } : {}),
    devDependencies: { "@types/node": "^22.0.0", typescript: V.typescript },
  };
  const exportName = plan.slug.replace(/-([a-z0-9])/g, (_m, c: string) => c.toUpperCase());
  return [
    { path: "package.json", contents: json(pkg) },
    {
      path: "README.md",
      contents: `# @btkulka/${plan.slug}\n\n${plan.summary}\n\nESM and CommonJS builds. Node 22+.\n\n\`\`\`json\n"dependencies": { "@btkulka/${plan.slug}": "file:../packages/${plan.slug}" }\n\`\`\`\n\nBuild it first (\`npm run build\` here, or in the packages home); apps load \`dist/\`.\n\n## API\n\n\`\`\`ts\nimport { ${exportName} } from "@btkulka/${plan.slug}";\n\`\`\`\n\nCLAUDE.md has the brief.\n`,
    },
    {
      path: "tsconfig.json",
      contents: json({
        compilerOptions: { target: "ES2022", module: "NodeNext", moduleResolution: "NodeNext", lib: ["ES2022"], types: ["node"], outDir: "dist/esm", rootDir: "src", strict: true, declaration: true, declarationMap: true, sourceMap: true, esModuleInterop: true, skipLibCheck: true, forceConsistentCasingInFileNames: true },
        include: ["src/**/*"],
        exclude: ["dist", "node_modules"],
      }),
    },
    { path: "tsconfig.cjs.json", contents: json({ extends: "./tsconfig.json", compilerOptions: { module: "CommonJS", moduleResolution: "Node10", outDir: "dist/cjs", declaration: false, declarationMap: false }, exclude: ["dist", "node_modules", "src/**/*.test.ts"] }) },
    {
      path: "src/index.ts",
      contents: `// @btkulka/${plan.slug}: ${plan.summary}
// Source imports use .js extensions; no import.meta or top-level await (the CommonJS build needs neither).

/** What the package does, in one call; replace with the real API. */
export function ${exportName}(): string {
  return ${q(plan.name)};
}
`,
    },
    {
      path: "src/index.test.ts",
      contents: `import assert from "node:assert/strict";
import { test } from "node:test";
import { ${exportName} } from "./index.js";

test("${exportName} answers", () => {
  assert.equal(${exportName}(), ${q(plan.name)});
});
`,
    },
  ];
}

const BY_KIND: Record<AppKind, (plan: AppPlan, ctx: RenderContext) => ProjectFile[]> = {
  electron: electronFiles,
  web: webFiles,
  service: serviceFiles,
  cli: cliFiles,
  mcp: mcpFiles,
  bot: botFiles,
  package: packageFiles,
};

/** Every file the new project starts with. */
export function renderProject(plan: AppPlan, ctx: RenderContext): ProjectFile[] {
  return [
    ...BY_KIND[plan.kind](plan, ctx),
    { path: "CLAUDE.md", contents: claudeMd(plan, ctx) },
    { path: ".gitignore", contents: GITIGNORE },
    { path: "icon.svg", contents: appIconSvg({ name: plan.name, title: `${plan.name}: ${plan.summary}`, vertical: plan.vertical }) },
  ];
}

/** The npm names behind a plan's packages, for whoever lists them. */
export const packageNames = (plan: AppPlan, catalogue: CatalogueEntry[]) => plan.packages.map((n) => findPackage(n, catalogue)?.name ?? shortName(n));
