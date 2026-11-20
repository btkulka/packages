import { checkProps, checkSpec, questionWords, readOutcome, type BlockOutcome, type BlockSpec, type ChatBlock } from "@btkulka/chat-blocks";

// Embedded chat blocks (@btkulka/chat-blocks) on the host's side: the
// await_feedback tool each chat's session gets (an in-process SDK MCP server,
// whose call stays open until the block is answered), Claude Code's
// AskUserQuestion as a questions block, and both read back onto their tool rows.

export const BLOCK_SERVER = "blocks";
export const BLOCK_TOOL = "await_feedback";
/** The tool as Claude Code names it. */
export const BLOCK_TOOL_NAME = `mcp__${BLOCK_SERVER}__${BLOCK_TOOL}`;
export const ASK_TOOL = "AskUserQuestion";

export const BLOCK_TOOL_DESCRIPTION = [
  "Puts a block in the chat for the person to answer and waits for the answer: pick an image, choose, confirm, or fill in a few fields. Returns JSON: {answered: true, value, said} (said is the answer in words; text instead of value when they typed a reply), or {expired: true, reason} when they stopped the turn, sent a message instead or the time ran out.",
  "Use it whenever you'd otherwise ask a question and stop: the answer comes straight back to you, in this turn.",
  "kinds and their props:",
  '- pick: {images: [{ref, alt}]} (ref: a file path, an https or data: address; alt: what it is), one carousel; answered {index, ref, alt}. multi: true picks several (a list). For many sets at once, {groups: [{label, images, multi?}]}: one carousel per group, picked one group at a time and sent together; answered as one entry per group ({group, index, ref, alt}, {group, picks: [...]} for multi, or {group, skipped: true}).',
  "- choice: {options: [{label, description}], multi?}; answered with the label (a list with multi).",
  "- confirm: {yes?, no?, danger?}; answered true or false.",
  '- form: {fields: [{name, label, type: "text"|"textarea"|"number"|"select"|"checkbox", options (select), required, placeholder, value}], submit?}; answered with the values by name.',
  "An app's own page: kind is the ui:// address of a page the app's MCP server serves (MCP Apps), app is that server's name, props go to the page; answered with whatever the page sends.",
  "title says what's being asked; body adds a line or two. timeoutS ends the wait (no timeout by default).",
  "wait: false puts a block up to look at, with nothing to answer (an app page showing videos or models to watch, say): the call returns {shown: true} at once and the block stays in the chat.",
].join("\n");

/** The tool's arguments, as zod (the SDK's tool() wants a zod shape). */
export function blockToolShape(z: ZodLike) {
  return {
    kind: z.string().describe('pick, choice, confirm or form; or an app page\'s ui:// address (with app)'),
    title: z.string().optional().describe("What's being asked, as the block's heading."),
    body: z.string().optional().describe("A line or two under the title."),
    props: z.record(z.string(), z.unknown()).optional().describe("The kind's props (see the description)."),
    app: z.string().optional().describe("For an app page: the MCP server that serves its ui:// address."),
    timeoutS: z.number().positive().optional().describe("Seconds to wait before giving up; no limit by default."),
    wait: z.boolean().optional().describe("false: put it up to look at and go on (nothing to answer); the call returns at once."),
  };
}

/** The parts of zod the shape uses. */
export interface ZodLike {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  string(): any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  number(): any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  boolean(): any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  unknown(): any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  record(k: any, v: any): any;
}

/** Claude Code's AskUserQuestion input as a questions block, or undefined when it doesn't read as one. */
export function questionsBlock(id: string, input: Record<string, unknown>): ChatBlock | undefined {
  try {
    const props = checkProps("questions", input);
    const qs = props.questions as { question: string; header?: string }[];
    return { id, kind: "questions", title: qs.length === 1 ? qs[0].question : "A few questions", props, state: "waiting" };
  } catch {
    return undefined;
  }
}

/** A tool call's block, if it's one: await_feedback's spec, or AskUserQuestion's questions. */
export function blockOf(name: string, id: string, input: unknown): ChatBlock | undefined {
  if (name === ASK_TOOL) return questionsBlock(id, (input ?? {}) as Record<string, unknown>);
  if (name !== BLOCK_TOOL_NAME) return undefined;
  try {
    return { ...checkSpec(input), id, state: "waiting" };
  } catch {
    return undefined;
  }
}

/** "Q"="A" pairs, the way Claude Code's AskUserQuestion result lists answers. */
const PAIRS = /"((?:[^"\\]|\\.)+)"\s*=\s*"((?:[^"\\]|\\.)*)"/g;

/**
 * A block call's result, read back: await_feedback's JSON, or AskUserQuestion's
 * answers ("Q"="A" pairs). An error result is the block cut short, its text the reason.
 */
export function outcomeFrom(block: ChatBlock, text: string, isError?: boolean): BlockOutcome | undefined {
  if (isError) return { expired: true, reason: text.trim() || "It ended without an answer." };
  if (block.kind !== "questions") return readOutcome(text);
  const answers: Record<string, string> = {};
  for (const m of text.matchAll(PAIRS)) answers[m[1]] = m[2];
  if (!Object.keys(answers).length) return text.trim() ? { answered: true, said: text.trim() } : undefined;
  return { answered: true, value: answers, said: questionWords(answers) };
}

/** What AskUserQuestion is given back as the person's answers: by question, words typed in the box answering each. */
export function questionAnswers(block: BlockSpec, o: { value?: unknown; text?: string }): Record<string, string> {
  const qs = ((block.props?.questions as { question: string }[] | undefined) ?? []).map((q) => q.question);
  if (o.value && typeof o.value === "object") return o.value as Record<string, string>;
  return Object.fromEntries(qs.map((q) => [q, o.text ?? ""]));
}
