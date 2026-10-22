import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { escapeCmdArg, resolveClaudeCommand, resolveCmdShim, spawnSpec } from "./claude-resolve.js";
import { LlmError } from "./errors.js";

const win = process.platform === "win32";

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "llm-kit-resolve-"));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const touch = (...parts: string[]) => {
  const p = join(root, ...parts);
  mkdirSync(join(p, ".."), { recursive: true });
  writeFileSync(p, "");
  return p;
};
const write = (text: string, ...parts: string[]) => {
  const p = join(root, ...parts);
  mkdirSync(join(p, ".."), { recursive: true });
  writeFileSync(p, text);
  return p;
};

// What npm writes today (claude-code 2.x ships a native exe behind the shim).
const NPM_SHIM = '@ECHO off\r\nGOTO start\r\n:find_dp0\r\nSET dp0=%~dp0\r\nEXIT /b\r\n:start\r\nSETLOCAL\r\nCALL :find_dp0\r\n"%dp0%\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe"   %*\r\n';
// What npm wrote for claude-code 1.x (cli.js run by node).
const OLD_NPM_SHIM =
  '@ECHO off\r\nGOTO start\r\n:find_dp0\r\nSET dp0=%~dp0\r\nEXIT /b\r\n:start\r\nSETLOCAL\r\nCALL :find_dp0\r\n\r\nIF EXIST "%dp0%\\node.exe" (\r\n  SET "_prog=%dp0%\\node.exe"\r\n) ELSE (\r\n  SET "_prog=node"\r\n  SET PATHEXT=%PATHEXT:;.JS;=;%\r\n)\r\n\r\nendLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\@anthropic-ai\\claude-code\\cli.js" %*\r\n';

describe("resolveClaudeCommand", () => {
  it("uses an explicit bin as given, then the named env var", () => {
    assert.deepEqual(resolveClaudeCommand({ bin: "claude", env: {} }), { command: "claude", args: [] });
    assert.deepEqual(resolveClaudeCommand({ envVar: "ORSON_CLAUDE_BIN", env: { ORSON_CLAUDE_BIN: "/opt/claude" }, platform: "linux" }), { command: "/opt/claude", args: [] });
  });

  it("on Windows finds claude.exe on PATH, reading Path in any case", { skip: !win }, () => {
    const exe = touch("native", "claude.exe");
    assert.deepEqual(resolveClaudeCommand({ env: { Path: `${join(root, "empty")};"${join(root, "native")}"` }, platform: "win32" }), { command: exe, args: [] });
  });

  it("on Windows prefers the exe inside an npm install over its claude.cmd (job-searcher's lookup)", { skip: !win }, () => {
    write(NPM_SHIM, "npm", "claude.cmd");
    const exe = touch("npm", "node_modules", "@anthropic-ai", "claude-code", "bin", "claude.exe");
    assert.deepEqual(resolveClaudeCommand({ env: { PATH: join(root, "npm") }, platform: "win32" }), { command: exe, args: [] });
  });

  it("on Windows looks through a claude.cmd whose program lives elsewhere", { skip: !win }, () => {
    const exe = touch("store", "claude-code", "bin", "claude.exe");
    write(`@"%~dp0\\..\\store\\claude-code\\bin\\claude.exe" %*\r\n`, "pnpm", "claude.cmd");
    assert.deepEqual(resolveClaudeCommand({ env: { PATH: join(root, "pnpm") }, platform: "win32" }), { command: exe, args: [] });
  });

  it("falls back to the native installer's ~/.local/bin", { skip: !win }, () => {
    const exe = touch("home", ".local", "bin", "claude.exe");
    assert.deepEqual(resolveClaudeCommand({ env: { PATH: "", USERPROFILE: join(root, "home") }, platform: "win32" }), { command: exe, args: [] });
  });

  it("finds ~/.local/bin/claude on POSIX", () => {
    const home = join(root, "home");
    touch("home", ".local", "bin", "claude");
    const r = resolveClaudeCommand({ env: { PATH: "", HOME: home }, platform: "linux" });
    assert.match(r.command.replace(/\\/g, "/"), /home\/\.local\/bin\/claude$/);
  });

  it("throws not-found naming the app's env var", () => {
    assert.throws(
      () => resolveClaudeCommand({ envVar: "JOBHUNT_CLAUDE_BIN", env: { PATH: join(root, "nothing") }, platform: win ? "win32" : "linux" }),
      (e: LlmError) => e.kind === "not-found" && /set JOBHUNT_CLAUDE_BIN/.test(e.message),
    );
  });
});

