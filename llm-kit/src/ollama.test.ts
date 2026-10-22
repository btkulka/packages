import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { LlmError } from "./errors.js";
import { ollamaChat, ollamaEmbed, ollamaHasModel, ollamaListModels } from "./ollama.js";
import { chunked, fakeFetch, json } from "./test-helpers.js";

const cfg = (fetch: ReturnType<typeof fakeFetch>) => ({ baseUrl: "http://localhost:11434/", fetch });
const msgs = [
  { role: "system" as const, content: "You narrate." },
  { role: "user" as const, content: "Go on." },
];

describe("ollamaChat, whole", () => {
  it("posts to /api/chat with options merged, and returns trimmed text and eval-count usage", async () => {
    const f = fakeFetch(() => json({ model: "gemma3:4b", message: { content: "  The door creaks.\n" }, done: true, prompt_eval_count: 40, eval_count: 6 }));
    const r = await ollamaChat(cfg(f), { model: "gemma3:4b", messages: msgs, temperature: 0.75, maxTokens: 200, options: { num_ctx: 8192, num_gpu: 99 } });
    assert.equal(f.sent[0].url, "http://localhost:11434/api/chat");
    assert.deepEqual(f.sent[0].body, {
      model: "gemma3:4b",
      messages: msgs,
      stream: false,
      options: { num_ctx: 8192, num_gpu: 99, temperature: 0.75, num_predict: 200 },
    });
    assert.deepEqual(r, { text: "The door creaks.", usage: { in: 40, out: 6 }, model: "gemma3:4b" });
  });

  it("puts `system` in front of the messages", async () => {
    const f = fakeFetch(() => json({ message: { content: "ok" } }));
    await ollamaChat(cfg(f), { model: "m", system: "S", messages: [{ role: "user", content: "u" }] });
    assert.deepEqual(f.sent[0].body?.messages, [
      { role: "system", content: "S" },
      { role: "user", content: "u" },
    ]);
  });

  it("retries an empty reply once at +0.15 temperature, like orson's chat()", async () => {
    const f = fakeFetch((_r, n) => json({ message: { content: n === 0 ? "" : "Second." } }));
    const r = await ollamaChat(cfg(f), { model: "m", messages: msgs, temperature: 0.8, emptyRetries: 1 });
    assert.equal(r.text, "Second.");
    assert.deepEqual(f.sent.map((s) => (s.body?.options as { temperature: number }).temperature), [0.8, 0.8 + 0.15]);
    const never = fakeFetch(() => json({ message: { content: "   " } }));
    await assert.rejects(ollamaChat(cfg(never), { model: "m", messages: msgs, temperature: 0.8, emptyRetries: 1 }), {
      kind: "empty",
      message: "Ollama returned no content (after 1 retry)",
    });
  });

  it("names Ollama in http errors", async () => {
    const f = fakeFetch(() => new Response('{"error":"model \\"x\\" not found"}', { status: 404 }));
    await assert.rejects(ollamaChat(cfg(f), { model: "x", messages: msgs }), (e: LlmError) => e.kind === "http" && e.status === 404 && e.message.startsWith("Ollama 404: "));
  });
});

