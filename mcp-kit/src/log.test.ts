import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createLogger } from "./log.js";

function sink() {
  const lines: string[] = [];
  return { lines, stream: { write: (s: string) => lines.push(s) } };
}

describe("createLogger", () => {
  it("prefixes each line", () => {
    const s = sink();
    createLogger("benhaus", { stream: s.stream })("bridge ready");
    assert.deepEqual(s.lines, ["[benhaus] bridge ready\n"]);
  });

  it("adds HH:mm:ss.SSS after the prefix with time (clipdrift's [upscale …] format)", () => {
    const s = sink();
    createLogger("upscale", { time: true, stream: s.stream })("started");
    assert.match(s.lines[0], /^\[upscale \d{2}:\d{2}:\d{2}\.\d{3}\] started\n$/);
  });

  it("formats several parts like console.error, with an Error's stack", () => {
    const s = sink();
    createLogger("nhi-dash mcp", { stream: s.stream })("get_overview failed:", new Error("db locked"));
    assert.match(s.lines[0], /^\[nhi-dash mcp\] get_overview failed: Error: db locked\n {4}at /);
  });

  it("swallows a closed stream", () => {
    const log = createLogger("x", {
      stream: {
        write: () => {
          throw new Error("EPIPE");
        },
      },
    });
    assert.doesNotThrow(() => log("still fine"));
  });

  it("writes to stderr by default", () => {
    const original = process.stderr.write;
    const seen: string[] = [];
    process.stderr.write = ((chunk: string) => {
      seen.push(chunk);
      return true;
    }) as typeof process.stderr.write;
    try {
      createLogger("kit")("to stderr");
    } finally {
      process.stderr.write = original;
    }
    assert.deepEqual(seen, ["[kit] to stderr\n"]);
  });
});
