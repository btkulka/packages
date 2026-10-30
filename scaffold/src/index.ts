// @btkulka/scaffold: a new app of Ben's, planned, written and handed to Claude Code.
export { findPackage, readCatalogue, shortName, suggestPackages, type CatalogueEntry } from "./catalogue.js";
export { linkSpec, packageDeps, packageNames, renderProject, type ProjectFile, type RenderContext } from "./files.js";
export { handoffPrompt, type HandoffContext } from "./handoff.js";
export { ICON_TINTS, appIconSvg, monogram } from "./icon.js";
export { PLAN_SCHEMA, fallbackPlan, planPrompt } from "./interview.js";
export { KINDS, kindFromWords, kindOf, type AppKind, type KindDef } from "./kinds.js";
export {
  ANYTHING_ELSE,
  DEFAULT_VERTICALS,
  defaultFirstSteps,
  findVertical,
  firstSentence,
  isNote,
  nameFromDescription,
  normalizePlan,
  packagesFor,
  slugify,
  uniqueSlug,
  verticalFromWords,
  type AppAnswer,
  type AppPlan,
  type AppQuestion,
  type PlanContext,
  type PlanRequest,
  type VerticalInfo,
} from "./plan.js";
export { initGit, isTaken, writeProject } from "./write.js";
