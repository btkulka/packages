import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ChatHost } from "./host.js";
import type { AgentSdk, CanUseToolLike, QueryLike, SdkMessage, SdkUserMessage } from "./sdk.js";
import type { ClaudeEvent } from "../types.js";
import { httpHandler } from "../http/index.js";

/** A stand-in Agent SDK: each query() records its options and the messages it reads, and the test says what comes back. */
function fakeSdk() {
  const queries: { options: Record<string, unknown>; got: SdkUserMessage[]; say(m: SdkMessage): void; end(): void; interrupted: number; closed: boolean }[] = [];
  const sdk: AgentSdk = {
    query({ prompt, options }) {
      const out: SdkMessage[] = [];
      let wake: (() => void) | undefined;
      let ended = false;
      const rec = {
        options,
        got: [] as SdkUserMessage[],
        interrupted: 0,
        closed: false,
        say: (m: SdkMessage) => (out.push(m), wake?.()),
        end: () => ((ended = true), wake?.()),
      };
      queries.push(rec);
      void (async () => {
        for await (const m of prompt) rec.got.push(m);
      })();
      const q: QueryLike = {
        async *[Symbol.asyncIterator]() {
          rec.say({ type: "system", subtype: "init", session_id: "s1", model: "claude-test", permissionMode: options.permissionMode });
          for (;;) {
            while (out.length) yield out.shift()!;
            if (ended || rec.closed) return;
            await new Promise<void>((r) => (wake = r));
          }
        },
        interrupt: async () => void rec.interrupted++,
        close: () => ((rec.closed = true), wake?.()),
        setPermissionMode: async () => undefined,
        setModel: async () => undefined,
        initializationResult: async () => ({ models: [{ value: "default", displayName: "Default" }] }),
      };
      return q;
    },
    listSessions: async () => [{ sessionId: "old", cwd: tmpdir(), summary: "An old chat about tests", lastModified: Date.now() }],
    getSessionInfo: async (id) => (id === "old" ? { sessionId: "old", cwd: tmpdir(), summary: "An old chat about tests", lastModified: Date.now() } : undefined),
  };
  return { sdk, queries };
}

const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "claude-kit-"));
  const { sdk, queries } = fakeSdk();
  const events: ClaudeEvent[] = [];
  const host = new ChatHost({ sdk: async () => sdk, dataDir: dir, app: "test/0", folder: tmpdir(), systemPrompt: "You're in a test." });
  host.on((e) => events.push(e));
  return { host, queries, events, done: () => (host.dispose(), rmSync(dir, { recursive: true, force: true })) };
}

