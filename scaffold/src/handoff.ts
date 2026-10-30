import { findPackage, type CatalogueEntry } from "./catalogue.js";
import { kindOf } from "./kinds.js";
import type { AppPlan } from "./plan.js";

// The message that starts the Claude Code session in the new folder: the
// brief, the decisions, the packages to build on and where to begin. CLAUDE.md
// says the same, so a later session has it too.

export interface HandoffContext {
  dir: string;
  packagesHome: string;
  catalogue: CatalogueEntry[];
  /** Whether the packages' dist/ folders are built (they load from there). */
  packagesBuilt?: boolean;
}

const win = (p: string) => p.replace(/\//g, "\\");

export function handoffPrompt(plan: AppPlan, ctx: HandoffContext): string {
  const kind = kindOf(plan.kind);
  const pkgs = plan.packages.map((n) => {
    const e = findPackage(n, ctx.catalogue);
    return e ? `- ${e.name}: ${e.description ?? ""}`.trimEnd() : `- ${n}`;
  });
  const isPackage = plan.kind === "package";
  const steps = [
    ctx.packagesBuilt === false && !isPackage ? `npm run build in ${win(ctx.packagesHome)} first: the linked packages load from dist/, which isn't built yet.` : "",
    isPackage
      ? `npm install in ${win(ctx.packagesHome)} (take the lock: mkdir .npm-lock first, remove it after), then npm run build there.`
      : "npm install here, then confirm the scaffold runs.",
    "Read CLAUDE.md (the brief) and README.md, then confirm the plan back to me in a few lines before building.",
    ...plan.firstSteps.filter((s) => !/^npm install/i.test(s)),
    isPackage
      ? "Replace icon.svg (a placeholder monogram) with a real icon designed with Claude Design, in the Benhäus app-icon style; BPM draws it."
      : `Replace icon.svg (a placeholder monogram) with a real icon designed with Claude Design, in the Benhäus app-icon style, tinted for the ${plan.vertical} vertical; it's already wired as this tool's logo in Benhäus.`,
  ];
  return [
    `We're starting ${plan.name} in ${win(ctx.dir)}. Benhäus's New app screen just scaffolded it (${kind?.name.toLowerCase() ?? plan.kind}, in the ${plan.vertical} vertical); nothing is installed yet.`,
    `What it is: ${plan.summary}`,
    plan.features.length ? `The vision:\n${plan.features.map((f) => `- ${f}`).join("\n")}` : "",
    `What I asked for, in my words: "${plan.description.trim()}"`,
    plan.answers.length ? `Decided in the interview:\n${plan.answers.map((a) => `- ${a.question} → ${a.answer.trim().replace(/\r?\n/g, "\n  ")}`).join("\n")}` : "",
    `Build on the shared packages in BPM (${win(ctx.packagesHome)}; benhaus list_packages and search_code over MCP). ${pkgs.length ? `This project already depends on these, linked with file: paths:\n${pkgs.join("\n")}` : "None fit yet; use one as soon as one does."}`,
    "Always prefer a BPM package over writing infrastructure here (processes and ports, SQLite, LLM calls, media, MCP plumbing, Electron scaffolding, API clients). When something here is clearly reusable by another of my apps, make it a package in the packages home (dual ESM+CJS like the others, with an icon.svg designed with Claude Design in the Benhäus app-icon style), depend on it here, and delete the copy it replaces.",
    plan.newPackage ? `The plan calls for a new package first: ${plan.newPackage.name} — ${plan.newPackage.why}` : "",
    `First steps:\n${steps
      .filter(Boolean)
      .map((s, i) => `${i + 1}. ${s}`)
      .join("\n")}`,
    isPackage ? "BPM in Benhäus lists this package on its own." : `Benhäus already lists it as the tool "${plan.slug}"; its page shows this folder, its git state and how it opens.`,
  ]
    .filter(Boolean)
    .join("\n\n");
}
