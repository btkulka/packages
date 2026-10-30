import { shortName } from "./catalogue.js";
import { KINDS, kindFromWords } from "./kinds.js";
import { ANYTHING_ELSE, defaultFirstSteps, findVertical, firstSentence, isNote, nameFromDescription, normalizePlan, packagesFor, slugify, uniqueSlug, verticalFromWords, type AppAnswer, type AppPlan, type AppQuestion, type PlanContext, type PlanRequest } from "./plan.js";
// The interview: Ben types what he wants, Claude plans it and asks the two
// or three things it can't decide, he answers, Claude finishes the plan. Every
// round ends on Anything else? (plan.ts's ANYTHING_ELSE), his own notes, which
// the prompt hands to Claude. The prompt and the JSON schema live here, so
// Benhäus (the Agent SDK) and a terminal (claude -p) ask the same way.
// fallbackPlan does the same without Claude, with fixed questions.

/** The shape Claude answers with (structured output). */
export const PLAN_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["name", "slug", "kind", "vertical", "summary", "features", "packages", "newPackage", "questions", "ready", "firstSteps"],
  properties: {
    name: { type: "string", description: "A short name, two words at most." },
    slug: { type: "string", description: "Its folder name: lowercase words joined by dashes." },
    kind: { type: "string", enum: KINDS.map((k) => k.id) },
    vertical: { type: "string", description: "One of the vertical ids listed." },
    summary: { type: "string", description: "One plain sentence: what it does." },
    features: { type: "array", items: { type: "string" }, description: "The vision in 3 to 6 short points: what it does and how it should feel." },
    packages: { type: "array", items: { type: "string" }, description: "Short names of the shared packages it builds on." },
    newPackage: {
      type: "object",
      additionalProperties: false,
      required: ["name", "why"],
      properties: { name: { type: "string" }, why: { type: "string" } },
      description: "A shared package that should exist and doesn't; empty strings when none is needed.",
    },
    questions: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "text", "options", "other"],
        properties: {
          id: { type: "string" },
          text: { type: "string" },
          options: { type: "array", items: { type: "string" } },
          other: { type: "boolean" },
        },
      },
    },
    ready: { type: "boolean" },
    firstSteps: { type: "array", items: { type: "string" } },
  },
} as const;

const list = (lines: string[]) => lines.map((l) => `- ${l}`).join("\n");
/** A multiline answer under its question, its later lines indented. */
const indent = (s: string) => s.trim().replace(/\r?\n/g, "\n  ");

/** The plan Ben was shown, for a Not quite round. */
const shownPlan = (p: AppPlan) =>
  list(
    [
      `name: ${p.name}`,
      `kind: ${p.kind}`,
      `vertical: ${p.vertical}`,
      `summary: ${p.summary}`,
      p.features.length ? `vision: ${p.features.join("; ")}` : "",
      `packages: ${p.packages.join(", ") || "none"}`,
      p.newPackage ? `new package: ${p.newPackage.name} (${p.newPackage.why})` : "",
    ].filter(Boolean),
  );

/** The rules for a Not quite round: questions that dig in and widen the plan, not ones that finish it. */
const moreRules = (answers: AppAnswer[]) =>
  [
    "This round:",
    "- Ben looked at the plan above and said \"Not quite\": it's close, and he wants to think it through further before it's built.",
    "- questions: 3 or 4 NEW questions that expand on the vision. Start with what's most off about the plan, its options naming the parts that might be wrong (other=true). Then whichever this app most needs: the one thing it has to do well, who it's for, how it should look and feel, what it works with or connects to, what it should leave out. Short and plain; 2 to 4 options each that are real, distinct directions, not variations; other=true where a typed answer helps.",
    `- Never repeat a question he answered.${answers.some((a) => a.id) ? ` Give every question a new id (not ${answers.flatMap((a) => (a.id ? [a.id] : [])).join(", ")}).` : ""}`,
    "- ready: false. Keep the rest of the plan as it stands, unless what he answered changes it.",
  ].join("\n");

/** The prompt that asks Claude for a plan (or, with answers, for the finished one; with `more`, for a deeper round). */
export function planPrompt(req: PlanRequest, ctx: PlanContext): string {
  const answers = req.answers ?? [];
  const parts = [
    "You're the planner behind the New app screen in Benhäus, Ben Kulka's desktop hub for everything he builds. Ben typed what he wants to make; turn it into a plan for a project in D:\\source, asking him only what you can't decide yourself.",
    `What Ben wants:\n"${req.description.trim()}"`,
    answers.length ? `What he answered so far:\n${list(answers.map((a) => `${a.question} → ${indent(a.answer)}`))}` : "",
    req.more ? `The plan he was shown:\n${shownPlan(req.more)}` : "",
    req.name ? `He calls it: ${req.name}` : "",
    `Kinds (choose one):\n${list(KINDS.map((k) => `${k.id}: ${k.name}. ${k.line}`))}`,
    `Verticals, the groups his tools sit in (choose one by id):\n${list(ctx.verticals.map((v) => `${v.id}: ${v.name}${v.line ? ` (${v.line})` : ""}`))}`,
    ctx.catalogue.length
      ? `Shared packages in BPM (D:\\source\\packages). Every new app builds on these wherever it can, instead of writing its own version:\n${list(ctx.catalogue.map((p) => `${shortName(p.name)}: ${p.description ?? ""}`.trim()))}`
      : "",
    ctx.taken.length ? `Folder names already taken: ${ctx.taken.join(", ")}.` : "",
    [
      "Rules:",
      "- Pick the kind, the vertical, a short name (two words at most) and a slug for its folder.",
      "- packages: every shared package the app should build on, by short name, and only those. Prefer them over new infrastructure code.",
      "- newPackage: when the app clearly needs shared code none of the packages has, and another of Ben's apps would use it too, name it (short, like media-kit) and say why in one sentence. Otherwise give empty strings.",
      `- questions: the 2 or 3 decisions you can't make from what he wrote, each a short plain question with 2 to 4 short options, and other=true when a typed answer makes sense. Don't ask what he already answered, what the description settles, or about tech the kind already decides. When nothing is open, ask none. The screen adds an open "${ANYTHING_ELSE.text}" after your questions, so don't ask a catch-all.`,
      answers.some(isNote) ? `- "${ANYTHING_ELSE.text}" is where he adds notes in his own words: fold them into the summary, the vision and firstSteps, treat what they settle as decided, and don't ask about it.` : "",
      "- ready: true when the plan is complete and there are no questions. After his answers it almost always is.",
      "- summary: one plain sentence saying what the app does, in his words where possible.",
      "- features: the vision in 3 to 6 short points: what it does and how it should feel, drawn from his words and every answer. Each answer should sharpen or add a point.",
      "- firstSteps: 3 to 5 concrete first milestones for the Claude Code session that builds it, in order.",
      "Write for Ben: plain, short, no hype.",
    ]
      .filter(Boolean)
      .join("\n"),
    req.more ? moreRules(answers) : "",
  ];
  return parts.filter(Boolean).join("\n\n");
}

