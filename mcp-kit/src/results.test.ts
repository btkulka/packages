import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { error, errorMessage, image, isToolResult, json, jsonError, text, toResult } from "./results.js";

const data = { a: 1, list: ["x", { b: null }] };

describe("results", () => {
  it("text is one text block", () => {
    assert.deepEqual(text("hi"), { content: [{ type: "text", text: "hi" }] });
  });

  it("json indents 2 by default, like benhaus, clipdrift, lemonsqueezy, nhi-dashboard and job-searcher", () => {
    assert.equal(json(data).content[0].type, "text");
    assert.equal((json(data).content[0] as { text: string }).text, JSON.stringify(data, null, 2));
    assert.equal(json(data).isError, undefined);
  });

  it("json with indent 0 is compact, like orson's ok() and starfall's lore ok()", () => {
    assert.equal((json(data, 0).content[0] as { text: string }).text, JSON.stringify(data));
  });

  it("json of undefined is null text rather than a block without text", () => {
    assert.deepEqual(json(undefined), { content: [{ type: "text", text: "null" }] });
  });

  it("error marks isError", () => {
    assert.deepEqual(error("nope"), { isError: true, content: [{ type: "text", text: "nope" }] });
  });

  it("jsonError matches clipdrift (indent 2) and lemonsqueezy (indent 0)", () => {
    assert.deepEqual(jsonError("bad"), { isError: true, content: [{ type: "text", text: JSON.stringify({ error: "bad" }, null, 2) }] });
    assert.deepEqual(jsonError("bad", 0), { isError: true, content: [{ type: "text", text: '{"error":"bad"}' }] });
  });

  it("image is an image block, then the caption when there is one (benhaus screenshot shape)", () => {
    assert.deepEqual(image("AAA", "image/png"), { content: [{ type: "image", data: "AAA", mimeType: "image/png" }] });
    assert.deepEqual(image("AAA", "image/jpeg", "Title"), {
      content: [
        { type: "image", data: "AAA", mimeType: "image/jpeg" },
        { type: "text", text: "Title" },
      ],
    });
  });

  it("errorMessage takes Error.message or String()", () => {
    assert.equal(errorMessage(new Error("m")), "m");
    assert.equal(errorMessage("plain"), "plain");
    assert.equal(errorMessage(42), "42");
    assert.equal(errorMessage(undefined), "undefined");
  });

  it("isToolResult accepts results and rejects look-alike data", () => {
    assert.equal(isToolResult(text("x")), true);
    assert.equal(isToolResult(error("x")), true);
    assert.equal(isToolResult({ content: [], isError: false }), true);
    assert.equal(isToolResult({ content: [{ type: "text", text: "x" }], structuredContent: {}, _meta: {} }), true);
    assert.equal(isToolResult({ content: [{ type: "text", text: "x" }], total: 3 }), false, "an extra key means it's data");
    assert.equal(isToolResult({ content: "x" }), false);
    assert.equal(isToolResult({ content: [{ text: "x" }] }), false, "blocks need a type");
    assert.equal(isToolResult({ content: [null] }), false);
    assert.equal(isToolResult([{ type: "text" }]), false);
    assert.equal(isToolResult(null), false);
    assert.equal(isToolResult("text"), false);
  });

  it("toResult passes results through, sends undefined as {ok:true}, and data as JSON", () => {
    const r = text("as is");
    assert.equal(toResult(r), r);
    assert.deepEqual(toResult(undefined), json({ ok: true }));
    assert.deepEqual(toResult(null), json(null));
    assert.deepEqual(toResult(0), json(0));
    assert.deepEqual(toResult(data, 0), json(data, 0));
    assert.deepEqual(toResult({ content: "not blocks" }), json({ content: "not blocks" }));
  });
});
