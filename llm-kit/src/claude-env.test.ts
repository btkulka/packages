import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { claudeEnv, getEnv } from "./claude-env.js";

const base = { PATH: "/bin", CLAUDECODE: "1", CLAUDE_CODE_ENTRYPOINT: "cli", CLAUDE_CODE_SSE_PORT: "5555", ELECTRON_RUN_AS_NODE: "1", HOME: "/h" };

describe("claudeEnv", () => {
  it("drops the parent session's variables and lays extras over the rest", () => {
    assert.deepEqual(claudeEnv({ JOBHUNT_DB: "/d/x.db" }, { base, platform: "linux" }), { PATH: "/bin", HOME: "/h", JOBHUNT_DB: "/d/x.db" });
  });
  it("keeps them when asked, and an undefined extra removes a variable", () => {
    const env = claudeEnv({ HOME: undefined }, { base, keepSessionEnv: true, platform: "linux" });
    assert.equal(env.CLAUDECODE, "1");
    assert.equal("HOME" in env, false);
  });
  it("ignores case on Windows, so PATH replaces Path instead of duplicating it", () => {
    const env = claudeEnv({ PATH: "C:\\new" }, { base: { Path: "C:\\old", ClaudeCode: "1" }, platform: "win32" });
    assert.deepEqual(env, { PATH: "C:\\new" });
    assert.equal(getEnv({ Path: "C:\\x" }, "PATH", "win32"), "C:\\x");
    assert.equal(getEnv({ Path: "C:\\x" }, "PATH", "linux"), undefined);
  });
  it("doesn't touch the environment it copied", () => {
    const b = { ...base };
    claudeEnv({}, { base: b, platform: "linux" });
    assert.equal(b.CLAUDECODE, "1");
  });
});
