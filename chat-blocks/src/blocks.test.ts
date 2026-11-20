import assert from "node:assert/strict";
import { test } from "node:test";
import { answerFor, checkSpec, expiredOutcome, outcomeOf, outcomeText, pickWords, readOutcome, settled, shownOutcome, type BlockSpec, type ChatBlock } from "./blocks.js";

const pick: BlockSpec = checkSpec({ kind: "pick", title: "Which harbor?", props: { images: ["D:\\a.png", { ref: "D:\\b.png", alt: "the misty harbor" }, { path: "data:image/png;base64,AA", alt: "inline" }] } });

test("checkSpec tidies a pick's images and refuses a bad spec in words Claude can act on", () => {
  assert.deepEqual(pick.props, { images: [{ ref: "D:\\a.png" }, { ref: "D:\\b.png", alt: "the misty harbor" }, { ref: "data:image/png;base64,AA", alt: "inline" }] });
  assert.throws(() => checkSpec({ kind: "pick", props: { images: [] } }), /images: give at least one/);
  assert.throws(() => checkSpec({ kind: "choice", props: { options: [{}] } }), /options\[0\]: needs a label/);
  assert.throws(() => checkSpec({ kind: "form", props: { fields: [{ name: "x", type: "select" }] } }), /a select needs options/);
  assert.throws(() => checkSpec({ kind: "ui://gallery/picker" }), /say which app/);
  assert.throws(() => checkSpec({ kind: "pick me!" }), /not a kind/);
  assert.throws(() => checkSpec({}), /needs a kind/);
  assert.deepEqual(checkSpec({ kind: "ui://gallery/picker", app: "gallery", props: { n: 1 } }), { kind: "ui://gallery/picker", app: "gallery", props: { n: 1 } });
});

test("a pick says what was picked the way the carousel always has, without a data: address", () => {
  assert.equal(answerFor(pick, { value: 1 }).said, "Picked 2 of 3: the misty harbor (D:\\b.png)");
  assert.deepEqual(answerFor(pick, { value: { index: 1 } }).value, { index: 1, ref: "D:\\b.png", alt: "the misty harbor" });
  assert.equal(answerFor(pick, { value: 2 }).said, "Picked 3 of 3: inline");
  assert.throws(() => answerFor(pick, { value: 5 }), /No image 6/);
  assert.equal(pickWords([{ ref: "x.png" }], 0), "Picked 1 of 1 (x.png)");
});

test("a multi pick answers a list", () => {
  const multi = checkSpec({ kind: "pick", props: { multi: true, images: [{ ref: "a.png", alt: "A" }, { ref: "b.png" }] } });
  const a = answerFor(multi, { value: [0, 1] });
  assert.deepEqual(a.value, [{ index: 0, ref: "a.png", alt: "A" }, { index: 1, ref: "b.png" }]);
  assert.equal(a.said, "Picked 1, 2 of 2: A (a.png); #2 (b.png)");
});

test("a grouped pick answers one entry per group, skipped ones said as skipped", () => {
  const g = checkSpec({
    kind: "pick",
    props: {
      groups: [
        { label: "Chair", images: [{ ref: "c1.png", alt: "oak" }, { ref: "c2.png", alt: "steel" }] },
        { label: "Lamp", images: ["l1.png", "l2.png"] },
        { title: "Rugs", multi: true, images: ["r1.png", "r2.png", "r3.png"] },
      ],
    },
  });
  assert.equal((g.props!.groups as { label: string }[])[2].label, "Rugs");
  const a = answerFor(g, { value: [1, null, [0, 2]] });
  assert.deepEqual(a.value, [
    { group: "Chair", index: 1, ref: "c2.png", alt: "steel" },
    { group: "Lamp", skipped: true },
    { group: "Rugs", picks: [{ index: 0, ref: "r1.png" }, { index: 2, ref: "r3.png" }] },
  ]);
  assert.equal(a.said, "Chair: picked 2 of 2: steel (c2.png)\nLamp: skipped\nRugs: picked 1 of 3 (r1.png); picked 3 of 3 (r3.png)");
  assert.throws(() => answerFor(g, { value: [null, null, []] }), /at least one group/);
  assert.throws(() => answerFor(g, { value: [0] }), /one entry per group \(3\)/);
  assert.throws(() => answerFor(g, { value: [[0, 1], null, null] }), /Chair: pick one/);
});