/** A Not quite round without Claude: what's off, then what would make it his. */
const MORE_QUESTIONS: AppQuestion[] = [
  { id: "off", text: "What's most off?", options: ["The name", "What it does", "The kind of app", "Where it lives", "Nothing, just go deeper"], other: true },
  { id: "must", text: "What's the one thing it has to do well?", options: [], other: true },
  { id: "who", text: "Who's it for?", options: ["Just me", "Me and my team", "Fans or the public"], other: true },
  { id: "feel", text: "How should it feel?", options: ["Quick and quiet", "Rich and detailed", "Playful"], other: true },
];
/** The vision a plan without Claude takes from those answers. */
const MORE_POINTS: Record<string, (a: string) => string> = {
  must: (a) => `Has to do one thing well: ${a}`,
  who: (a) => `For ${a.charAt(0).toLowerCase()}${a.slice(1)}`,
  feel: (a) => `Feels ${a.charAt(0).toLowerCase()}${a.slice(1)}`,
};

const Q_KIND: AppQuestion = { id: "kind", text: "What kind of thing is it?", options: KINDS.map((k) => k.name), other: false };
const Q_NAME: AppQuestion = { id: "name", text: "What's it called?", options: [], other: true };

const answerTo = (answers: AppAnswer[], id: string, text: string) => answers.find((a) => a.id === id || a.question.trim().toLowerCase() === text.toLowerCase())?.answer;

/**
 * A plan without Claude: the kind, vertical and name from the description or
 * from fixed questions, the packages from the kind and the description's
 * words. The same shape, so the screen doesn't care which made it.
 */
export function fallbackPlan(req: PlanRequest, ctx: PlanContext, why?: string): AppPlan {
  const answers = req.answers ?? [];
  const description = req.description.trim();
  const note = why ? `Planned without Claude (${why}).` : "Planned without Claude.";
  if (req.more) {
    const open = MORE_QUESTIONS.filter((q) => !answerTo(answers, q.id, q.text));
    return normalizePlan({ ...req.more, questions: open, ready: false, note }, req, ctx);
  }
  const vision = MORE_QUESTIONS.flatMap((q) => {
    const a = answerTo(answers, q.id, q.text)?.trim();
    return a && MORE_POINTS[q.id] ? [MORE_POINTS[q.id](a)] : [];
  });
  // His notes (Anything else?), a point per line, as he wrote them.
  const notes = answers.filter(isNote).flatMap((a) =>
    a.answer
      .split(/\r?\n/)
      .map((l) => l.replace(/^[-*•]\s*/, "").trim())
      .filter(Boolean),
  );
  const kindAnswer = answerTo(answers, Q_KIND.id, Q_KIND.text);
  const kind = (kindAnswer && kindFromWords(kindAnswer)) || kindFromWords(description);
  const qVertical: AppQuestion = { id: "vertical", text: "Where does it live?", options: ctx.verticals.map((v) => v.name), other: false };
  const verticalAnswer = answerTo(answers, qVertical.id, qVertical.text);
  const vertical = (verticalAnswer && findVertical(verticalAnswer, ctx.verticals)?.id) || verticalFromWords(description, ctx.verticals);
  const nameAnswer = answerTo(answers, Q_NAME.id, Q_NAME.text);
  const name = req.name?.trim() || nameAnswer?.trim() || "";

  const questions: AppQuestion[] = [];
  if (!kind) questions.push(Q_KIND);
  if (!vertical && ctx.verticals.length) questions.push(qVertical);
  if (!name) questions.push({ ...Q_NAME, options: [nameFromDescription(description)] });
  const open = questions.filter((q) => !answers.some((a) => a.id === q.id));
  const finalKind = kind ?? "web";
  const finalName = name || nameFromDescription(description);
  return normalizePlan(
    {
      name: finalName,
      slug: uniqueSlug(slugify(finalName), ctx.taken),
      kind: finalKind,
      vertical: vertical ?? ctx.defaultVertical,
      summary: firstSentence(description),
      features: [...vision, ...notes],
      packages: packagesFor(finalKind, [], description, ctx.catalogue),
      questions: open,
      ready: open.length === 0,
      firstSteps: defaultFirstSteps(finalKind),
      note,
    },
    req,
    ctx,
  );
}
