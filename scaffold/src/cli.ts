#!/usr/bin/env node
import { existsSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { readCatalogue } from "./catalogue.js";
import { renderProject } from "./files.js";
import { handoffPrompt } from "./handoff.js";
import { fallbackPlan } from "./interview.js";
import { KINDS } from "./kinds.js";
import { ANYTHING_ELSE, DEFAULT_VERTICALS, packagesFor, type AppAnswer, type PlanContext } from "./plan.js";
import { initGit, writeProject } from "./write.js";

// btkulka-scaffold: the New app screen from a terminal, without Claude. The
// kind, vertical and name come from flags; what's missing is asked for.

const USAGE = `Usage: btkulka-scaffold "<what it is>" [options]

  --kind <k>            ${KINDS.map((k) => k.id).join(" | ")}
  --name <name>         what it's called (its folder is the slug of this)
  --vertical <id>       ${DEFAULT_VERTICALS.map((v) => v.id).join(" | ")}
  --notes <text>        anything else, in your words (the interview's "Anything else?"; goes into the vision and the brief)
  --dir <path>          where apps live (default D:/source)
  --packages-home <p>   where the shared packages live (default <dir>/packages)
  --packages a,b        the BPM packages to build on (default: by kind and description)
  --no-git              skip git init and the first commit
  --dry-run             list the files without writing them
  --prompt              print the Claude Code hand-off prompt after
  --json                print the plan as JSON and stop`;

function folders(dir: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name.toLowerCase());
  } catch {
    return [];
  }
}

function main(argv: string[]) {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      kind: { type: "string" },
      name: { type: "string" },
      vertical: { type: "string" },
      notes: { type: "string" },
      dir: { type: "string" },
      "packages-home": { type: "string" },
      packages: { type: "string" },
      "no-git": { type: "boolean" },
      "dry-run": { type: "boolean" },
      prompt: { type: "boolean" },
      json: { type: "boolean" },
      help: { type: "boolean", short: "h" },
    },
  });
  const description = positionals.join(" ").trim();
  if (values.help || !description) {
    console.log(USAGE);
    return values.help ? 0 : 2;
  }
  const appsHome = resolve(values.dir ?? "D:/source");
  const packagesHome = resolve(values["packages-home"] ?? join(appsHome, "packages"));
  const catalogue = readCatalogue(packagesHome);
  const ctx: PlanContext = { catalogue, verticals: DEFAULT_VERTICALS, taken: [...folders(appsHome), ...folders(packagesHome)], defaultVertical: "utilities" };
  const answers: AppAnswer[] = [];
  if (values.kind) answers.push({ id: "kind", question: "What kind of thing is it?", answer: values.kind });
  if (values.vertical) answers.push({ id: "vertical", question: "Where does it live?", answer: values.vertical });
  if (values.notes) answers.push({ id: ANYTHING_ELSE.id, question: ANYTHING_ELSE.text, answer: values.notes });
  const plan = fallbackPlan({ description, answers, name: values.name }, ctx);
  if (values.packages) plan.packages = packagesFor(plan.kind, values.packages.split(","), description, catalogue);
  if (values.json) {
    console.log(JSON.stringify(plan, null, 2));
    return 0;
  }
  if (!plan.ready) {
    console.log("Still to decide (pass them as flags):");
    for (const q of plan.questions.filter((q) => !q.freeform)) console.log(`  --${q.id}  ${q.text}${q.options.length ? `  (${q.options.join(" | ")})` : ""}`);
    return 2;
  }
  const dir = plan.kind === "package" ? join(packagesHome, plan.slug) : join(appsHome, plan.slug);
  const files = renderProject(plan, { dir, packagesHome, catalogue });
  if (values["dry-run"]) {
    console.log(`${plan.name} (${plan.kind}, ${plan.vertical}) → ${dir}`);
    for (const f of files) console.log(`  ${f.path}`);
    return 0;
  }
  if (existsSync(dir)) {
    console.error(`${dir} already exists.`);
    return 1;
  }
  writeProject(dir, files);
  const committed = values["no-git"] ? false : initGit(dir);
  console.log(`Created ${plan.name} in ${dir} (${files.length} files${committed ? ", first commit made" : ""}).`);
  if (plan.packages.length) console.log(`Builds on: ${plan.packages.join(", ")}.`);
  if (values.prompt) console.log(`\n${handoffPrompt(plan, { dir, packagesHome, catalogue })}`);
  return 0;
}

process.exitCode = main(process.argv.slice(2));
