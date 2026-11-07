import assert from "node:assert/strict";
import { test } from "node:test";
import { CLI_DEFAULTS, JobError, parseJobs, promptJob, slug } from "./jobs.js";

test("jobs take the defaults for what they leave out", () => {
  const [a, b] = parseJobs([
    { name: "bar-01", prompt: "A neon bar, phone footage" },
    { name: "club-02", prompt: "A packed club", aspect: "16:9", resolution: "1080P", seconds: "6", model: "models/gemini-omni-1.1-flash", seed: 7, negativePrompt: "text" },
  ]);
  assert.deepEqual(a, { name: "bar-01", prompt: "A neon bar, phone footage", negativePrompt: undefined, aspect: "9:16", resolution: "720p", seconds: undefined, model: "gemini-omni-1.1-flash", seed: undefined, image: undefined });
  assert.equal(b!.aspect, "16:9");
  assert.equal(b!.resolution, "1080p");
  assert.equal(b!.seconds, 6);
  assert.equal(b!.model, "gemini-omni-1.1-flash");
  assert.equal(b!.seed, 7);
});

test("{ jobs: [...] } works, and the command line's defaults apply", () => {
  const [j] = parseJobs({ jobs: [{ prompt: "Bartender pours a drink" }] }, { ...CLI_DEFAULTS, seconds: 8, negativePrompt: "logos" });
  assert.equal(j!.name, "bartender-pours-a-drink");
  assert.equal(j!.seconds, 8);
  assert.equal(j!.negativePrompt, "logos");
});

test("bad jobs are refused with the job named", () => {
  const bad: unknown[] = [
    "nope",
    [],
    [{ name: "a" }],
    [{ name: "a", prompt: "x", aspect: "1:1" }],
    [{ name: "a", prompt: "x", resolution: "8k" }],
    [{ name: "a", prompt: "x", seconds: 11 }],
    [{ name: "a", prompt: "x", seconds: "eight" }],
    [{ name: "../escape", prompt: "x" }],
    [{ name: "con", prompt: "x" }],
    [{ name: "a", prompt: "x", colour: "red" }],
    [{ name: "Clip", prompt: "x" }, { name: "clip", prompt: "y" }],
  ];
  for (const json of bad) assert.throws(() => parseJobs(json), JobError, JSON.stringify(json));
});

test("a prompt job is named from its first words", () => {
  assert.equal(promptJob("Crowd at a nightclub, phone footage", undefined, 3, undefined).name, "crowd-at-a-nightclub-phone-footage");
  assert.equal(promptJob("x", "my clip", undefined, "start.png").image, "start.png");
  assert.equal(slug("A very long prompt about a dimly lit cocktail bar with people laughing"), "a-very-long-prompt-about-a-dimly-lit");
  assert.equal(slug("!!!"), "clip");
});
