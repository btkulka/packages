import assert from "node:assert/strict";
import { test } from "node:test";
import { addDaysIso, addTags, daysBetweenIso, formatAmount, hueFor, initials, isIso, mergePresence, parseAmount, reordered, sortRows, splitTags, stepValue, swipeOutcome } from "./logic.js";

test("parseAmount reads what people type", () => {
  assert.equal(parseAmount("2"), 2);
  assert.equal(parseAmount(" 1.5 "), 1.5);
  assert.equal(parseAmount("1,5"), 1.5);
  assert.equal(parseAmount(".5"), 0.5);
  assert.equal(parseAmount("1/2"), 0.5);
  assert.equal(parseAmount("1 1/2"), 1.5);
  assert.equal(parseAmount("1½"), 1.5);
  assert.equal(parseAmount("½"), 0.5);
  assert.equal(parseAmount(""), null);
  assert.equal(parseAmount("abc"), null);
  assert.equal(parseAmount("1/0"), null);
  assert.equal(parseAmount("-"), null);
});

test("stepValue lands on the grid and stays in range", () => {
  const o = { step: 0.5, min: 0, max: 10 };
  assert.equal(stepValue(1.3, 1, o), 1.5);
  assert.equal(stepValue(1.3, -1, o), 1);
  assert.equal(stepValue(1.5, 1, o), 2);
  assert.equal(stepValue(0, -1, o), 0);
  assert.equal(stepValue(10, 1, o), 10);
  assert.equal(stepValue(null, 1, o), 0.5);
  assert.equal(stepValue(null, 1, { step: 1, min: 1, max: 12 }), 1);
  assert.equal(stepValue(0.1 + 0.2, 1, { step: 0.1, min: 0, max: 1, precision: 2 }), 0.4);
  assert.equal(stepValue(15, 1, { step: 5, min: 0, max: 600 }), 20);
});

test("formatAmount drops trailing zeros", () => {
  assert.equal(formatAmount(2), "2");
  assert.equal(formatAmount(1.5), "1.5");
  assert.equal(formatAmount(1 / 3), "0.33");
  assert.equal(formatAmount(null), "");
});

test("splitTags and addTags", () => {
  assert.deepEqual(splitTags("pasta, quick;  vegetarian\nlunch,,"), ["pasta", "quick", "vegetarian", "lunch"]);
  const tags = ["pasta"];
  assert.equal(addTags(tags, ["Pasta"]), tags, "a duplicate leaves the same array");
  assert.deepEqual(addTags(tags, ["quick", "QUICK", " "]), ["pasta", "quick"]);
  assert.deepEqual(addTags([], ["a", "b", "c"], { max: 2 }), ["a", "b"]);
  assert.deepEqual(addTags([], ["Ben "], { transform: (t) => t.toLowerCase() }), ["ben"]);
});

test("swipeOutcome commits past the threshold or on a flick", () => {
  assert.equal(swipeOutcome(140, 0, 400), "start");
  assert.equal(swipeOutcome(-140, 0, 400), "end");
  assert.equal(swipeOutcome(60, 0.1, 400), null);
  assert.equal(swipeOutcome(60, 0.9, 400), "start", "a flick");
  assert.equal(swipeOutcome(20, 0.9, 400), null, "a flick too short");
  assert.equal(swipeOutcome(160, -0.5, 400), null, "flicked back");
  assert.equal(swipeOutcome(0, 1, 400), null);
});

test("mergePresence keeps leaving rows where they were", () => {
  assert.deepEqual(mergePresence(["a", "b", "c"], ["a", "c"], new Set()), ["a", "b", "c"]);
  assert.deepEqual(mergePresence(["a", "b", "c"], ["a", "c"], new Set(["b"])), ["a", "c"]);
  assert.deepEqual(mergePresence(["a", "b", "c"], ["b", "c"], new Set()), ["a", "b", "c"]);
  assert.deepEqual(mergePresence(["a", "b", "c"], ["c", "d"], new Set()), ["a", "b", "c", "d"]);
  assert.deepEqual(mergePresence(["a", "b"], ["x", "a"], new Set()), ["x", "a", "b"]);
  assert.deepEqual(mergePresence([], ["a"], new Set()), ["a"]);
});

