import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync, type ChildProcess, type SpawnOptions } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openerFor, spawnDetached } from "./spawn.js";
import { waitFor } from "./wait.js";

const tmp = () => mkdtempSync(join(tmpdir(), "proc-kit-spawn-"));
const readLog = (p: string) => (existsSync(p) ? readFileSync(p, "utf8") : "");

test("spawnDetached sends stdout and stderr to the log, in a folder it creates", async () => {
  const dir = tmp();
  try {
    const log = join(dir, "nested", "service.log");
    const child = spawnDetached(process.execPath, ["-e", "console.log('to stdout'); console.error('to stderr')"], { log });
    assert.ok(child.pid, "started");
    assert.ok(await waitFor(() => /to stdout/.test(readLog(log)) && /to stderr/.test(readLog(log)), { timeoutMs: 10_000 }));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("spawnDetached appends by default and truncates with logMode 'w'", async () => {
  const dir = tmp();
  try {
    const log = join(dir, "a.log");
    writeFileSync(log, "earlier run\n");
    spawnDetached(process.execPath, ["-e", "console.log('second')"], { log });
    assert.ok(await waitFor(() => readLog(log).includes("second"), { timeoutMs: 10_000 }));
    assert.match(readLog(log), /earlier run/);

    spawnDetached(process.execPath, ["-e", "console.log('third')"], { log, logMode: "w" });
    assert.ok(await waitFor(() => readLog(log).includes("third"), { timeoutMs: 10_000 }));
    assert.doesNotMatch(readLog(log), /earlier run|second/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("spawnDetached passes cwd and env through", async () => {
  const dir = tmp();
  try {
    const log = join(dir, "env.log");
    spawnDetached(process.execPath, ["-e", "console.log(process.cwd() + '|' + process.env.PROC_KIT_TEST)"], {
      log,
      cwd: dir,
      env: { ...process.env, PROC_KIT_TEST: "hello" },
    });
    assert.ok(await waitFor(() => readLog(log).includes("|hello"), { timeoutMs: 10_000 }));
    assert.equal(readLog(log).trim().split("|")[0].toLowerCase(), dir.toLowerCase());
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a program that isn't there calls onError instead of crashing this process", async () => {
  let error: Error | undefined;
  const child = spawnDetached("proc-kit-no-such-program-xyz", [], { onError: (e) => (error = e) });
  assert.equal(child.pid, undefined);
  assert.ok(await waitFor(() => error !== undefined, { timeoutMs: 5000 }));
  assert.match(String((error as NodeJS.ErrnoException).code), /ENOENT/);
  // And with no onError at all: still no unhandled 'error'.
  spawnDetached("proc-kit-no-such-program-xyz");
  await new Promise((r) => setTimeout(r, 200));
});

test("spawnDetached spawns detached, hidden, unref'd, stdin ignored", () => {
  const calls: { cmd: string; args: readonly string[]; opts: SpawnOptions }[] = [];
  let unrefs = 0;
  const fake = ((cmd: string, args: readonly string[], opts: SpawnOptions) => {
    calls.push({ cmd, args, opts });
    return Object.assign(new EventEmitter(), { pid: 4242, unref: () => unrefs++ }) as unknown as ChildProcess;
  }) as unknown as typeof import("node:child_process").spawn;

  const child = spawnDetached("tool", ["--x"], { spawn: fake, cwd: "C:/somewhere" });
  assert.equal(child.pid, 4242);
  assert.equal(unrefs, 1);
  assert.equal(calls[0].cmd, "tool");
  assert.deepEqual(calls[0].args, ["--x"]);
  assert.equal(calls[0].opts.detached, true);
  assert.equal(calls[0].opts.windowsHide, true);
  assert.equal(calls[0].opts.stdio, "ignore");
  assert.equal(calls[0].opts.cwd, "C:/somewhere");

  spawnDetached("gui", [], { spawn: fake, windowsHide: false, shell: true });
  assert.equal(calls[1].opts.windowsHide, false);
  assert.equal(calls[1].opts.shell, true);
});

test("spawnDetached closes the log handle even when spawn throws", () => {
  const dir = tmp();
  try {
    const log = join(dir, "x.log");
    const throwing = (() => {
      throw new Error("EINVAL");
    }) as unknown as typeof import("node:child_process").spawn;
    assert.throws(() => spawnDetached("bad.cmd", [], { log, spawn: throwing }), /EINVAL/);
    rmSync(log); // would fail with EBUSY on Windows if the handle had leaked
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("openerFor: rundll32 on Windows (no cmd parsing of &), open on macOS, xdg-open elsewhere", () => {
  const url = "http://localhost:5173/a?b=1&c=2";
  assert.deepEqual(openerFor(url, "win32"), ["rundll32.exe", ["url.dll,FileProtocolHandler", url]]);
  assert.deepEqual(openerFor(url, "darwin"), ["open", [url]]);
  assert.deepEqual(openerFor(url, "linux"), ["xdg-open", [url]]);
});

// runAndExit calls process.exit, so it runs in a child that loads the CommonJS build.
const cjs = join(process.cwd(), "dist", "cjs", "index.js");

test("runAndExit hands over the child's exit code and terminal", () => {
  const script = `require(${JSON.stringify(cjs)}).runAndExit(process.execPath, ['-e', "console.log('from child'); process.exit(7)"])`;
  const r = spawnSync(process.execPath, ["-e", script], { encoding: "utf8" });
  assert.equal(r.status, 7);
  assert.match(r.stdout, /from child/);
});

test("runAndExit passes env and exits 0 on success", () => {
  const script = `require(${JSON.stringify(cjs)}).runAndExit(process.execPath, ['-e', "process.exit(process.env.X === 'y' ? 0 : 3)"], { env: { ...process.env, X: 'y' } })`;
  assert.equal(spawnSync(process.execPath, ["-e", script]).status, 0);
});

test("runAndExit exits 1 and says why when the program can't start", () => {
  const script = `require(${JSON.stringify(cjs)}).runAndExit('proc-kit-no-such-program-xyz', [])`;
  const r = spawnSync(process.execPath, ["-e", script], { encoding: "utf8" });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /Could not start proc-kit-no-such-program-xyz/);
});
