import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import type { ChildProcess, SpawnOptions } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { launchClaude, probeClaude, runClaude, type ClaudeRunOptions } from "./claude-run.js";
import { claudeArgs } from "./claude-args.js";
import { parseStreamJsonLine, type ClaudeStreamEvent } from "./claude-stream.js";
import { resolveClaudeCommand } from "./claude-resolve.js";
import { LlmError } from "./errors.js";

const win = process.platform === "win32";

/**
 * A stand-in for the claude CLI: a node script that answers by --output-format, records how it
 * was called (FAKE_RECORD), and misbehaves on request (FAKE_MODE).
 */
const FAKE = String.raw`
import { writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
const argv = process.argv.slice(2);
const has = (n) => argv.includes(n);
const flag = (n) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : undefined; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const out = (s) => new Promise((r) => process.stdout.write(s, r));
if (has("--version")) { console.log("2.1.280 (Claude Code)"); process.exit(0); }
const mode = process.env.FAKE_MODE ?? "ok";
let stdin = "";
await new Promise((r) => {
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (d) => (stdin += d));
  process.stdin.on("end", r);
  process.stdin.on("error", r);
});
const prompt = argv[0] === "-p" && argv[1] !== undefined && !argv[1].startsWith("--") ? argv[1] : stdin;
if (process.env.FAKE_RECORD) {
  writeFileSync(process.env.FAKE_RECORD, JSON.stringify({ argv, stdin, prompt, cwd: process.cwd(), claudecode: process.env.CLAUDECODE ?? null, extra: process.env.FAKE_EXTRA ?? null }));
}
if (mode === "hang") {
  const kid = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  writeFileSync(process.env.FAKE_PID_FILE, JSON.stringify([process.pid, kid.pid]));
  setInterval(() => {}, 1000);
} else if (mode === "exit2") {
  process.stderr.write("boom: not logged in\n");
  process.exit(2);
} else if (mode === "empty") {
  process.exit(0);
} else {
  const format = flag("--output-format") ?? "text";
  const failed = mode === "error-result";
  const reply = "reply to: " + prompt + " 🎉";
  const result = failed
    ? { type: "result", subtype: "success", is_error: true, result: "Credit balance is too low", session_id: "sess-1" }
    : { type: "result", subtype: "success", is_error: false, result: reply, session_id: "sess-1", total_cost_usd: 0.0123, num_turns: 1, usage: { input_tokens: 12, output_tokens: 5 } };
  const line = (o) => out(JSON.stringify(o) + "\n");
  if (format === "text") await out(failed ? "Credit balance is too low\n" : reply + "\n");
  else if (format === "json") await out(JSON.stringify(result));
  else {
    await line({ type: "system", subtype: "init", session_id: "sess-1", model: "claude-test", tools: [] });
    if (has("--include-partial-messages")) {
      await line({ type: "stream_event", event: { type: "message_start" } });
      for (const piece of ["reply ", "to: ", prompt, " "]) {
        await line({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: piece } } });
        await sleep(5);
      }
      // The emoji's four bytes split across two writes.
      const buf = Buffer.from(JSON.stringify({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "🎉" } } }) + "\n");
      const at = buf.indexOf(0xf0) + 2;
      await out(buf.subarray(0, at));
      await sleep(20);
      await out(buf.subarray(at));
    }
    await line({ type: "assistant", parent_tool_use_id: "t9", message: { content: [{ type: "text", text: "SUBAGENT" }] } });
    await line({ type: "assistant", message: { content: [{ type: "text", text: reply }] } });
    await line(result);
  }
  process.exit(failed ? 1 : 0);
}
`;

let dir: string;
let fake: string;
const bin = () => ({ command: process.execPath, args: [fake] });
const record = () => JSON.parse(readFileSync(join(dir, "record.json"), "utf8")) as { argv: string[]; stdin: string; prompt: string; cwd: string; claudecode: string | null; extra: string | null };
const run = (o: Partial<ClaudeRunOptions> & { prompt?: string } = {}, mode = "ok") =>
  runClaude({ bin: bin(), prompt: "hello there", ...o, env: { FAKE_MODE: mode, FAKE_RECORD: join(dir, "record.json"), ...o.env } });

before(() => {
  dir = mkdtempSync(join(tmpdir(), "llm-kit-claude-"));
  fake = join(dir, "fake-claude.mjs");
  writeFileSync(fake, FAKE);
});
after(() => rmSync(dir, { recursive: true, force: true }));

