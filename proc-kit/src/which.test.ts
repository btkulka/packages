import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { findExecutable } from "./which.js";

const win = process.platform === "win32";

/** Run `fn` with PATH (and PATHEXT) set to these, then put them back. */
function withPath<T>(dirs: string[], fn: () => T, pathext = ".COM;.EXE;.BAT;.CMD"): T {
  const saved = { PATH: process.env.PATH, PATHEXT: process.env.PATHEXT };
  process.env.PATH = dirs.join(delimiter);
  process.env.PATHEXT = pathext;
  try {
    return fn();
  } finally {
    process.env.PATH = saved.PATH;
    if (saved.PATHEXT === undefined) delete process.env.PATHEXT;
    else process.env.PATHEXT = saved.PATHEXT;
  }
}

function file(p: string, executable = true): string {
  writeFileSync(p, "#!/bin/sh\necho hi\n");
  if (!win) chmodSync(p, executable ? 0o755 : 0o644);
  return p;
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "proc-kit-which-"));
  const a = join(root, "a");
  const b = join(root, "b");
  const extra = join(root, "extra");
  for (const d of [a, b, extra]) mkdirSync(d);
  return { root, a, b, extra, done: () => rmSync(root, { recursive: true, force: true }) };
}

test("not found is null; an empty name is null", () => {
  const f = fixture();
  try {
    withPath([f.a], () => {
      assert.equal(findExecutable("proc-kit-nothing"), null);
      assert.equal(findExecutable(""), null);
    });
  } finally {
    f.done();
  }
});

test("Windows: PATH order first, then PATHEXT order within a folder", { skip: !win && "Windows only" }, () => {
  const f = fixture();
  try {
    file(join(f.a, "tool.cmd"));
    file(join(f.b, "tool.exe"));
    file(join(f.b, "tool.bat"));
    withPath([f.a, f.b], () => assert.equal(findExecutable("tool"), join(f.a, "tool.cmd")));
    withPath([f.b, f.a], () => assert.equal(findExecutable("tool"), join(f.b, "tool.exe")));
    // A name with a PATHEXT extension is looked up as given.
    withPath([f.a, f.b], () => assert.equal(findExecutable("tool.exe"), join(f.b, "tool.exe")));
    withPath([f.a, f.b], () => assert.equal(findExecutable("TOOL.EXE")?.toLowerCase(), join(f.b, "tool.exe").toLowerCase()));
  } finally {
    f.done();
  }
});

test("Windows: extensionless shims are never returned; other dots get PATHEXT appended", { skip: !win && "Windows only" }, () => {
  const f = fixture();
  try {
    file(join(f.a, "claude")); // npm's sh shim
    file(join(f.b, "claude.cmd"));
    file(join(f.a, "python3.11.exe"));
    withPath([f.a, f.b], () => {
      assert.equal(findExecutable("claude"), join(f.b, "claude.cmd"));
      assert.equal(findExecutable("python3.11"), join(f.a, "python3.11.exe"));
    });
    // A custom PATHEXT is honoured, lower-cased in the result.
    file(join(f.a, "script.py"));
    withPath([f.a], () => assert.equal(findExecutable("script"), join(f.a, "script.py")), ".EXE;.PY");
    withPath([f.a], () => assert.equal(findExecutable("script"), null));
  } finally {
    f.done();
  }
});

test("folders named like executables are skipped", () => {
  const f = fixture();
  try {
    const name = win ? "thing.exe" : "thing";
    mkdirSync(join(f.a, name));
    file(join(f.b, name));
    withPath([f.a, f.b], () => assert.equal(findExecutable("thing"), join(f.b, name)));
  } finally {
    f.done();
  }
});

test("extraDirs are searched after PATH, in order", () => {
  const f = fixture();
  const ext = win ? ".exe" : "";
  try {
    file(join(f.a, `both${ext}`));
    file(join(f.extra, `both${ext}`));
    file(join(f.extra, `only-extra${ext}`));
    withPath([f.a], () => {
      assert.equal(findExecutable("both", { extraDirs: [f.extra] }), join(f.a, `both${ext}`));
      assert.equal(findExecutable("only-extra", { extraDirs: [f.b, f.extra] }), join(f.extra, `only-extra${ext}`));
      assert.equal(findExecutable("only-extra"), null);
    });
  } finally {
    f.done();
  }
});

test("quoted and empty PATH entries are handled", () => {
  const f = fixture();
  const ext = win ? ".exe" : "";
  try {
    const spaced = join(f.root, "with space");
    mkdirSync(spaced);
    file(join(spaced, `spaced${ext}`));
    withPath(["", `"${spaced}"`, ""], () => assert.equal(findExecutable("spaced"), join(spaced, `spaced${ext}`)));
  } finally {
    f.done();
  }
});

test("a name with a folder in it is checked where it points", () => {
  const f = fixture();
  const ext = win ? ".exe" : "";
  try {
    file(join(f.b, `direct${ext}`));
    withPath([], () => {
      assert.equal(findExecutable(join(f.b, "direct")), join(f.b, `direct${ext}`));
      assert.equal(findExecutable(join(f.a, "direct")), null);
    });
  } finally {
    f.done();
  }
});

test("POSIX: a file without the execute bit isn't executable", { skip: win && "POSIX only" }, () => {
  const f = fixture();
  try {
    file(join(f.a, "plain"), false);
    file(join(f.b, "plain"), true);
    withPath([f.a, f.b], () => assert.equal(findExecutable("plain"), join(f.b, "plain")));
  } finally {
    f.done();
  }
});

test("finds this Node on the real PATH", () => {
  const found = findExecutable("node");
  assert.ok(found, "node is on PATH while the tests run");
});
