import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { checkArgs } from "./args.js";

// The schema shape Benhäus's tools use: schema(properties, required) with additionalProperties: false.
const schema = {
  type: "object",
  properties: {
    id: { type: "string" },
    width: { type: "number" },
    count: { type: "integer" },
    pinned: { type: "boolean" },
    mode: { type: "string", enum: ["always", "daily", "off"] },
    ids: { type: "array", items: { type: "string" } },
    priority: { type: "array", items: { type: "number", enum: [1, 2, 3, 4] } },
    calendars: { type: "object" },
    when: { type: ["string", "null"] },
  },
  required: ["id"],
  additionalProperties: false,
};

describe("checkArgs", () => {
  it("passes good arguments", () => {
    assert.equal(checkArgs(schema, { id: "a", width: 2, count: 3, pinned: true, mode: "daily", ids: ["x"], priority: [1, 4], calendars: { c: true }, when: null }), undefined);
  });

  it("treats a missing or null required key as missing", () => {
    assert.equal(checkArgs(schema, {}), "id is required.");
    assert.equal(checkArgs(schema, { id: null }), "id is required.");
  });

  it("names unknown arguments and the expected ones when additionalProperties is false", () => {
    assert.equal(checkArgs(schema, { id: "a", nope: 1 }), `Unknown argument nope. Expected: ${Object.keys(schema.properties).join(", ")}.`);
    assert.equal(checkArgs({ type: "object", properties: {}, additionalProperties: false }, { x: 1 }), "Unknown argument x. Expected: none.");
  });

  it("ignores unknown arguments otherwise", () => {
    assert.equal(checkArgs({ type: "object", properties: {} }, { x: 1 }), undefined);
    assert.equal(checkArgs({ type: "object" }, { x: 1 }), undefined);
  });

  it("reports type mismatches the way Benhäus did", () => {
    assert.equal(checkArgs(schema, { id: 5 }), "id should be a string, not a number.");
    assert.equal(checkArgs(schema, { id: "a", ids: "x" }), "ids should be a array, not a string.");
    assert.equal(checkArgs(schema, { id: "a", width: null }), "width should be a number, not a null.");
    assert.equal(checkArgs(schema, { id: "a", calendars: [] }), "calendars should be a object, not a array.");
  });

  it("checks integers and type unions", () => {
    assert.equal(checkArgs(schema, { id: "a", count: 1.5 }), "count should be a integer, not a number.");
    assert.equal(checkArgs(schema, { id: "a", when: "2026-10-22" }), undefined);
    assert.equal(checkArgs(schema, { id: "a", when: 3 }), "when should be a string or null, not a number.");
  });

  it("checks enums and array items", () => {
    assert.equal(checkArgs(schema, { id: "a", mode: "weekly" }), "mode must be one of: always, daily, off.");
    assert.equal(checkArgs(schema, { id: "a", ids: ["x", 2] }), "ids should hold strings.");
    assert.equal(checkArgs(schema, { id: "a", priority: [1, 9] }), "priority items must be one of: 1, 2, 3, 4.");
  });
});
