import assert from "node:assert/strict";
import { test } from "node:test";
import type { CatalogueEntry } from "./catalogue.js";
import { PLAN_SCHEMA, fallbackPlan, planPrompt } from "./interview.js";
import type { PlanContext } from "./plan.js";

const catalogue: CatalogueEntry[] = [
  { name: "@btkulka/proc-kit", dir: "proc-kit", description: "processes and ports" },
  { name: "@btkulka/electron-kit", dir: "electron-kit", description: "Electron scaffolding" },
  { name: "@btkulka/llm-kit", dir: "llm-kit", description: "LLM transport" },
];
const ctx: PlanContext = { catalogue, verticals: [{ id: "games", name: "Games" }, { id: "utilities", name: "Utilities" }], taken: [], defaultVertical: "utilities" };

test("the schema requires what normalizePlan reads", () => {
  for (const k of ["name", "slug", "kind", "vertical", "packages", "questions", "ready", "firstSteps"]) assert.ok(PLAN_SCHEMA.required.includes(k as never), k);
});

test("planPrompt carries the description, the answers and the catalogue", () => {
  const p = planPrompt({ description: "a dice roller", answers: [{ question: "For whom?", answer: "my D&D group" }] }, ctx);
  assert.match(p, /a dice roller/);
  assert.match(p, /For whom\? → my D&D group/);
  assert.match(p, /proc-kit: processes and ports/);
  assert.match(p, /games: Games/);
  assert.match(p, /so don't ask a catch-all/);
  assert.doesNotMatch(p, /fold them into/);
});

test("planPrompt hands Claude his notes, indented, and says what to do with them", () => {
  const p = planPrompt({ description: "a dice roller", answers: [{ id: "else", question: "Anything else?", answer: "Dark theme.\nNo sound." }] }, ctx);
  assert.match(p, /Anything else\? → Dark theme\.\n  No sound\./);
  assert.match(p, /fold them into the summary, the vision and firstSteps/);
});

test("fallbackPlan asks what it can't tell, then is ready", () => {
  const first = fallbackPlan({ description: "a thing for stuff" }, ctx);
  assert.equal(first.ready, false);
  assert.deepEqual(
    first.questions.map((q) => q.id),
    ["kind", "vertical", "name", "else"],
  );
  assert.ok(first.questions[0].options.includes("Desktop app"));
  const second = fallbackPlan(
    {
      description: "a thing for stuff",
      answers: [
        { id: "kind", question: "What kind of thing is it?", answer: "Desktop app" },
        { id: "vertical", question: "Where does it live?", answer: "Games" },
        { id: "name", question: "What's it called?", answer: "Stuff Thing" },
      ],
    },
    ctx,
  );
  assert.equal(second.ready, true);
  assert.equal(second.kind, "electron");
  assert.equal(second.vertical, "games");
  assert.equal(second.slug, "stuff-thing");
  assert.deepEqual(second.packages, ["electron-kit", "proc-kit"]);
  assert.match(second.note ?? "", /without Claude/);
});

test("a Not quite round asks deeper, with or without Claude", () => {
  const shown = fallbackPlan({ description: "an Electron app for my D&D campaign notes", name: "Campaign Notes" }, ctx);
  const prompt = planPrompt({ description: "an Electron app for my D&D campaign notes", answers: [{ id: "q1", question: "Where?", answer: "Games" }], more: shown }, ctx);
  assert.match(prompt, /said "Not quite"/);
  assert.match(prompt, /name: Campaign Notes/);
  assert.match(prompt, /new id \(not q1\)/);
  const deeper = fallbackPlan({ description: "an Electron app for my D&D campaign notes", more: shown }, ctx);
  assert.equal(deeper.ready, false);
  assert.equal(deeper.name, "Campaign Notes");
  assert.deepEqual(
    deeper.questions.map((q) => q.id),
    ["off", "must", "who", "feel", "else"],
  );
  const after = fallbackPlan(
    {
      description: "an Electron app for my D&D campaign notes",
      name: "Campaign Notes",
      answers: [
        { id: "must", question: "What's the one thing it has to do well?", answer: "Find any NPC in a second" },
        { id: "who", question: "Who's it for?", answer: "Just me" },
      ],
    },
    ctx,
  );
  assert.equal(after.ready, true);
  assert.deepEqual(after.features, ["Has to do one thing well: Find any NPC in a second", "For just me"]);
});

test("fallbackPlan takes his notes as the vision, a line each", () => {
  const plan = fallbackPlan(
    { description: "an Electron app for my D&D campaign notes", name: "Campaign Notes", answers: [{ id: "else", question: "Anything else?", answer: "- Dark theme\n- Works offline\n\n" }] },
    ctx,
  );
  assert.equal(plan.ready, true);
  assert.deepEqual(plan.features, ["Dark theme", "Works offline"]);
});

test("fallbackPlan reads the description when it says enough", () => {
  const plan = fallbackPlan({ description: "an Electron app for my D&D campaign notes, summarised by an LLM", name: "Campaign Notes" }, ctx);
  assert.equal(plan.ready, true);
  assert.equal(plan.kind, "electron");
  assert.equal(plan.vertical, "games");
  assert.ok(plan.packages.includes("llm-kit"));
});
