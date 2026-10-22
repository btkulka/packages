import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { parseJson, parseJsonArray, parseJsonObject } from "./index.js";

describe("parseJson", () => {
  test("parses, and falls back on missing, empty, malformed and JSON null", () => {
    assert.deepEqual(parseJson('{"a":1}', {}), { a: 1 });
    assert.equal(parseJson("5", 0), 5);
    assert.equal(parseJson('"s"', ""), "s");
    for (const missing of [null, undefined, "", "   "]) assert.equal(parseJson(missing, "fb"), "fb");
    assert.equal(parseJson("{not json", "fb"), "fb");
    assert.equal(parseJson("null", "fb"), "fb");
    assert.equal(parseJson("null", null), null);
  });

  test("reads a Buffer as UTF-8 text", () => {
    assert.deepEqual(parseJson(Buffer.from('["é"]', "utf8"), []), ["é"]);
  });

  test("numbers stored in a JSON column come back as numbers", () => {
    assert.equal(parseJson(12, 0), 12);
  });
});

describe("parseJsonArray", () => {
  test("only an array passes", () => {
    assert.deepEqual(parseJsonArray('["a","b"]'), ["a", "b"]);
    assert.deepEqual(parseJsonArray('{"a":1}'), []);
    assert.deepEqual(parseJsonArray("nope"), []);
    assert.deepEqual(parseJsonArray(null, ["d"]), ["d"]);
    assert.deepEqual(parseJsonArray("[]", ["d"]), [], "an empty array is a real value");
  });
});

describe("parseJsonObject", () => {
  test("only a plain object passes", () => {
    assert.deepEqual(parseJsonObject('{"a":1}', {}), { a: 1 });
    assert.deepEqual(parseJsonObject("[1]", { d: 1 }), { d: 1 });
    assert.deepEqual(parseJsonObject("3", { d: 1 }), { d: 1 });
    assert.deepEqual(parseJsonObject("{bad", { d: 1 }), { d: 1 });
    assert.deepEqual(parseJsonObject(undefined, { d: 1 }), { d: 1 });
  });
});
