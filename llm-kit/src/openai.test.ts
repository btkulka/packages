import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LlmError } from "./errors.js";
import { grammarInfo } from "./grammar.js";
import { openAiChat, type OpenAiConfig } from "./openai.js";
import { fakeFetch, hangingFetch, json } from "./test-helpers.js";

const completion = (content: string, extra: Record<string, unknown> = {}) =>
  json({ choices: [{ message: { content } }], usage: { prompt_tokens: 11, completion_tokens: 3 }, model: "L3-8B-Stheno", ...extra });

const ask = { model: "rocinante-12b", system: "You are a villager.", messages: [{ role: "user" as const, content: "Hello" }], maxTokens: 64, temperature: 0.8 };

describe("openAiChat", () => {
  it("posts system + messages to <base>/chat/completions and returns text, usage and the served model", async () => {
    const f = fakeFetch(() => completion("Hi there"));
    const r = await openAiChat({ baseUrl: "http://127.0.0.1:5001/v1/", apiKey: "k", fetch: f }, ask);
    assert.equal(f.sent[0].url, "http://127.0.0.1:5001/v1/chat/completions");
    assert.equal(f.sent[0].method, "POST");
    assert.equal(f.sent[0].headers.Authorization, "Bearer k");
    assert.deepEqual(f.sent[0].body, {
      model: "rocinante-12b",
      messages: [
        { role: "system", content: "You are a villager." },
        { role: "user", content: "Hello" },
      ],
      max_tokens: 64,
      temperature: 0.8,
    });
    assert.deepEqual(r, { text: "Hi there", usage: { in: 11, out: 3 }, model: "L3-8B-Stheno" });
  });

  it("sends no system message, temperature or key it wasn't given", async () => {
    const f = fakeFetch(() => completion("ok"));
    await openAiChat({ baseUrl: "http://x/v1", fetch: f }, { model: "m", messages: [{ role: "user", content: "u" }] });
    assert.deepEqual(f.sent[0].body, { model: "m", messages: [{ role: "user", content: "u" }] });
    assert.equal(f.sent[0].headers.Authorization, undefined);
  });

  it("estimates usage (chars/4) when the server omits it", async () => {
    const f = fakeFetch(() => json({ choices: [{ message: { content: "12345678" } }] }));
    const r = await openAiChat({ baseUrl: "http://x/v1", fetch: f }, { model: "m", system: "abcd", messages: [{ role: "user", content: "efgh" }] });
    assert.deepEqual(r.usage, { in: 2, out: 2 });
    assert.equal(r.model, undefined);
  });

  it("turns a non-2xx reply into an http LlmError named by the label", async () => {
    const f = fakeFetch(() => new Response("model not loaded", { status: 503 }));
    await assert.rejects(openAiChat({ baseUrl: "http://x/v1", label: "local LLM", fetch: f }, ask), (e: LlmError) => {
      assert.equal(e.kind, "http");
      assert.equal(e.status, 503);
      assert.equal(e.message, "local LLM 503: model not loaded");
      return true;
    });
  });

  it("times out, aborts, and reports an unreachable server, each as its own kind", async () => {
    await assert.rejects(openAiChat({ baseUrl: "http://x/v1", fetch: hangingFetch, timeoutMs: 30 }, ask), { kind: "timeout", message: "LLM timed out after 30ms" });
    const ctrl = new AbortController();
    const p = openAiChat({ baseUrl: "http://x/v1", fetch: hangingFetch }, { ...ask, signal: ctrl.signal });
    ctrl.abort();
    await assert.rejects(p, { kind: "aborted" });
    const down = fakeFetch(() => Promise.reject(new TypeError("fetch failed")));
    await assert.rejects(openAiChat({ baseUrl: "http://x/v1", fetch: down }, ask), { kind: "unreachable", message: "LLM unreachable: TypeError: fetch failed" });
  });

  it("the request's timeout beats the config's", async () => {
    await assert.rejects(openAiChat({ baseUrl: "http://x/v1", fetch: hangingFetch, timeoutMs: 60_000 }, { ...ask, timeoutMs: 20 }), { kind: "timeout" });
  });

  it("rejects an empty reply, retries it with a warmer temperature when asked, or allows it", async () => {
    await assert.rejects(openAiChat({ baseUrl: "http://x/v1", fetch: fakeFetch(() => completion("")) }, ask), { kind: "empty", message: "LLM returned no content" });
    const f = fakeFetch((_req, n) => completion(n === 0 ? "" : "second try"));
    const r = await openAiChat({ baseUrl: "http://x/v1", fetch: f }, { ...ask, emptyRetries: 1 });
    assert.equal(r.text, "second try");
    assert.deepEqual(f.sent.map((s) => s.body?.temperature), [0.8, 0.8 + 0.15]);
    const allowed = await openAiChat({ baseUrl: "http://x/v1", fetch: fakeFetch(() => completion("")) }, { ...ask, allowEmpty: true });
    assert.equal(allowed.text, "");
  });
});

// Ported from starfall's server/localLlm.test.ts: the two silent-failure traps.
describe("grammar", () => {
  let root: string;
  let warnings: string[];
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "llm-kit-gbnf-"));
    warnings = [];
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  const send = async (grammar: string | undefined) => {
    const f = fakeFetch(() => completion("{}"));
    const cfg: OpenAiConfig = { baseUrl: "http://x/v1", grammar, fetch: f, onWarning: (m) => warnings.push(m) };
    await openAiChat(cfg, ask);
    return f.sent[0].body!;
  };

  it("sends a .gbnf file's contents, not its path", async () => {
    const p = join(root, "a.gbnf");
    writeFileSync(p, 'root ::= "x"\n');
    const body = await send(p);
    assert.equal(body.grammar, 'root ::= "x"\n');
    assert.deepEqual(grammarInfo(), { path: p, mtimeMs: grammarInfo(p)!.mtimeMs, size: 13, chars: 13 });
  });

  it("picks up an edit without a restart", async () => {
    const p = join(root, "b.gbnf");
    writeFileSync(p, 'root ::= "before"\n');
    assert.match(String((await send(p)).grammar), /before/);
    writeFileSync(p, 'root ::= "after-and-then-some"\n');
    const g = String((await send(p)).grammar);
    assert.match(g, /after-and-then-some/);
    assert.doesNotMatch(g, /before/);
  });

  it("normalizes CRLF to LF (koboldcpp drops a grammar containing CR)", async () => {
    const p = join(root, "c.gbnf");
    writeFileSync(p, 'root ::= "x"\r\nrule ::= "y"\r\n');
    assert.equal((await send(p)).grammar, 'root ::= "x"\nrule ::= "y"\n');
  });

  it("never sends a missing .gbnf path as inline grammar, and warns once per path", async () => {
    const missing = join(root, "nope.gbnf");
    const body = await send(missing);
    assert.equal("grammar" in body, false);
    await send(missing);
    await send(missing);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /UNCONSTRAINED/);
  });

  it("keeps the last good text when the file briefly disappears", async () => {
    const p = join(root, "d.gbnf");
    writeFileSync(p, 'root ::= "kept"\n');
    await send(p);
    rmSync(p);
    assert.equal((await send(p)).grammar, 'root ::= "kept"\n');
  });

  it('"json" sends response_format; inline grammar passes through; none sends neither', async () => {
    const j = await send("json");
    assert.deepEqual(j.response_format, { type: "json_object" });
    assert.equal("grammar" in j, false);
    assert.equal((await send('root ::= "inline"')).grammar, 'root ::= "inline"');
    const none = await send(undefined);
    assert.equal("grammar" in none, false);
    assert.equal("response_format" in none, false);
  });
});
