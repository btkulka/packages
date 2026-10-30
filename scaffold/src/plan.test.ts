import assert from "node:assert/strict";
import { test } from "node:test";
import type { CatalogueEntry } from "./catalogue.js";
import { nameFromDescription, normalizePlan, slugify, uniqueSlug, verticalFromWords, type PlanContext } from "./plan.js";

const catalogue: CatalogueEntry[] = [
  { name: "@btkulka/proc-kit", dir: "proc-kit", description: "processes and ports" },
  { name: "@btkulka/electron-kit", dir: "electron-kit", description: "Electron scaffolding" },
  { name: "@btkulka/sqlite-store", dir: "sqlite-store", description: "SQLite" },
  { name: "@btkulka/mcp-kit", dir: "mcp-kit", description: "MCP plumbing" },
  { name: "@datrapscallion/comfy-client", dir: "comfy-client", description: "ComfyUI client" },
];
const ctx: PlanContext = {
  catalogue,
  verticals: [
    { id: "nhi", name: "NHI" },
    { id: "ai", name: "AI" },
    { id: "utilities", name: "Utilities" },
  ],
  taken: ["set-list", "set-list-2"],
  defaultVertical: "utilities",
};

test("slugify makes a folder name", () => {
  assert.equal(slugify("Set List Builder"), "set-list-builder");
  assert.equal(slugify("  Übung: für Ben!  "), "ubung-fur-ben");
  assert.equal(slugify("***"), "new-app");
  assert.ok(slugify("a".repeat(80)).length <= 40);
});

test("uniqueSlug steps past taken names", () => {
  assert.equal(uniqueSlug("set-list", ["set-list", "set-list-2"]), "set-list-3");
  assert.equal(uniqueSlug("fresh", ["set-list"]), "fresh");
});

test("nameFromDescription skips filler words", () => {
  assert.equal(nameFromDescription("I want a little tool that tracks my vinyl collection"), "Tracks Vinyl");
  assert.equal(nameFromDescription("an NHI setlist planner"), "NHI Setlist");
});

test("verticalFromWords reads the obvious ones", () => {
  assert.equal(verticalFromWords("something for my NHI releases", ctx.verticals), "nhi");
  assert.equal(verticalFromWords("a LoRA training helper", ctx.verticals), "ai");
  assert.equal(verticalFromWords("a thing", ctx.verticals), undefined);
});

test("normalizePlan takes a good answer as it is", () => {
  const plan = normalizePlan(
    {
      name: "Set List",
      slug: "set-list",
      kind: "electron",
      vertical: "NHI",
      summary: "Plans NHI set lists.",
      features: ["Orders a set by energy", "  ", "Exports to Rekordbox"],
      packages: ["sqlite-store", "@btkulka/proc-kit", "nope"],
      newPackage: { name: "", why: "" },
      questions: [],
      ready: true,
      firstSteps: ["Lay out the list."],
    },
    { description: "a set list planner for NHI shows" },
    ctx,
  );
  assert.equal(plan.slug, "set-list-3");
  assert.equal(plan.kind, "electron");
  assert.equal(plan.vertical, "nhi");
  assert.deepEqual(plan.packages, ["electron-kit", "proc-kit", "sqlite-store"]);
  assert.deepEqual(plan.features, ["Orders a set by energy", "Exports to Rekordbox"]);
  assert.equal(plan.newPackage, undefined);
  assert.equal(plan.ready, true);
  assert.deepEqual(plan.firstSteps, ["Lay out the list."]);
});

test("normalizePlan fills in a bad one", () => {
  const plan = normalizePlan({ kind: "spaceship", vertical: "mars", questions: [{ text: "Which?", options: ["a", "b"] }, { text: "" }], ready: false }, { description: "an MCP server that reads my ComfyUI queue" }, ctx);
  assert.equal(plan.kind, "mcp");
  assert.equal(plan.vertical, "ai");
  assert.equal(plan.name, "MCP Server");
  assert.deepEqual(plan.packages, ["mcp-kit", "comfy-client"]);
  assert.equal(plan.questions.length, 2);
  assert.equal(plan.questions[0].id, "q1");
  assert.equal(plan.questions[0].other, false);
  assert.deepEqual(plan.questions[1], { id: "else", text: "Anything else?", options: [], other: true, freeform: true });
  assert.equal(plan.ready, false);
  assert.ok(plan.firstSteps.length >= 3);
});

test("a Not quite round keeps its questions, renames reused ids and keeps the vision it had", () => {
  const shown = normalizePlan({ name: "Set List", kind: "electron", vertical: "nhi", features: ["Orders a set by energy"], questions: [], ready: true }, { description: "a set list planner" }, ctx);
  const answers = [{ id: "q1", question: "Which DJ software?", answer: "Rekordbox" }];
  const more = normalizePlan(
    {
      ...shown,
      questions: [
        { id: "q1", text: "What's most off?", options: ["The name", "What it does"], other: true },
        { id: "q2", text: "Which DJ software?", options: ["Rekordbox"] },
        { id: "q3", text: "Who's it for?", options: ["Just me", "Fans"] },
      ],
      features: [],
      ready: true,
    },
    { description: "a set list planner", answers, more: shown },
    ctx,
  );
  assert.equal(more.ready, false);
  assert.deepEqual(
    more.questions.map((q) => [q.id, q.text]),
    [
      ["q1-2", "What's most off?"],
      ["q3", "Who's it for?"],
      ["else", "Anything else?"],
    ],
  );
  assert.deepEqual(more.features, ["Orders a set by energy"]);
});

test("every round ends on Anything else?, under a fresh id, and a ready plan doesn't ask it", () => {
  const first = normalizePlan({ kind: "cli", questions: [{ id: "scope", text: "Which folders?", options: [] }], ready: false }, { description: "a cli" }, ctx);
  assert.deepEqual(
    first.questions.map((q) => q.id),
    ["scope", "else"],
  );
  assert.equal(first.questions[1].freeform, true);
  // Answered once (two lines), and Claude's own catch-all is dropped for the screen's.
  const again = normalizePlan(
    { kind: "cli", questions: [{ id: "depth", text: "How deep?", options: ["One level", "All the way"] }, { id: "q2", text: "Anything else?", options: [] }], ready: false },
    {
      description: "a cli",
      answers: [
        { id: "scope", question: "Which folders?", answer: "all" },
        { id: "else", question: "Anything else?", answer: "Keep it quiet.\nNo colours." },
      ],
    },
    ctx,
  );
  assert.deepEqual(
    again.questions.map((q) => q.id),
    ["depth", "else-2"],
  );
  const ready = normalizePlan({ kind: "cli", questions: [], ready: true }, { description: "a cli" }, ctx);
  assert.deepEqual(ready.questions, []);
});

test("normalizePlan drops questions already answered and is ready without any", () => {
  const plan = normalizePlan(
    { kind: "cli", questions: [{ id: "scope", text: "Which folders?", options: [] }], ready: false },
    { description: "a cli", answers: [{ id: "scope", question: "Which folders?", answer: "all" }] },
    ctx,
  );
  assert.deepEqual(plan.questions, []);
  assert.equal(plan.ready, true);
});
