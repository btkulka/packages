import assert from "node:assert/strict";
import { test } from "node:test";
import type { CatalogueEntry } from "./catalogue.js";
import { linkSpec, renderProject } from "./files.js";
import { handoffPrompt } from "./handoff.js";
import { appIconSvg, monogram } from "./icon.js";
import { KINDS } from "./kinds.js";
import type { AppPlan } from "./plan.js";

const catalogue: CatalogueEntry[] = [
  { name: "@btkulka/proc-kit", dir: "proc-kit", description: "processes and ports" },
  { name: "@btkulka/electron-kit", dir: "electron-kit", description: "Electron scaffolding" },
  { name: "@btkulka/mcp-kit", dir: "mcp-kit", description: "MCP plumbing" },
];
const packagesHome = "D:/source/packages";

const plan = (over: Partial<AppPlan>): AppPlan => ({
  name: "Set List",
  slug: "set-list",
  kind: "electron",
  vertical: "nhi",
  summary: "Plans set lists.",
  features: ["Drag tracks into order", "Shows the energy curve"],
  description: "a set list planner",
  answers: [{ question: "For whom?", answer: "me" }],
  packages: ["electron-kit", "proc-kit"],
  questions: [],
  ready: true,
  firstSteps: ["Lay out the list."],
  ...over,
});

test("linkSpec is relative and forward-slashed, absolute across drives", () => {
  assert.equal(linkSpec("D:\\source\\set-list", "D:\\source\\packages\\proc-kit"), "file:../packages/proc-kit");
  assert.equal(linkSpec("D:/source/packages/new-kit", "D:/source/packages/proc-kit"), "file:../proc-kit");
  if (process.platform === "win32") assert.equal(linkSpec("C:/tmp/apps/thing", "D:/source/packages/proc-kit"), "file:D:/source/packages/proc-kit");
});

test("every kind renders a project with a valid package.json, the brief and an icon", () => {
  for (const k of KINDS) {
    const p = plan({ kind: k.id, packages: k.packages });
    const dir = k.id === "package" ? `${packagesHome}/set-list` : "D:/source/set-list";
    const files = renderProject(p, { dir, packagesHome, catalogue, date: "2026-10-23" });
    const paths = files.map((f) => f.path);
    for (const want of ["package.json", "README.md", "CLAUDE.md", ".gitignore", "icon.svg"]) assert.ok(paths.includes(want), `${k.id} has ${want}`);
    assert.equal(new Set(paths).size, paths.length, `${k.id} has no duplicate paths`);
    const manifest = JSON.parse(files.find((f) => f.path === "package.json")!.contents) as { name: string; dependencies?: Record<string, string> };
    assert.equal(manifest.name, k.id === "package" ? "@btkulka/set-list" : "set-list");
    for (const name of k.packages) {
      const npm = catalogue.find((c) => c.dir === name)!.name;
      assert.match(manifest.dependencies?.[npm] ?? "", /^file:\.\.\//, `${k.id} links ${name}`);
    }
    const claude = files.find((f) => f.path === "CLAUDE.md")!.contents;
    assert.match(claude, /a set list planner/);
    assert.match(claude, /The vision:\n\n- Drag tracks into order\n- Shows the energy curve/);
    assert.match(claude, /For whom\? → me/);
    assert.match(claude, /Claude Design/);
    assert.match(claude, /2026-10-23/);
  }
});

test("the electron scaffold imports electron-kit and proc-kit", () => {
  const files = renderProject(plan({}), { dir: "D:/source/set-list", packagesHome, catalogue });
  const main = files.find((f) => f.path === "src/main/index.ts")!.contents;
  assert.match(main, /@btkulka\/electron-kit\/main/);
  assert.match(files.find((f) => f.path === "scripts/run.mjs")!.contents, /@btkulka\/proc-kit/);
  assert.match(files.find((f) => f.path === "src/preload/index.ts")!.contents, /@btkulka\/electron-kit\/preload/);
});

test("the mcp scaffold serves with mcp-kit", () => {
  const files = renderProject(plan({ kind: "mcp", packages: ["mcp-kit"] }), { dir: "D:/source/set-list", packagesHome, catalogue });
  assert.match(files.find((f) => f.path === "src/server.ts")!.contents, /createToolServer|serveStdio/);
});

test("the icon is the Benhäus plate with a monogram in the vertical's tint", () => {
  assert.equal(monogram("Set List"), "SL");
  assert.equal(monogram("clipdrift"), "Cl");
  const svg = appIconSvg({ name: "Set List", vertical: "nhi" });
  assert.match(svg, /^<svg xmlns/);
  assert.match(svg, /#cf9dff/);
  assert.match(svg, />SL<\/text>/);
  assert.match(svg, /rx="57"/);
});

test("the hand-off prompt says where, what, and what to build on", () => {
  const text = handoffPrompt(plan({ newPackage: { name: "setlist-core", why: "Three apps parse set lists." } }), { dir: "D:/source/set-list", packagesHome, catalogue, packagesBuilt: false });
  assert.match(text, /D:\\source\\set-list/);
  assert.match(text, /The vision:\n- Drag tracks into order/);
  assert.match(text, /@btkulka\/electron-kit: Electron scaffolding/);
  assert.match(text, /setlist-core — Three apps parse set lists\./);
  assert.match(text, /npm run build in D:\\source\\packages/);
  assert.match(text, /tool "set-list"/);
  assert.equal((text.match(/npm install/g) ?? []).length, 1);
});
