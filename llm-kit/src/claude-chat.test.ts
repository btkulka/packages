import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import type { ChildProcess } from "node:child_process";
import { claudeCliChat, flattenForClaude } from "./claude-chat.js";

describe("flattenForClaude", () => {
  it("joins system messages and writes prior turns out the way orson did", () => {
    const r = flattenForClaude(
      [
        { role: "system", content: "You are the narrator." },
        { role: "user", content: "Look around." },
        { role: "assistant", content: "A dim hall." },
        { role: "system", content: "Stay in second person." },
        { role: "user", content: "Open the door." },
      ],
      "Base rules.",
    );
    assert.equal(r.systemPrompt, "Base rules.\n\nYou are the narrator.\n\nStay in second person.");
    assert.equal(r.prompt, "=== Prior conversation ===\nUser: Look around.\n\nAssistant: A dim hall.\n\n=== Current turn ===\nOpen the door.");
  });
  it("sends a single turn as is, and nothing for no turns", () => {
    assert.deepEqual(flattenForClaude([{ role: "user", content: "Hi" }]), { systemPrompt: "", prompt: "Hi" });
    assert.deepEqual(flattenForClaude([{ role: "system", content: "S" }]), { systemPrompt: "S", prompt: "" });
  });
});

/** A fake claude process that answers from `stdout` and records its args and stdin. */
function fakeSpawn(stdoutText: string) {
  const seen: { cmd: string; args: string[]; stdin: string } = { cmd: "", args: [], stdin: "" };
  const spawn = (cmd: string, args: string[]) => {
    seen.cmd = cmd;
    seen.args = args;
    const child = new EventEmitter() as ChildProcess & EventEmitter;
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const stdin = new Writable({
      write(chunk, _enc, cb) {
        seen.stdin += chunk.toString();
        cb();
      },
      final(cb) {
        cb();
        stdout.end(stdoutText);
        stderr.end();
        setTimeout(() => child.emit("close", 0, null), 10);
      },
    });
    Object.assign(child, { stdout, stderr, stdin, pid: 1, exitCode: null, signalCode: null, kill: () => true });
    return child;
  };
  return { seen, spawn };
}

describe("claudeCliChat", () => {
  const messages = [
    { role: "system" as const, content: "Terse." },
    { role: "user" as const, content: "Name a colour." },
  ];

  it("runs a tool-less, unsaved json turn and reports usage, cost and session", async () => {
    const f = fakeSpawn(JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "Teal.", session_id: "s2", total_cost_usd: 0.001, usage: { input_tokens: 30, output_tokens: 2 } }));
    const r = await claudeCliChat({ bin: "claude", model: "sonnet", messages, temperature: 0.7, spawn: f.spawn });
    assert.deepEqual(f.seen.args, ["-p", "--output-format", "json", "--model", "sonnet", "--system-prompt", "Terse.", "--disable-slash-commands", "--no-session-persistence", "--tools", ""]);
    assert.equal(f.seen.stdin, "Name a colour.");
    assert.deepEqual(r, { text: "Teal.", usage: { in: 30, out: 2 }, model: "sonnet", costUsd: 0.001, sessionId: "s2" });
  });

  it("streams with onDelta", async () => {
    const lines = [
      { type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "Te" } } },
      { type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "al." } } },
      { type: "assistant", message: { content: [{ type: "text", text: "Teal." }] } },
      { type: "result", subtype: "success", is_error: false, result: "Teal." },
    ];
    const f = fakeSpawn(lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
    const deltas: string[] = [];
    const r = await claudeCliChat({ bin: "claude", messages, onDelta: (d) => deltas.push(d), spawn: f.spawn });
    assert.deepEqual(deltas, ["Te", "al."]);
    assert.equal(r.text, "Teal.");
    assert.ok(f.seen.args.includes("--include-partial-messages"));
    assert.ok(f.seen.args.includes("stream-json"));
    assert.deepEqual(r.usage, { in: Math.ceil(("Terse." + "Name a colour.").length / 4), out: 2 });
  });
});