describe("resolveCmdShim", { skip: !win }, () => {
  it("reads today's npm shim", () => {
    const shim = write(NPM_SHIM, "a", "claude.cmd");
    const exe = touch("a", "node_modules", "@anthropic-ai", "claude-code", "bin", "claude.exe");
    assert.deepEqual(resolveCmdShim(shim), { command: exe, args: [] });
  });

  it("reads the old npm shim: cli.js under the node.exe beside it, else node", () => {
    const shim = write(OLD_NPM_SHIM, "b", "claude.cmd");
    const cli = touch("b", "node_modules", "@anthropic-ai", "claude-code", "cli.js");
    assert.deepEqual(resolveCmdShim(shim), { command: "node", args: [cli] });
    const node = touch("b", "node.exe");
    assert.deepEqual(resolveCmdShim(shim), { command: node, args: [cli] });
  });

  it("follows a shim that calls another shim (yarn global)", () => {
    const exe = touch("c", "inner", "node_modules", "@anthropic-ai", "claude-code", "bin", "claude.exe");
    write(NPM_SHIM, "c", "inner", "claude.cmd");
    const outer = write('@"%~dp0\\inner\\claude.cmd" %*\r\n', "c", "claude.cmd");
    assert.deepEqual(resolveCmdShim(outer), { command: exe, args: [] });
  });

  it("is null for a shim it can't read or whose program is missing", () => {
    assert.equal(resolveCmdShim(write("@set S=%~dp0x.js\r\n@node \"%S%\" %*\r\n", "d", "claude.cmd")), null);
    assert.equal(resolveCmdShim(write(NPM_SHIM, "e", "claude.cmd")), null);
    assert.equal(resolveCmdShim(join(root, "missing.cmd")), null);
  });
});

describe("spawnSpec", () => {
  it("spawns a program directly with the cli.js prefix", () => {
    assert.deepEqual(spawnSpec({ command: "node", args: ["cli.js"] }, ["-p"], { platform: "win32" }), { file: "node", args: ["cli.js", "-p"], verbatim: false });
  });

  it("runs an unreadable .cmd through cmd.exe, escaped, and refuses newlines", () => {
    const s = spawnSpec({ command: "C:\\tools\\claude.cmd", args: [] }, ["-p", "a b"], { platform: "win32", env: { ComSpec: "C:\\Windows\\system32\\cmd.exe" } });
    assert.equal(s.file, "C:\\Windows\\system32\\cmd.exe");
    assert.equal(s.verbatim, true);
    assert.deepEqual(s.args.slice(0, 3), ["/d", "/s", "/c"]);
    assert.equal(s.args[3], `"C:\\tools\\claude.cmd ${escapeCmdArg("-p")} ${escapeCmdArg("a b")}"`);
    assert.throws(() => spawnSpec({ command: "C:\\x\\claude.cmd", args: [] }, ["--system-prompt", "a\nb"], { platform: "win32" }), { kind: "spawn" });
  });

  it("escapes like cross-spawn (double, for a shim's %*)", () => {
    assert.equal(escapeCmdArg("plain"), '^^^"plain^^^"');
    assert.equal(escapeCmdArg("a&b"), '^^^"a^^^&b^^^"');
    assert.equal(escapeCmdArg('say "hi"'), '^^^"say^^^ \\^^^"hi\\^^^"^^^"');
    assert.equal(escapeCmdArg("100%"), '^^^"100^^^%^^^"');
  });
});