describe("ollamaChat, streamed", () => {
  it("streams visible text (think blocks hidden) and returns the whole reply", async () => {
    const lines = [
      { message: { content: "<thi" } },
      { message: { content: "nk>plotting</think>The " } },
      { message: { content: "café é" } },
      { message: { content: "tait vide." } },
      { model: "m", done: true, prompt_eval_count: 9, eval_count: 4 },
    ].map((l) => JSON.stringify(l) + "\n");
    // Split mid-line and mid-character (é is two bytes) to prove reassembly.
    const bytes = new TextEncoder().encode(lines.join(""));
    const cut1 = 7;
    const cut2 = new TextEncoder().encode(lines.slice(0, 2).join("") + '{"message":{"content":"caf').length + 1;
    const f = fakeFetch(() => chunked([bytes.slice(0, cut1), bytes.slice(cut1, cut2), bytes.slice(cut2)]));
    const deltas: string[] = [];
    const r = await ollamaChat(cfg(f), { model: "m", messages: msgs, onDelta: (d) => deltas.push(d) });
    assert.equal(f.sent[0].body?.stream, true);
    assert.equal(deltas.join(""), "The café était vide.");
    assert.equal(r.text, "<think>plotting</think>The café était vide.");
    assert.deepEqual(r.usage, { in: 9, out: 4 });
    assert.equal(r.model, "m");
  });

  it("throws on an error frame mid-stream", async () => {
    const f = fakeFetch(() => chunked([JSON.stringify({ message: { content: "a" } }) + "\n", JSON.stringify({ error: "out of memory" }) + "\n"]));
    await assert.rejects(ollamaChat(cfg(f), { model: "m", messages: msgs, onDelta: () => {} }), { kind: "bad-response", message: "Ollama: out of memory" });
  });

  it("returns an empty stream as \"\" when allowed (orson's narrator retries on its own)", async () => {
    const f = fakeFetch(() => chunked([JSON.stringify({ done: true }) + "\n"]));
    const r = await ollamaChat(cfg(f), { model: "m", messages: msgs, onDelta: () => {}, allowEmpty: true });
    assert.equal(r.text, "");
  });
});

describe("ollamaEmbed", () => {
  it("embeds one text or several through /api/embed", async () => {
    const f = fakeFetch((req) => json({ embeddings: (Array.isArray(req.body?.input) ? req.body.input : [req.body?.input]).map((_: unknown, i: number) => [i, 1, 2]) }));
    assert.deepEqual(await ollamaEmbed(cfg(f), "hello", { model: "nomic-embed-text" }), [0, 1, 2]);
    assert.deepEqual(await ollamaEmbed(cfg(f), ["a", "b"], { model: "nomic-embed-text" }), [
      [0, 1, 2],
      [1, 1, 2],
    ]);
    assert.equal(f.sent[0].url, "http://localhost:11434/api/embed");
    assert.deepEqual(f.sent[0].body, { model: "nomic-embed-text", input: "hello" });
  });

  it("checks the dimensions and that a vector came back", async () => {
    const f = fakeFetch(() => json({ embeddings: [[1, 2, 3]] }));
    await assert.rejects(ollamaEmbed(cfg(f), "x", { model: "nomic-embed-text", dims: 768 }), { kind: "bad-response", message: 'Ollama embed returned 3 dims from "nomic-embed-text"; expected 768' });
    const none = fakeFetch(() => json({ embeddings: [] }));
    await assert.rejects(ollamaEmbed(cfg(none), "x", { model: "m" }), { kind: "bad-response" });
  });
});

describe("ollamaListModels / ollamaHasModel", () => {
  it("maps /api/tags", async () => {
    const f = fakeFetch(() =>
      json({
        models: [
          { name: "qwen3:8b", digest: "abc", size: 5_000, modified_at: "2026-10-01T00:00:00Z", details: { family: "qwen3", parameter_size: "8.2B", quantization_level: "Q4_K_M" } },
          { model: "nomic-embed-text:latest" },
        ],
      }),
    );
    const models = await ollamaListModels(cfg(f), { timeoutMs: 1000 });
    assert.equal(f.sent[0].url, "http://localhost:11434/api/tags");
    assert.deepEqual(models, [
      { name: "qwen3:8b", digest: "abc", sizeBytes: 5000, modifiedAt: "2026-10-01T00:00:00Z", family: "qwen3", parameterSize: "8.2B", quantization: "Q4_K_M" },
      { name: "nomic-embed-text:latest", digest: "", sizeBytes: 0, modifiedAt: null, family: null, parameterSize: null, quantization: null },
    ]);
  });

  it("matches the way Ollama resolves a name", () => {
    const installed = ["qwen3:8b", "nomic-embed-text:latest", "hf.co/x/y-GGUF:Q4_K_M"];
    assert.equal(ollamaHasModel(installed, "qwen3:8b"), true);
    assert.equal(ollamaHasModel(installed, "nomic-embed-text"), true);
    assert.equal(ollamaHasModel(installed, "qwen3"), false);
    assert.equal(ollamaHasModel(installed, "hf.co/x/y-GGUF:Q4_K_M"), true);
    assert.equal(ollamaHasModel(installed, "hf.co/x/y-GGUF:Q8_0"), false);
  });
});
