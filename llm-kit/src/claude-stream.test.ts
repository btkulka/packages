import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { contentText, createLineSplitter, isErrorResult, parseClaudeJsonOutput, parseStreamJsonLine, resultErrorMessage } from "./claude-stream.js";

describe("parseStreamJsonLine", () => {
  it("reads an event and passes stderr and blanks as null", () => {
    assert.deepEqual(parseStreamJsonLine('{"type":"system","subtype":"init","session_id":"s1","model":"claude-opus-5"}\r'), {
      type: "system",
      subtype: "init",
      session_id: "s1",
      model: "claude-opus-5",
    });
    assert.equal(parseStreamJsonLine("Warning: something odd"), null);
    assert.equal(parseStreamJsonLine("   "), null);
    assert.equal(parseStreamJsonLine("{broken"), null);
    assert.equal(parseStreamJsonLine('{"no":"type"}'), null);
  });
});

describe("createLineSplitter", () => {
  it("joins lines split across chunks and handles CRLF", () => {
    const lines: string[] = [];
    const s = createLineSplitter((l) => lines.push(l));
    s.push('{"a":');
    s.push('1}\r\n{"b"');
    s.push(":2}\n\nlast");
    s.end();
    assert.deepEqual(lines, ['{"a":1}', '{"b":2}', "", "last"]);
  });
});

describe("parseClaudeJsonOutput", () => {
  const result = { type: "result", subtype: "success", is_error: false, result: "Hi", session_id: "s9", total_cost_usd: 0.02 };
  it("reads the single result object", () => {
    assert.deepEqual(parseClaudeJsonOutput(JSON.stringify(result) + "\n"), result);
  });
  it("finds the result in --verbose's array of events", () => {
    assert.deepEqual(parseClaudeJsonOutput(JSON.stringify([{ type: "system", subtype: "init" }, result])), result);
  });
  it("skips a warning printed before the JSON", () => {
    assert.deepEqual(parseClaudeJsonOutput(`Note: update available\n${JSON.stringify(result)}`), result);
  });
  it("is null when there is no result", () => {
    assert.equal(parseClaudeJsonOutput("plain text"), null);
  });
});

describe("result helpers", () => {
  it("knows a failed result and says why", () => {
    assert.equal(isErrorResult({ type: "result", subtype: "success", is_error: false }), false);
    assert.equal(isErrorResult({ type: "result", subtype: "success", is_error: true, result: "Credit balance is too low" }), true);
    assert.equal(isErrorResult({ type: "result", subtype: "error_max_turns" }), true);
    assert.equal(resultErrorMessage({ type: "result", subtype: "error_during_execution", errors: ["boom"] }), "boom");
    assert.equal(resultErrorMessage({ type: "result", subtype: "error_max_turns" }), "claude ended with error_max_turns");
  });
  it("joins text blocks", () => {
    assert.equal(contentText([{ type: "text", text: "a" }, { type: "tool_use", name: "Bash" }, { type: "text", text: "b" }]), "ab");
    assert.equal(contentText("plain"), "plain");
    assert.equal(contentText(undefined), "");
  });
});
