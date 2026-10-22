import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { claudeArgs } from "./claude-args.js";

describe("claudeArgs", () => {
  it("builds job-searcher's headless session line in the order its tests pin", () => {
    const ALLOWED = ["Bash(jobhunt *)", "Read", "mcp__claude_ai_Gmail__send_message"];
    const args = claudeArgs({
      prompt: "/job-research research",
      outputFormat: "stream-json",
      permissionMode: "acceptEdits",
      disallowedTools: ["PowerShell"],
      allowedTools: ALLOWED,
    });
    assert.deepEqual(args.slice(0, 5), ["-p", "/job-research research", "--output-format", "stream-json", "--verbose"]);
    assert.deepEqual(args.slice(2, 10), ["--output-format", "stream-json", "--verbose", "--permission-mode", "acceptEdits", "--disallowedTools", "PowerShell", "--allowedTools"]);
    assert.deepEqual(args.slice(10), ALLOWED);
  });

  it("builds orson's chat flags, prompt left for stdin", () => {
    assert.deepEqual(
      claudeArgs({ outputFormat: "stream-json", includePartialMessages: true, model: "sonnet", systemPrompt: "Be terse.\nNo lists.", tools: [], disableSlashCommands: true, noSessionPersistence: true }),
      ["-p", "--output-format", "stream-json", "--verbose", "--include-partial-messages", "--model", "sonnet", "--system-prompt", "Be terse.\nNo lists.", "--disable-slash-commands", "--no-session-persistence", "--tools", ""],
    );
  });

  it("defaults to text output, only -p and the format", () => {
    assert.deepEqual(claudeArgs(), ["-p", "--output-format", "text"]);
    assert.deepEqual(claudeArgs({ outputFormat: "json", verbose: true }), ["-p", "--output-format", "json", "--verbose"]);
  });

  it("comma-joins a tool set and puts extra args before the tool lists", () => {
    assert.deepEqual(claudeArgs({ tools: ["Read", "Grep"], extraArgs: ["--max-turns", "3"], allowedTools: ["Read"] }), [
      "-p",
      "--output-format",
      "text",
      "--max-turns",
      "3",
      "--tools",
      "Read,Grep",
      "--allowedTools",
      "Read",
    ]);
  });
});
