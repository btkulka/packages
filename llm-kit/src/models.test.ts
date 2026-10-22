import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { splitModelRef } from "./models.js";

describe("splitModelRef", () => {
  it("splits off a known local prefix and keeps the tag", () => {
    assert.deepEqual(splitModelRef("ollama:rocinante-12b"), { prefix: "ollama", model: "rocinante-12b" });
    assert.deepEqual(splitModelRef("ollama:qwen3:8b"), { prefix: "ollama", model: "qwen3:8b" });
    assert.deepEqual(splitModelRef("kobold:L3-8B"), { prefix: "kobold", model: "L3-8B" });
    assert.deepEqual(splitModelRef("local:model"), { prefix: "local", model: "model" });
    assert.deepEqual(splitModelRef("llama:x"), { prefix: "llama", model: "x" });
  });
  it("leaves a Claude id or an unprefixed Ollama tag alone (localLlm.bareModel cut 'qwen3:8b' to '8b')", () => {
    assert.deepEqual(splitModelRef("claude-haiku-4-5"), { prefix: null, model: "claude-haiku-4-5" });
    assert.deepEqual(splitModelRef("qwen3:8b"), { prefix: null, model: "qwen3:8b" });
    assert.deepEqual(splitModelRef(":odd"), { prefix: null, model: ":odd" });
  });
  it("takes the app's own prefix list", () => {
    assert.deepEqual(splitModelRef("lmstudio:phi", ["lmstudio"]), { prefix: "lmstudio", model: "phi" });
    assert.deepEqual(splitModelRef("ollama:phi", ["lmstudio"]), { prefix: null, model: "ollama:phi" });
  });
});