test("choice, confirm, form and questions check their values and say them", () => {
  const choice = checkSpec({ kind: "choice", props: { options: ["Red", { label: "Blue", description: "calmer" }] } });
  assert.deepEqual(answerFor(choice, { value: "Blue" }), { value: "Blue", said: 'Chose "Blue"' });
  assert.deepEqual(answerFor(choice, { value: 0 }), { value: "Red", said: 'Chose "Red"' });
  assert.throws(() => answerFor(choice, { value: "Green" }), /isn't one of the options/);
  const many = checkSpec({ kind: "choice", props: { multi: true, options: ["a", "b", "c"] } });
  assert.deepEqual(answerFor(many, { value: ["a", "c"] }), { value: ["a", "c"], said: 'Chose "a", "c"' });

  const confirm = checkSpec({ kind: "confirm", props: { yes: "Delete them", danger: true } });
  assert.deepEqual(answerFor(confirm, { value: true }), { value: true, said: 'Yes: "Delete them"' });
  assert.deepEqual(answerFor(confirm, { value: false }), { value: false, said: 'No: "No"' });
  assert.throws(() => answerFor(confirm, { value: "yes" }), /true or false/);

  const form = checkSpec({ kind: "form", props: { fields: [{ name: "title", required: true }, { name: "count", type: "number" }, { name: "pub", type: "checkbox", label: "Publish" }, { name: "size", type: "select", options: ["S", "M"] }] } });
  assert.deepEqual(answerFor(form, { value: { title: "Hi", count: "3", pub: true, size: "M" } }), { value: { title: "Hi", count: 3, pub: true, size: "M" }, said: "title: Hi; count: 3; Publish: true; size: M" });
  assert.throws(() => answerFor(form, { value: { count: 2 } }), /title is needed/);
  assert.throws(() => answerFor(form, { value: { title: "x", count: "lots" } }), /count has to be a number/);
  assert.throws(() => answerFor(form, { value: { title: "x", size: "XL" } }), /isn't one of its choices/);

  const qs = checkSpec({ kind: "questions", props: { questions: [{ question: "Which library?", header: "Library", options: ["date-fns", "dayjs"] }, { question: "Which parts?", multiSelect: true, options: ["a", "b"] }] } });
  assert.deepEqual(answerFor(qs, { value: { "Which library?": "dayjs", "Which parts?": ["a", "b"] } }), {
    value: { "Which library?": "dayjs", "Which parts?": "a, b" },
    said: "Which library? → dayjs\nWhich parts? → a, b",
  });
});

test("words typed in the chat's box answer any block", () => {
  assert.deepEqual(answerFor(pick, { text: " neither, make a new one " }), { text: "neither, make a new one", said: 'Answered in words instead: "neither, make a new one"' });
  assert.throws(() => answerFor(pick, {}), /a value or words/);
});

test("an app page's answer is its value, said in its own words", () => {
  const app = checkSpec({ kind: "ui://gallery/picker", app: "gallery" });
  assert.deepEqual(answerFor(app, { value: { ids: [3] }, text: "Picked #3" }), { value: { ids: [3] }, text: "Picked #3", said: "Picked #3" });
  assert.deepEqual(answerFor(app, { value: { ids: [3] } }), { value: { ids: [3] }, said: 'Answered: {"ids":[3]}' });
});

test("outcomes go to Claude as JSON and read back onto the block", () => {
  const a = answerFor(pick, { value: 1 });
  const text = outcomeText(outcomeOf(a));
  assert.deepEqual(JSON.parse(text), { answered: true, value: { index: 1, ref: "D:\\b.png", alt: "the misty harbor" }, said: "Picked 2 of 3: the misty harbor (D:\\b.png)" });
  const block: ChatBlock = { ...pick, id: "toolu_1", state: "waiting" };
  assert.deepEqual(settled(block, readOutcome(text)!), { ...block, state: "answered", reason: undefined, answer: { value: a.value, said: a.said } });
  const gone = readOutcome(outcomeText(expiredOutcome("Ben stopped the turn.")))!;
  assert.deepEqual(settled(block, gone), { ...block, state: "expired", reason: "Ben stopped the turn.", answer: undefined });
  assert.equal(readOutcome("Picked 2 of 3"), undefined);
  // Put up to look at: nothing to answer, read back as shown.
  assert.deepEqual(settled(block, readOutcome(outcomeText(shownOutcome))!), { ...block, state: "shown", reason: undefined, answer: undefined });
  assert.equal(readOutcome('{"other": true}'), undefined);
  assert.equal(readOutcome("{nope"), undefined);
});