test("reordered sees moves, not adds or removes", () => {
  assert.equal(reordered(["a", "b", "c"], ["a", "c"]), false);
  assert.equal(reordered(["a", "b"], ["a", "x", "b"]), false);
  assert.equal(reordered(["a", "b", "c"], ["b", "a", "c"]), true);
});

test("ISO days", () => {
  assert.equal(addDaysIso("2026-11-30", 1), "2026-12-01");
  assert.equal(addDaysIso("2026-03-08", 1), "2026-03-09", "across a DST change");
  assert.equal(daysBetweenIso("2026-11-16", "2026-11-23"), 7);
  assert.equal(daysBetweenIso("2026-11-16", "2026-11-15"), -1);
  assert.equal(isIso("2026-11-16"), true);
  assert.equal(isIso("2026-1-16"), false);
});

test("initials and hue", () => {
  assert.equal(initials("Kourtney Smith"), "KS");
  assert.equal(initials(" ben "), "B");
  assert.equal(initials("Ana María de la Cruz"), "AC");
  assert.equal(initials(""), "?");
  assert.equal(hueFor("Ben"), hueFor(" ben"));
  assert.ok(hueFor("Kourtney") >= 0 && hueFor("Kourtney") < 360);
});

test("token completion", async () => {
  const { currentToken, completeToken, rankSuggestions } = await import("./logic.js");
  assert.deepEqual(currentToken("2 avocados, spin"), { before: "2 avocados,", amount: " ", word: "spin" });
  assert.equal(currentToken("1 lb chick").amount, "1 lb ");
  assert.equal(currentToken("1 lb chick").word, "chick");
  assert.equal(currentToken("spi").word, "spi");
  assert.equal(completeToken("2 avocados, spin", "spinach"), "2 avocados, spinach, ");
  assert.equal(completeToken("1 lb chick", "chicken thighs"), "1 lb chicken thighs, ");
  assert.equal(completeToken("le", "lemons"), "lemons, ");
  assert.deepEqual(rankSuggestions("sp", ["spinach", "sparkling water", "asparagus", "red peppers", "spinach"]), ["spinach", "sparkling water"]);
  assert.deepEqual(rankSuggestions("pep", ["red peppers", "pepperoni", "jalapeño"]), ["pepperoni", "red peppers"]);
  assert.deepEqual(rankSuggestions("par", ["asparagus"]), ["asparagus"]);
  assert.deepEqual(rankSuggestions("", ["a"]), []);
});

test("sortRows: numbers by size, text as read, blanks last either way, ties stay put", () => {
  const rows = [
    { n: "item 10", v: 3 },
    { n: "Item 2", v: null },
    { n: "apple", v: 3 },
    { n: "", v: 1 },
    { n: "Éclair", v: Number.NaN },
  ];
  assert.deepEqual(sortRows(rows, (r) => r.n).map((r) => r.n), ["apple", "Éclair", "Item 2", "item 10", ""]);
  assert.deepEqual(sortRows(rows, (r) => r.n, "desc").map((r) => r.n), ["item 10", "Item 2", "Éclair", "apple", ""]);
  assert.deepEqual(sortRows(rows, (r) => r.v).map((r) => r.n), ["", "item 10", "apple", "Item 2", "Éclair"]);
  assert.deepEqual(sortRows(rows, (r) => r.v, "desc").map((r) => r.n), ["item 10", "apple", "", "Item 2", "Éclair"]);
  assert.deepEqual(sortRows([{ b: true }, { b: false }], (r) => r.b).map((r) => r.b), [false, true]);
});