describe("ChatHost", () => {
  it("starts a session at the first message and shows the reply", async () => {
    const { host, queries, events, done } = setup();
    try {
      const first = host.state();
      assert.equal(first.chats.length, 1);
      assert.equal(first.chats[0].status, "off");
      await host.send("hello there");
      await tick();
      assert.equal(queries.length, 1);
      const q = queries[0];
      assert.equal(q.options.cwd, tmpdir());
      assert.deepEqual(q.options.disallowedTools, ["AskUserQuestion"]);
      assert.match(String((q.options.systemPrompt as { append: string }).append), /You're in a test\. This chat shows images/);
      assert.equal(q.got[0].message.content, "hello there");
      q.say({ type: "stream_event", parent_tool_use_id: null, event: { type: "content_block_delta", delta: { type: "text_delta", text: "Hi" } } });
      await tick(80);
      assert.ok(events.some((e) => e.type === "stream" && e.payload.text === "Hi"));
      q.say({ type: "assistant", parent_tool_use_id: null, uuid: "a1", message: { content: [{ type: "text", text: "Hi, how can I help?" }] } });
      q.say({ type: "result", subtype: "success", is_error: false, result: "" });
      await tick();
      const c = host.chatState();
      assert.equal(c.status, "ready");
      assert.equal(c.sessionId, "s1");
      assert.equal(c.title, "hello there");
      assert.deepEqual(
        c.items.map((i) => i.kind),
        ["you", "claude"],
      );
    } finally {
      done();
    }
  });

  it("brings an ask to the screens and answers it", async () => {
    const { host, queries, done } = setup();
    try {
      await host.send("run it");
      await tick();
      const canUse = queries[0].options.canUseTool as CanUseToolLike;
      const answer = canUse("Bash", { command: "npm test" }, { signal: new AbortController().signal, toolUseID: "t1", suggestions: [{}] });
      await tick();
      const ask = host.chatState().asks[0];
      assert.equal(ask.detail, "npm test");
      assert.equal(ask.canAlways, true);
      host.answer("t1", "deny");
      assert.deepEqual(await answer, { behavior: "deny", message: "The user said no." });
      assert.equal(host.chatState().asks.length, 0);
    } finally {
      done();
    }
  });

  it("keeps a new chat in a blank one, and closes chats", async () => {
    const { host, done } = setup();
    try {
      const blank = host.state().current;
      assert.equal(host.newChat().id, blank);
      await host.send("first");
      const second = host.newChat({ title: "Second", context: "the page" });
      assert.notEqual(second.id, blank);
      assert.equal(host.state().chats.length, 2);
      assert.equal(host.close(second.id).chats.length, 1);
    } finally {
      done();
    }
  });

  it("sends a new chat's context ahead of its first message, out of sight", async () => {
    const { host, queries, done } = setup();
    try {
      await host.send("x");
      host.newChat({ context: "Release: Night Drive", about: "Night Drive", text: "when is it out?" });
      await tick();
      const said = queries.at(-1)!.got[0].message.content as string;
      assert.match(said, /^<app-context>\nRelease: Night Drive\n<\/app-context>\n\nwhen is it out\?$/);
      const shown = host.chatState();
      assert.equal(shown.about, "Night Drive");
      assert.equal(shown.items[0].kind === "you" && shown.items[0].text, "when is it out?");
    } finally {
      done();
    }
  });

  it("lists and picks up past chats", async () => {
    const { host, done } = setup();
    try {
      const past = await host.past({ query: "tests" });
      assert.equal(past.total, 1);
      assert.equal(past.chats[0].title, "An old chat about tests");
      const all = await host.load("old");
      assert.equal(all.chats.find((c) => c.id === all.current)?.sessionId, "old");
    } finally {
      done();
    }
  });
});

describe("httpHandler", () => {
  it("turns away a connection from another machine, even with Host: localhost", () => {
    const { host, done } = setup();
    try {
      let status = 0;
      const req = { url: "/claude/rpc", method: "POST", headers: { host: "localhost:4747", "content-type": "application/json" }, socket: { remoteAddress: "100.102.17.49" } };
      const res = { writeHead: (s: number) => void (status = s), end: () => undefined };
      httpHandler(host)(req as never, res as never);
      assert.equal(status, 403);
    } finally {
      done();
    }
  });

  it("answers rpc from this machine and turns other origins away", async () => {
    const { host, done } = setup();
    const server = createServer(httpHandler(host));
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as { port: number }).port;
    const base = `http://127.0.0.1:${port}/claude`;
    try {
      const rpc = (method: string, args: unknown[] = [], headers: Record<string, string> = {}) =>
        fetch(`${base}/rpc`, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify({ method, args }) });
      const ok = (await (await rpc("state")).json()) as { ok: boolean; value: { chats: unknown[] } };
      assert.equal(ok.ok, true);
      assert.equal(ok.value.chats.length, 1);
      assert.equal((await rpc("state", [], { Origin: "https://evil.example" })).status, 403);
      assert.equal((await rpc("state", [], { "Sec-Fetch-Site": "cross-site" })).status, 403);
      // A left-out argument arrives as null over JSON, and counts as left out.
      const sent = (await (await rpc("send", ["hi", null, null])).json()) as { ok: boolean; value: { items: { kind: string }[] } };
      assert.equal(sent.ok, true);
      assert.equal(sent.value.items.at(-1)?.kind, "you");
      const bad = (await (await rpc("dispose")).json()) as { ok: boolean };
      assert.equal(bad.ok, false);
      const plain = await fetch(`${base}/rpc`, { method: "POST", headers: { "Content-Type": "text/plain" }, body: "{}" });
      assert.equal(plain.status, 415);
      const el = await fetch(`${base}/element.js`);
      assert.equal(el.status, 200);
      assert.match(el.headers.get("content-type") ?? "", /javascript/);
    } finally {
      server.close();
      done();
    }
  });
});
