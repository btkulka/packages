import { test } from "node:test";
import assert from "node:assert/strict";
import { ELECTRON_ENV_KEYS, electronEnv, stripElectronEnv } from "./env.js";

const poisoned = (): NodeJS.ProcessEnv => ({
  PATH: "/bin",
  ELECTRON_RUN_AS_NODE: "1",
  ATOM_SHELL_INTERNAL_RUN_AS_NODE: "1",
  ELECTRON_NO_ATTACH_CONSOLE: "1",
  ELECTRON_OVERRIDE_DIST_PATH: "/elsewhere",
  ELECTRON_RENDERER_URL: "http://localhost:5173",
  KEEP: "me",
});

test("electronEnv drops the Electron-as-Node variables and leaves the rest", () => {
  const base = poisoned();
  const env = electronEnv({ env: base });
  for (const k of ELECTRON_ENV_KEYS) assert.equal(env[k], undefined, k);
  assert.equal(env.KEEP, "me");
  assert.equal(env.PATH, "/bin");
  assert.equal(env.ELECTRON_RENDERER_URL, "http://localhost:5173"); // only removed when asked
  assert.equal(base.ELECTRON_RUN_AS_NODE, "1", "the input isn't modified");
});

test("electronEnv: remove takes more, set adds or deletes after", () => {
  const env = electronEnv({
    env: poisoned(),
    remove: ["ELECTRON_RENDERER_URL", "CLAUDECODE"],
    set: { USER_TIER: "PREMIUM", KEEP: undefined },
  });
  assert.equal(env.ELECTRON_RENDERER_URL, undefined);
  assert.equal(env.USER_TIER, "PREMIUM");
  assert.equal("KEEP" in env, false);
});

test("electronEnv defaults to process.env without touching it", () => {
  const before = process.env.ELECTRON_RUN_AS_NODE;
  process.env.ELECTRON_RUN_AS_NODE = "1";
  try {
    const env = electronEnv();
    assert.equal(env.ELECTRON_RUN_AS_NODE, undefined);
    assert.equal(process.env.ELECTRON_RUN_AS_NODE, "1");
    assert.equal(env.PATH ?? env.Path, process.env.PATH);
  } finally {
    if (before === undefined) delete process.env.ELECTRON_RUN_AS_NODE;
    else process.env.ELECTRON_RUN_AS_NODE = before;
  }
});

test("stripElectronEnv works in place and reports what it removed", () => {
  const env = poisoned();
  const removed = stripElectronEnv(env);
  assert.deepEqual(removed.sort(), [...ELECTRON_ENV_KEYS].sort());
  assert.equal(env.ELECTRON_RUN_AS_NODE, undefined);
  assert.equal(env.KEEP, "me");
  assert.deepEqual(stripElectronEnv(env), [], "idempotent");
});

test("names match case-insensitively on Windows", { skip: process.platform !== "win32" && "Windows only" }, () => {
  const env = electronEnv({ env: { electron_run_as_node: "1", Path: "C:\\x" }, set: { PATH: "C:\\y" } });
  assert.equal(env.electron_run_as_node, undefined);
  assert.deepEqual(Object.keys(env), ["PATH"]); // set replaced Path rather than adding a second
  assert.equal(env.PATH, "C:\\y");
  assert.deepEqual(stripElectronEnv({ Electron_Run_As_Node: "1" }), ["Electron_Run_As_Node"]);
});