describe("runClaude", () => {
  it("sends the prompt over stdin and returns the text reply", async () => {
    const r = await run();
    assert.equal(r.text, "reply to: hello there 🎉");
    assert.equal(r.exitCode, 0);
    assert.deepEqual(record().argv, ["-p", "--output-format", "text"]);
    assert.equal(record().stdin, "hello there");
  });

  it("can put the prompt after -p instead (stdin stays closed)", async () => {
    await run({ promptVia: "arg" });
    assert.deepEqual(record().argv, ["-p", "hello there", "--output-format", "text"]);
    assert.equal(record().stdin, "");
  });

  it("reads json output: result text, session id, cost", async () => {
    const r = await run({ outputFormat: "json" });
    assert.equal(r.text, "reply to: hello there 🎉");
    assert.equal(r.sessionId, "sess-1");
    assert.equal(r.costUsd, 0.0123);
    assert.equal(r.result?.num_turns, 1);
  });

  it("streams text deltas once, whole characters, without subagent text", async () => {
    const texts: string[] = [];
    const events: ClaudeStreamEvent[] = [];
    const r = await run({ outputFormat: "stream-json", includePartialMessages: true, onText: (t) => texts.push(t), onEvent: (e) => events.push(e) });
    assert.equal(texts.join(""), "reply to: hello there 🎉");
    assert.ok(texts.length > 3);
    assert.equal(r.text, "reply to: hello there 🎉");
    assert.equal(r.sessionId, "sess-1");
    assert.deepEqual(
      events.map((e) => e.type),
      ["system", "stream_event", "stream_event", "stream_event", "stream_event", "stream_event", "stream_event", "assistant", "assistant", "result"],
    );
    assert.ok(record().argv.includes("--verbose"));
  });

  it("passes whole assistant messages to onText when there are no deltas", async () => {
    const texts: string[] = [];
    await run({ outputFormat: "stream-json", onText: (t) => texts.push(t) });
    assert.deepEqual(texts, ["reply to: hello there 🎉"]);
  });

  it("drops CLAUDECODE from the inherited env unless kept, and adds the app's variables", async () => {
    const was = process.env.CLAUDECODE;
    process.env.CLAUDECODE = "1";
    try {
      await run({ env: { FAKE_EXTRA: "x" }, cwd: dir });
      assert.equal(record().claudecode, null);
      assert.equal(record().extra, "x");
      assert.equal(record().cwd.toLowerCase(), dir.toLowerCase());
      await run({ keepSessionEnv: true });
      assert.equal(record().claudecode, "1");
    } finally {
      if (was === undefined) delete process.env.CLAUDECODE;
      else process.env.CLAUDECODE = was;
    }
  });

  it("rejects a non-zero exit with the stderr", async () => {
    await assert.rejects(run({}, "exit2"), (e: LlmError) => e.kind === "exit" && e.exitCode === 2 && /claude exited 2: boom: not logged in/.test(e.message));
  });

  it("rejects an error result with its message, before the exit code", async () => {
    await assert.rejects(run({ outputFormat: "stream-json" }, "error-result"), { kind: "result", message: "claude: Credit balance is too low" });
    await assert.rejects(run({ outputFormat: "json" }, "error-result"), { kind: "result" });
  });

  it("rejects an empty reply unless allowed", async () => {
    await assert.rejects(run({}, "empty"), { kind: "empty" });
    assert.equal((await run({ allowEmpty: true }, "empty")).text, "");
  });

  it("times out and kills the process tree", async () => {
    const pidFile = join(dir, "pids.json");
    await assert.rejects(run({ timeoutMs: 1500, env: { FAKE_PID_FILE: pidFile } }, "hang"), { kind: "timeout", message: "claude timed out after 1500ms" });
    const [pid, kid] = JSON.parse(readFileSync(pidFile, "utf8")) as number[];
    const gone = async (p: number) => {
      for (let i = 0; i < 50; i++) {
        try {
          process.kill(p, 0);
        } catch {
          return true;
        }
        await new Promise((r) => setTimeout(r, 100));
      }
      return false;
    };
    assert.equal(await gone(pid), true, "claude itself is gone");
    if (win) assert.equal(await gone(kid), true, "and what it started (taskkill /T)");
    else process.kill(kid);
  });

  it("aborts", async () => {
    const ctrl = new AbortController();
    const p = run({ signal: ctrl.signal, env: { FAKE_PID_FILE: join(dir, "pids2.json") } }, "hang");
    setTimeout(() => ctrl.abort(), 300);
    await assert.rejects(p, { kind: "aborted" });
    await assert.rejects(runClaude({ bin: bin(), prompt: "x", signal: AbortSignal.abort() }), { kind: "aborted" });
    if (!win) {
      try {
        const [, kid] = JSON.parse(readFileSync(join(dir, "pids2.json"), "utf8")) as number[];
        process.kill(kid);
      } catch {
        /* not started */
      }
    }
  });

  it("reports a missing CLI as not-found", async () => {
    await assert.rejects(runClaude({ bin: "llm-kit-no-such-claude", binEnvVar: "ORSON_CLAUDE_BIN", prompt: "x" }), (e: LlmError) => e.kind === "not-found" && /ORSON_CLAUDE_BIN/.test(e.message));
  });

  it("runs a .cmd it can't see through via cmd.exe, arguments intact", { skip: !win }, async () => {
    const shim = join(dir, "opaque.cmd");
    writeFileSync(shim, `@set "S=%~dp0fake-claude.mjs"\r\n@"${process.execPath}" "%S%" %*\r\n`);
    const tricky = ["--x", 'a "quoted" b', "100%", "&|<>^", "C:\\path with space\\", "%PATH%", "!bang!", "(paren)", ""];
    const r = await run({ bin: shim, extraArgs: tricky, prompt: "via cmd & stdin" });
    assert.equal(r.text, "reply to: via cmd & stdin 🎉");
    assert.deepEqual(record().argv, ["-p", "--output-format", "text", ...tricky]);
  });
});

