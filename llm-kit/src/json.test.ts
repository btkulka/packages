import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  createThinkFilter,
  extractJson,
  extractJsonValues,
  parseJsonLoose,
  repairJson,
  stripCodeFences,
  stripThinking,
} from "./json.js";

describe("stripThinking", () => {
  it("removes every closed think block, in any case, and trims", () => {
    assert.equal(stripThinking("<think>plan</think>  Hello <THINK>more\nlines</Think> there "), "Hello  there");
  });
  it("leaves an unclosed <think> alone (orson's behaviour)", () => {
    assert.equal(stripThinking("<think>never closed"), "<think>never closed");
  });
});

describe("stripCodeFences", () => {
  it("unwraps the first fenced block, tagged or not", () => {
    assert.equal(stripCodeFences('Here:\n```json\n{"a":1}\n```\nthanks'), '{"a":1}');
    assert.equal(stripCodeFences('```\n[1,2]\n```'), "[1,2]");
    assert.equal(stripCodeFences("```JSON {\"a\":2}```"), '{"a":2}');
  });
  it("returns the trimmed text when there is no fence", () => {
    assert.equal(stripCodeFences('  {"a":1} '), '{"a":1}');
  });
});

describe("createThinkFilter", () => {
  const run = (chunks: string[]) => {
    const f = createThinkFilter();
    return chunks.map((c) => f.push(c)).join("") + f.flush();
  };
  it("passes text outside think blocks", () => {
    assert.equal(run(["Hi <think>secret</think>there"]), "Hi there");
  });
  it("handles a tag split across chunks (orson's filter leaked these)", () => {
    assert.equal(run(["Hi <thi", "nk>sec", "ret</th", "ink> there"]), "Hi  there");
    assert.equal(run(["a<", "think>x</think>b"]), "ab");
  });
  it("matches tags in any case", () => {
    assert.equal(run(["<THINK>x</Think>ok"]), "ok");
  });
  it("releases a held-back '<' that never became a tag, and drops an unfinished block", () => {
    const f = createThinkFilter();
    assert.equal(f.push("a < b <"), "a < b ");
    assert.equal(f.flush(), "<");
    const g = createThinkFilter();
    assert.equal(g.push("x<think>never ends"), "x");
    assert.equal(g.flush(), "");
  });
  it("emits each visible piece as it arrives", () => {
    const f = createThinkFilter();
    assert.deepEqual(["one ", "two", "<think>", "x", "</think>", " three"].map((c) => f.push(c)), ["one ", "two", "", "", "", " three"]);
  });
});

describe("extractJson", () => {
  it("returns a nested object whole (orson's lazy regex stopped at the first })", () => {
    const t = 'The DM says {"skill":"stealth","detail":{"dc":12,"tags":["a"]}} ok';
    assert.equal(extractJson(t), '{"skill":"stealth","detail":{"dc":12,"tags":["a"]}}');
  });
  it("is string-aware: braces and quotes inside strings don't count", () => {
    const t = 'x {"text":"a } b { c \\" }"} y';
    assert.deepEqual(JSON.parse(extractJson(t)!), { text: 'a } b { c " }' });
  });
  it("skips prose braces before the real object", () => {
    assert.equal(extractJson('Fill the {template} like this: {"a":1}'), '{"a":1}');
  });
  it("finds arrays when asked, and either with 'any'", () => {
    assert.equal(extractJson('claims: ["a", "b"] done', "array"), '["a", "b"]');
    assert.equal(extractJson('claims: [] done', "array"), "[]");
    assert.equal(extractJson('x [1] {"a":1}', "any"), "[1]");
    assert.equal(extractJson('x {"a":[1]}', "array"), "[1]");
  });
  it("returns null for a truncated reply or no JSON (orson's tests)", () => {
    assert.equal(extractJson('{"dc":12,"ability":"cha"'), null);
    assert.equal(extractJson("no object here"), null);
  });
  it("falls back to the first balanced candidate when nothing parses", () => {
    assert.equal(extractJson("{not json} and {also: not}"), "{not json}");
  });
});

describe("extractJsonValues", () => {
  it("collects every top-level object from a chatty reply", () => {
    assert.deepEqual(extractJsonValues('Here {"a":1} and here {"b":{"c":2}} bye'), [{ a: 1 }, { b: { c: 2 } }]);
  });
  it("salvages the complete items of a truncated array", () => {
    assert.deepEqual(extractJsonValues('[{"a":1},{"b":2},{"c":'), [{ a: 1 }, { b: 2 }]);
  });
  it("salvages items inside a truncated wrapper too", () => {
    assert.deepEqual(extractJsonValues('{"beats":[{"a":1},{"b":2},{"c":3'), [{ a: 1 }, { b: 2 }]);
  });
  it("keeps a complete wrapper whole", () => {
    assert.deepEqual(extractJsonValues('{"beats":[{"a":1}]}'), [{ beats: [{ a: 1 }] }]);
  });
  it("collects arrays when asked", () => {
    assert.deepEqual(extractJsonValues("[1] text [2,3]", "array"), [[1], [2, 3]]);
  });
});

describe("repairJson", () => {
  it("escapes raw control characters inside strings, keeping the text", () => {
    const fixed = repairJson('{"line":"one\ntwo\tthree"}');
    assert.deepEqual(JSON.parse(fixed), { line: "one\ntwo\tthree" });
  });
  it("escapes a lone backslash and leaves valid escapes alone", () => {
    assert.deepEqual(JSON.parse(repairJson('{"p":"C:\\dir","ok":"a\\\\b\\"c\\n"}')), { p: "C:\\dir", ok: 'a\\b"c\n' });
  });
  it("turns other control characters outside strings into spaces", () => {
    assert.deepEqual(JSON.parse(repairJson('{\u0001"a":1}')), { a: 1 });
  });
});

describe("parseJsonLoose", () => {
  it("parses fenced JSON with prose around it", () => {
    assert.deepEqual(parseJsonLoose('Sure!\n```json\n{"mood":"calm"}\n```\nAnything else?'), { mood: "calm" });
  });
  it("parses an object out of prose (starfall's first-{-to-last-} case)", () => {
    assert.deepEqual(parseJsonLoose('Okay. {"a":1} Hope that helps.'), { a: 1 });
  });
  it("strips think blocks first, even ones holding braces", () => {
    assert.deepEqual(parseJsonLoose('<think>maybe {"a":0}?</think>{"a":1}'), { a: 1 });
  });
  it("repairs raw newlines and lone backslashes (what Haiku emits)", () => {
    assert.deepEqual(parseJsonLoose('{"say":"Line one\nLine two \\o/"}'), { say: "Line one\nLine two \\o/" });
  });
  it("takes the object out of an array when an object is wanted", () => {
    assert.deepEqual(parseJsonLoose('[{"a":1}]'), { a: 1 });
    assert.deepEqual(parseJsonLoose('[{"a":1}]', "array"), [{ a: 1 }]);
  });
  it("looks outside a fenced block that isn't JSON", () => {
    assert.deepEqual(parseJsonLoose('```\nnot json\n```\n{"a":1}'), { a: 1 });
  });
  it("throws the original SyntaxError when nothing parses", () => {
    assert.throws(() => parseJsonLoose('{"a":1,'), SyntaxError);
    assert.throws(() => parseJsonLoose("just words"), SyntaxError);
    assert.throws(() => parseJsonLoose('"a string"'), /No JSON object found/);
  });
});