describe("launchClaude", () => {
  it("runs detached, appending stream-json to the log, prompt over stdin", async () => {
    const log = join(dir, "logs", "nested", "run.log");
    const child = launchClaude({ bin: bin(), prompt: "background job", outputFormat: "stream-json", logFile: log, env: { FAKE_RECORD: join(dir, "record.json") } });
    const code = await new Promise<number | null>((r) => child.on("exit", r));
    assert.equal(code, 0);
    const events = readFileSync(log, "utf8").split("\n").map(parseStreamJsonLine).filter((e): e is ClaudeStreamEvent => e !== null);
    assert.equal(events.at(-1)?.type, "result");
    assert.equal(events.at(-1)?.result, "reply to: background job 🎉");
    assert.equal(record().stdin, "background job");
  });

  it("hands job-searcher's spawn the same command line and options it had", () => {
    const ALLOWED = ["Bash(jobhunt *)", "Read"];
    const calls: { cmd: string; args: string[]; opts: SpawnOptions }[] = [];
    const fakeChild = Object.assign(new EventEmitter(), { pid: process.pid, unref: () => {} }) as unknown as ChildProcess;
    const child = launchClaude({
      bin: "claude",
      prompt: "/job-research research",
      promptVia: "arg",
      outputFormat: "stream-json",
      permissionMode: "acceptEdits",
      disallowedTools: ["PowerShell"],
      allowedTools: ALLOWED,
      cwd: dir,
      env: { JOBHUNT_DB: "D:\\x\\jobhunt.db" },
      logFile: join(dir, "research-jobs", "a.log"),
      spawn: (cmd, args, opts) => {
        calls.push({ cmd, args, opts });
        return fakeChild;
      },
    });
    assert.equal(child, fakeChild);
    assert.equal(calls[0].cmd, "claude");
    assert.deepEqual(
      calls[0].args,
      claudeArgs({ prompt: "/job-research research", outputFormat: "stream-json", permissionMode: "acceptEdits", disallowedTools: ["PowerShell"], allowedTools: ALLOWED }),
    );
    assert.deepEqual(calls[0].args.slice(0, 5), ["-p", "/job-research research", "--output-format", "stream-json", "--verbose"]);
    assert.deepEqual(calls[0].args.slice(10), ALLOWED);
    assert.equal(calls[0].opts.cwd, dir);
    assert.equal(calls[0].opts.detached, true);
    assert.equal(calls[0].opts.windowsHide, true);
    assert.equal((calls[0].opts.stdio as unknown[])[0], "ignore");
    assert.equal(calls[0].opts.env?.JOBHUNT_DB, "D:\\x\\jobhunt.db");
  });
});

describe("probeClaude", () => {
  it("reports the version, or why not", async () => {
    assert.deepEqual(await probeClaude({ bin: bin() }), { ok: true, detail: "2.1.280 (Claude Code)" });
    const missing = await probeClaude({ bin: "llm-kit-no-such-claude" });
    assert.equal(missing.ok, false);
  });
});

describe("the real claude CLI", { skip: process.env.LLM_KIT_REAL_CLAUDE !== "1" && "set LLM_KIT_REAL_CLAUDE=1 to check the installed CLI" }, () => {
  it("is found and runs --version", async () => {
    const cmd = resolveClaudeCommand();
    assert.ok(cmd.command);
    const probe = await probeClaude({ bin: cmd });
    assert.equal(probe.ok, true, probe.detail);
  });
});
