import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readablePath } from "./blockfiles.js";
import { ChatHost } from "./host.js";
import { fromWrapper, rowMaker } from "./items.js";
import type { AgentSdk, CanUseToolLike, QueryLike, SdkMessage, SdkUserMessage, SlashCommandLike } from "./sdk.js";
import type { ClaudeEvent } from "../types.js";
import { httpHandler } from "../http/index.js";

/** A stand-in Agent SDK: each query() records its options and the messages it reads, and the test says what comes back. With `tools`, it hosts in-process tools too (their handlers kept in `tools`). */
function fakeSdk(o: { tools?: boolean; commands?: SlashCommandLike[] } = {}) {
  const tools = new Map<string, (args: Record<string, unknown>, extra: unknown) => Promise<{ content: { type: string; text: string }[]; isError?: boolean }>>();
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
        initializationResult: async () => ({ models: [{ value: "default", displayName: "Default" }], commands: o.commands }),
        ...(o.commands ? { supportedCommands: async () => o.commands! } : {}),
      };
      return q;
    },
    listSessions: async () => [{ sessionId: "old", cwd: tmpdir(), summary: "An old chat about tests", lastModified: Date.now() }],
    getSessionInfo: async (id) => (id === "old" ? { sessionId: "old", cwd: tmpdir(), summary: "An old chat about tests", lastModified: Date.now() } : undefined),
    ...(o.tools
      ? {
          tool: (name: string, _d: string, _shape: unknown, handler: (args: Record<string, unknown>, extra: unknown) => Promise<{ content: { type: string; text: string }[] }>) => (tools.set(name, handler), { name }),
          createSdkMcpServer: (c: { name: string; tools?: unknown[] }) => ({ type: "sdk", name: c.name, tools: c.tools }),
        }
      : {}),
  };
  return { sdk, queries, tools };
}

const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));

function setup(o: { tools?: boolean; blocks?: boolean; commands?: SlashCommandLike[] } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "claude-kit-"));
  const { sdk, queries, tools } = fakeSdk(o);
  const events: ClaudeEvent[] = [];
  const host = new ChatHost({ sdk: async () => sdk, dataDir: dir, app: "test/0", folder: tmpdir(), systemPrompt: "You're in a test.", blocks: o.blocks });
  host.on((e) => events.push(e));
  return { host, queries, events, tools, done: () => (host.dispose(), rmSync(dir, { recursive: true, force: true })) };
}

/** Claude calls await_feedback: its tool row, then the call (the CLI says which tool use it is). */
async function callBlock(q: { say(m: SdkMessage): void }, tools: ReturnType<typeof fakeSdk>["tools"], id: string, input: Record<string, unknown>) {
  q.say({ type: "assistant", parent_tool_use_id: null, uuid: `a-${id}`, message: { content: [{ type: "tool_use", id, name: "mcp__blocks__await_feedback", input }] } });
  await tick();
  const ctl = new AbortController();
  const result = tools.get("await_feedback")!(input, { _meta: { "claudecode/toolUseId": id }, signal: ctl.signal });
  await tick();
  return { result, cancel: () => ctl.abort() };
}

const blockRow = (host: ChatHost, id: string) => {
  const row = host.chatState().items.find((i) => i.id === id);
  return row?.kind === "tool" ? row.block : undefined;
};

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

  it("offers Always allow with no suggested rule, as the whole tool for the session", async () => {
    const { host, queries, done } = setup();
    try {
      await host.send("run it");
      await tick();
      const canUse = queries[0].options.canUseTool as CanUseToolLike;
      const answer = canUse("mcp__benhaus__status", {}, { signal: new AbortController().signal, toolUseID: "t2" });
      await tick();
      assert.equal(host.chatState().asks[0].canAlways, true);
      host.answer("t2", "always");
      assert.deepEqual((await answer).updatedPermissions, [{ type: "addRules", rules: [{ toolName: "mcp__benhaus__status" }], behavior: "allow", destination: "session" }]);
      const held = canUse("Bash", { command: "rm -rf x" }, { signal: new AbortController().signal, toolUseID: "t3", suppressAlwaysAllowRule: true });
      await tick();
      assert.equal(host.chatState().asks[0].canAlways, false);
      host.answer("t3", "deny");
      await held;
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

  it("says where a message was sent from: a line Claude reads, a tag on its row, read back from the transcript", async () => {
    const { host, queries, done } = setup();
    try {
      host.newChat({ context: "Release: Night Drive", text: "when is it out?", from: "phone · iPhone" });
      await tick();
      const said = queries.at(-1)!.got[0].message.content as string;
      assert.match(said, /^<app-context>\nRelease: Night Drive\n<\/app-context>\n\n<sent-from>phone · iPhone<\/sent-from>\nwhen is it out\?$/);
      const row = host.chatState().items[0];
      assert.equal(row.kind === "you" && row.text, "when is it out?");
      assert.equal(row.kind === "you" && row.from, "phone · iPhone");
      const rows = rowMaker(() => undefined, (t) => t.replace(/^<app-context>[\s\S]*?<\/app-context>\s*/, ""), fromWrapper("sent-from").read);
      const back = rows.fromTranscript([
        { type: "user", uuid: "u1", message: { content: said } },
        { type: "user", uuid: "u2", message: { content: "no tag on this one" } },
      ] as never);
      assert.deepEqual(
        back.map((i) => (i.kind === "you" ? [i.text, i.from] : undefined)),
        [
          ["when is it out?", "phone · iPhone"],
          ["no tag on this one", undefined],
        ],
      );
    } finally {
      done();
    }
  });

  it("names a chat, and a blank name names it for its first message again", async () => {
    const { host, done } = setup();
    try {
      await host.send("fix the build please");
      const id = host.state().current;
      assert.equal(host.configure(id, { title: "  Build fix \n and more" }).title, "Build fix");
      assert.equal(host.chatState("build fix").id, id);
      assert.equal(host.configure(id, { title: " " }).title, "fix the build please");
    } finally {
      done();
    }
  });

  it("lists a session's slash commands for the / menu, following its changes", async () => {
    const { host, queries, done } = setup({
      commands: [
        { name: "push-all", description: "Push everything", argumentHint: "" },
        { name: "review", description: "A plugin's review", argumentHint: "" },
        { name: "review", description: "Claude Code's review", argumentHint: "[pr]", aliases: ["code-review"], builtin: true },
        { name: "__remote", description: "Internal", argumentHint: "", builtin: true },
        { name: "color", description: "The prompt bar's color", argumentHint: "", builtin: true },
      ],
    });
    try {
      // The session starts for it; Claude Code's own wins a shared name (as /review runs it), and internal ones stay out.
      const list = await host.commands();
      assert.equal(queries.length, 1);
      assert.deepEqual(list, [
        { name: "push-all", description: "Push everything" },
        { name: "review", description: "Claude Code's review", hint: "[pr]", aliases: ["code-review"], builtin: true },
        { name: "color", description: "The prompt bar's color", builtin: true },
      ]);
      // Once Claude Code says which only a terminal can use, they're left out.
      queries[0].say({ type: "system", subtype: "init", session_id: "s1", model: "claude-test", terminal_slash_commands: ["color"] });
      await tick();
      assert.deepEqual((await host.commands()).map((c) => c.name), ["push-all", "review"]);
      // A skill found mid-session: the new list replaces the old.
      queries[0].say({ type: "system", subtype: "commands_changed", commands: [{ name: "new-skill", description: "Just added", argumentHint: "" }] });
      await tick();
      assert.deepEqual((await host.commands()).map((c) => c.name), ["new-skill"]);
    } finally {
      done();
    }
  });

  it("shows the background jobs a session runs until each ends, and keeps the session while one runs", async () => {
    const { host, queries, done } = setup();
    try {
      await host.send("run the build in the background");
      await tick();
      const q = queries[0];
      q.say({ type: "result", subtype: "success", result: "started" });
      q.say({ type: "system", subtype: "background_tasks_changed", tasks: [{ task_id: "b1", task_type: "local_bash", description: "npm run build" }, { task_id: "w1", task_type: "local_bash", description: "Watch the logs", ambient: true }] });
      q.say({ type: "system", subtype: "task_progress", task_id: "b1", description: "npm run build", usage: { total_tokens: 0, tool_uses: 1, duration_ms: 2000 }, last_tool_name: "Bash" });
      await tick();
      let job = host.chatState().jobs?.[0];
      assert.equal(host.chatState().jobs?.length, 1);
      assert.equal(job?.title, "npm run build");
      assert.equal(job?.line, "Using Bash");
      assert.ok(job && Date.now() - job.since >= 2000);
      // Asleep, every idle chat lets its session go, but not one with a job running.
      host.letIdleGo(true);
      assert.equal(host.chatState().status, "ready");
      q.say({ type: "system", subtype: "task_notification", task_id: "b1", status: "failed", summary: "Background command failed (exit code 1)", output_file: "x" });
      q.say({ type: "system", subtype: "background_tasks_changed", tasks: [] });
      await tick();
      job = host.chatState().jobs?.[0];
      assert.equal(job?.ended, "failed");
      assert.equal(job?.line, "Background command failed (exit code 1)");
      // Claude carries on by itself: that's a turn.
      q.say({ type: "stream_event", parent_tool_use_id: null, event: { type: "message_start" } });
      await tick();
      assert.equal(host.chatState().status, "working");
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

describe("ChatHost blocks", () => {
  it("gives each session the await_feedback tool, lets AskUserQuestion through, and tells Claude", async () => {
    const { host, queries, done } = setup({ tools: true });
    try {
      await host.send("hi");
      await tick();
      const o = queries[0].options;
      assert.deepEqual(o.disallowedTools, []);
      assert.deepEqual(o.allowedTools, ["mcp__blocks__await_feedback"]);
      assert.deepEqual(Object.keys(o.mcpServers as object), ["blocks"]);
      assert.match(String((o.systemPrompt as { append: string }).append), /call mcp__blocks__await_feedback instead of asking in words/);
    } finally {
      done();
    }
  });

  it("holds the call until the block is answered, on its own row, and Claude gets the answer as JSON", async () => {
    const { host, queries, tools, done } = setup({ tools: true });
    try {
      await host.send("pick one");
      await tick();
      const q = queries[0];
      const { result } = await callBlock(q, tools, "toolu_1", { kind: "pick", title: "Which?", props: { images: [{ ref: "D:\\a.png", alt: "A" }, "D:\\b.png"] } });
      const c = host.chatState();
      assert.equal(c.blocks?.length, 1);
      assert.equal(c.blocks![0].id, "toolu_1");
      assert.equal(blockRow(host, "toolu_1")?.state, "waiting");
      assert.throws(() => host.reply("toolu_1", { value: 7 }), /No image 8/);
      host.reply("toolu_1", { value: 1 });
      const r = await result;
      assert.deepEqual(JSON.parse(r.content[0].text), { answered: true, value: { index: 1, ref: "D:\\b.png" }, said: "Picked 2 of 2 (D:\\b.png)" });
      assert.equal(host.chatState().blocks?.length, 0);
      assert.equal(blockRow(host, "toolu_1")?.state, "answered");
      assert.equal(blockRow(host, "toolu_1")?.answer?.said, "Picked 2 of 2 (D:\\b.png)");
      // The result arriving keeps the answer as it was said.
      q.say({ type: "user", parent_tool_use_id: null, message: { content: [{ type: "tool_result", tool_use_id: "toolu_1", content: r.content }] } });
      await tick();
      assert.equal(blockRow(host, "toolu_1")?.answer?.said, "Picked 2 of 2 (D:\\b.png)");
      assert.throws(() => host.reply("toolu_1", { value: 0 }), /No block toolu_1 is waiting/);
    } finally {
      done();
    }
  });

  it("puts a block up to look at with wait: false: the call returns at once, nothing waits, and its row stays shown", async () => {
    const { host, queries, tools, done } = setup({ tools: true });
    try {
      await host.send("show me");
      await tick();
      const q = queries[0];
      const { result } = await callBlock(q, tools, "toolu_v", { kind: "ui://gallery/video", app: "gallery", props: { videos: [{ ref: "D:\\v.mp4" }] }, wait: false });
      const r = await result;
      assert.deepEqual(JSON.parse(r.content[0].text), { shown: true });
      assert.equal(host.chatState().blocks?.length, 0, "nothing is waiting");
      assert.equal(blockRow(host, "toolu_v")?.state, "shown");
      q.say({ type: "user", parent_tool_use_id: null, message: { content: [{ type: "tool_result", tool_use_id: "toolu_v", content: r.content }] } });
      await tick();
      assert.equal(blockRow(host, "toolu_v")?.state, "shown", "its result keeps it shown");
      assert.throws(() => host.reply("toolu_v", { value: 0 }), /No block toolu_v is waiting/);
    } finally {
      done();
    }
  });

  it("sends a bad spec back to Claude to fix, without drawing anything", async () => {
    const { host, queries, tools, done } = setup({ tools: true });
    try {
      await host.send("x");
      await tick();
      queries[0].say({ type: "assistant", parent_tool_use_id: null, uuid: "a", message: { content: [{ type: "tool_use", id: "toolu_b", name: "mcp__blocks__await_feedback", input: { kind: "choice" } }] } });
      const r = await tools.get("await_feedback")!({ kind: "choice", props: {} }, { _meta: { "claudecode/toolUseId": "toolu_b" } });
      assert.equal(r.isError, true);
      assert.match(r.content[0].text, /options: give at least one/);
      assert.equal(host.chatState().blocks?.length, 0);
    } finally {
      done();
    }
  });

  it("takes words typed while a block waits as its answer, and a message with a file ends it instead", async () => {
    const { host, queries, tools, done } = setup({ tools: true });
    try {
      await host.send("go");
      await tick();
      const q = queries[0];
      const first = await callBlock(q, tools, "toolu_w", { kind: "choice", props: { options: ["Red", "Blue"] } });
      const rows = host.chatState().items.length;
      await host.send("green, actually");
      assert.deepEqual(JSON.parse((await first.result).content[0].text), { answered: true, text: "green, actually", said: 'Answered in words instead: "green, actually"' });
      assert.equal(host.chatState().items.length, rows, "the words show on the block, not as a message of their own");
      assert.equal(q.got.length, 1);

      const second = await callBlock(q, tools, "toolu_x", { kind: "confirm" });
      await host.send("see this", undefined, undefined, [{ data: Buffer.from("hi").toString("base64"), name: "note.txt" }]);
      assert.deepEqual(JSON.parse((await second.result).content[0].text), { expired: true, reason: "The user sent a message instead." });
      await tick();
      assert.equal(q.got.length, 2);
    } finally {
      done();
    }
  });

  it("ends a waiting block when the turn is stopped, its call is cancelled or its time runs out", async () => {
    const { host, queries, tools, done } = setup({ tools: true });
    try {
      await host.send("go");
      await tick();
      const q = queries[0];
      const a = await callBlock(q, tools, "toolu_s", { kind: "confirm" });
      await host.stop();
      assert.deepEqual(JSON.parse((await a.result).content[0].text), { expired: true, reason: "The user stopped this turn." });
      assert.equal(blockRow(host, "toolu_s")?.state, "expired");
      const b = await callBlock(q, tools, "toolu_c", { kind: "confirm" });
      b.cancel();
      assert.deepEqual(JSON.parse((await b.result).content[0].text), { expired: true, reason: "Cancelled." });
      const c = await callBlock(q, tools, "toolu_t", { kind: "confirm", timeoutS: 0.05 });
      assert.deepEqual(JSON.parse((await c.result).content[0].text), { expired: true, reason: "No answer after 0 seconds." });
    } finally {
      done();
    }
  });

  it("asks AskUserQuestion's questions as a block, and gives Claude Code the answers", async () => {
    const { host, queries, done } = setup({ tools: true });
    try {
      await host.send("ask me");
      await tick();
      const canUse = queries[0].options.canUseTool as CanUseToolLike;
      const input = { questions: [{ question: "Which fruit?", header: "Fruit", options: [{ label: "Apple", description: "" }, { label: "Pear", description: "" }], multiSelect: false }] };
      const answered = canUse("AskUserQuestion", input, { signal: new AbortController().signal, toolUseID: "toolu_q" });
      await tick();
      const b = host.chatState().blocks![0];
      assert.equal(b.kind, "questions");
      assert.equal(b.title, "Which fruit?");
      assert.equal(host.chatState().asks.length, 0);
      host.reply("toolu_q", { value: { "Which fruit?": "Pear" } });
      assert.deepEqual(await answered, { behavior: "allow", updatedInput: { ...input, answers: { "Which fruit?": "Pear" } } });
      const typed = canUse("AskUserQuestion", input, { signal: new AbortController().signal, toolUseID: "toolu_q2" });
      await tick();
      await host.send("neither");
      assert.deepEqual(await typed, { behavior: "allow", updatedInput: { ...input, answers: { "Which fruit?": "neither" } } });
    } finally {
      done();
    }
  });

  it("with blocks off, keeps AskUserQuestion off and adds no tool", async () => {
    const { host, queries, done } = setup({ tools: true, blocks: false });
    try {
      await host.send("hi");
      await tick();
      const o = queries[0].options;
      assert.deepEqual(o.disallowedTools, ["AskUserQuestion"]);
      assert.equal(o.mcpServers, undefined);
      assert.doesNotMatch(String((o.systemPrompt as { append: string }).append), /await_feedback/);
    } finally {
      done();
    }
  });

  it("lets an app page read the files its props name and the ones beside them, and nothing else", async () => {
    const { host, queries, tools, done } = setup({ tools: true });
    const dir = mkdtempSync(join(tmpdir(), "claude-kit-blockfiles-"));
    try {
      const models = join(dir, "models");
      mkdirSync(join(models, "tex"), { recursive: true });
      mkdirSync(join(dir, "other"));
      const glb = join(models, "ufo.glb");
      writeFileSync(glb, Buffer.from("glTF....model"));
      writeFileSync(join(models, "tex", "ufo.png"), "png");
      writeFileSync(join(dir, "secret.txt"), "above");
      writeFileSync(join(dir, "other", "x.obj"), "o x");
      await host.send("show it");
      await tick();
      const q = queries[0];
      const chat = host.chatState().id;
      // The ref arrives in the props as a file: address with the other slashes; the page asks with a plain path.
      const ref = `file:///${glb.replace(/\\/g, "/")}`;
      const shown = await callBlock(q, tools, "toolu_m", { kind: "ui://gallery/model", app: "gallery", props: { models: [{ ref, alt: "#4 ufo" }] } });
      const f = await host.blockFile(chat, "toolu_m", glb);
      assert.equal(f.name, "ufo.glb");
      assert.equal(f.type, "model/gltf-binary");
      assert.equal(f.size, 13);
      assert.equal(Buffer.from(f.bytes).toString(), "glTF....model");
      assert.equal((await host.blockFile(chat, "toolu_m", join(models, "tex", "ufo.png"))).type, "image/png");
      await assert.rejects(host.blockFile(chat, "toolu_m", join(dir, "secret.txt")), /didn't name secret\.txt/);
      await assert.rejects(host.blockFile(chat, "toolu_m", join(dir, "other", "x.obj")), /didn't name x\.obj/);
      await assert.rejects(host.blockFile(chat, "toolu_m", join(models, "..", "secret.txt")), /didn't name secret\.txt/);
      await assert.rejects(host.blockFile(chat, "toolu_m", "tex/ufo.png"), /isn't a file's path/);
      await assert.rejects(host.blockFile(chat, "toolu_m", join(models, "gone.glb")), /gone\.glb isn't there/);
      await assert.rejects(host.blockFile(chat, "toolu_nope", glb), /No block toolu_nope/);
      // Answered, it's still on its row: the page can finish what it was drawing.
      host.reply("toolu_m", { value: { index: 0 } });
      await shown.result;
      assert.equal((await host.blockFile(chat, "toolu_m", glb)).name, "ufo.glb");
      // A block that isn't an app's page reads nothing, whatever it names.
      const pick = await callBlock(q, tools, "toolu_p", { kind: "pick", props: { images: [join(models, "tex", "ufo.png")] } });
      await assert.rejects(host.blockFile(chat, "toolu_p", join(models, "tex", "ufo.png")), /Only an app's page reads files/);
      host.reply("toolu_p", { value: 0 });
      await pick.result;
    } finally {
      done();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("opens nothing beside a named folder or a file at a drive's root", () => {
    const dir = mkdtempSync(join(tmpdir(), "claude-kit-named-"));
    try {
      writeFileSync(join(dir, "a.txt"), "a");
      assert.throws(() => readablePath(join(dir, "a.txt"), { folder: dir }), /didn't name a\.txt/);
      assert.equal(readablePath(dir, { folder: dir }), dir);
      const root = process.platform === "win32" ? "C:\\x.glb" : "/x.glb";
      assert.throws(() => readablePath(process.platform === "win32" ? "C:\\Windows\\win.ini" : "/etc/hosts", { ref: root }), /didn't name/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reads blocks back from a transcript as they ended", () => {
    const rows = rowMaker(() => undefined, (t) => t);
    const items = rows.fromTranscript([
      { type: "assistant", uuid: "u1", message: { content: [{ type: "tool_use", id: "t1", name: "mcp__blocks__await_feedback", input: { kind: "choice", title: "Color?", props: { options: ["Red", "Blue"] } } }] } },
      { type: "user", uuid: "u2", message: { content: [{ type: "tool_result", tool_use_id: "t1", content: [{ type: "text", text: '{"answered":true,"value":"Blue","said":"Chose \\"Blue\\""}' }] }] } },
      { type: "assistant", uuid: "u3", message: { content: [{ type: "tool_use", id: "t2", name: "AskUserQuestion", input: { questions: [{ question: "Which fruit?", options: ["Apple", "Pear"] }] } }] } },
      { type: "user", uuid: "u4", message: { content: [{ type: "tool_result", tool_use_id: "t2", content: 'Your questions have been answered: "Which fruit?"="Pear". You can now continue with these answers in mind.' }] } },
      { type: "assistant", uuid: "u5", message: { content: [{ type: "tool_use", id: "t3", name: "mcp__blocks__await_feedback", input: { kind: "confirm" } }] } },
      { type: "user", uuid: "u6", message: { content: [{ type: "tool_result", tool_use_id: "t3", content: '{"expired":true,"reason":"Ben stopped this turn."}' }] } },
    ] as never);
    const blocks = items.map((i) => (i.kind === "tool" ? i.block : undefined));
    assert.deepEqual(blocks[0]?.answer, { value: "Blue", said: 'Chose "Blue"' });
    assert.equal(blocks[0]?.title, "Color?");
    assert.deepEqual(blocks[1]?.answer, { value: { "Which fruit?": "Pear" }, said: "Which fruit? → Pear" });
    assert.equal(blocks[2]?.state, "expired");
    assert.equal(blocks[2]?.reason, "Ben stopped this turn.");
  });

  it("stamps a tool row read back with when its result came", () => {
    const rows = rowMaker(() => undefined, (t) => t);
    const items = rows.fromTranscript([
      { type: "assistant", uuid: "u1", timestamp: "2026-11-20T18:40:00.000Z", message: { content: [{ type: "tool_use", id: "t1", name: "Read", input: { file_path: "a.ts" } }, { type: "tool_use", id: "t2", name: "Read", input: { file_path: "b.ts" } }] } },
      { type: "user", uuid: "u2", timestamp: "2026-11-20T18:40:02.500Z", message: { content: [{ type: "tool_result", tool_use_id: "t1", content: "a" }] } },
    ] as never);
    const at = items.map((i) => (i.kind === "tool" ? i.at : undefined));
    assert.deepEqual(at, ["2026-11-20T18:40:02.500Z", undefined]);
  });
});

describe("ChatHost limits", () => {
  it("keeps chats to the host's modes, folder, and no past chats or terminal", async () => {
    const dir = mkdtempSync(join(tmpdir(), "claude-kit-"));
    const { sdk, queries } = fakeSdk();
    const home = mkdtempSync(join(tmpdir(), "claude-kit-home-"));
    const host = new ChatHost({ sdk: async () => sdk, dataDir: dir, app: "test/0", folder: home, mode: "bypassPermissions", modes: ["acceptEdits", "plan"], pastChats: "none", terminal: false, lockFolder: true, intro: "Claude Code for this app.", verbosity: "conversational" });
    try {
      const s = host.state();
      assert.deepEqual(s.limits, { modes: ["acceptEdits", "plan"], past: false, terminal: false });
      assert.equal(s.intro, "Claude Code for this app.");
      assert.equal(s.verbosity, "conversational");
      // A default outside the list falls to the first allowed mode.
      assert.equal(s.chats[0].mode, "acceptEdits");
      assert.throws(() => host.configure(undefined, { mode: "bypassPermissions" }), /can't be put in bypassPermissions/);
      assert.equal(host.configure(undefined, { mode: "plan" }).mode, "plan");
      assert.deepEqual(await host.past(), { total: 0, chats: [] });
      await assert.rejects(host.load("old"), /Past chats aren't open/);
      assert.throws(() => host.terminal(), /isn't open here/);
      // A screen asking for another folder still gets the host's.
      assert.equal(host.newChat({ text: "x", folder: tmpdir() }).folder, home);
      await host.send("hello");
      await tick();
      assert.equal(queries.at(-1)?.options.allowDangerouslySkipPermissions, false);
      assert.equal(queries.at(-1)?.options.cwd, home);
    } finally {
      host.dispose();
      rmSync(dir, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("leaves everything open without limits", async () => {
    const { host, queries, done } = setup();
    try {
      assert.deepEqual(host.state().limits, { modes: undefined, past: true, terminal: true });
      assert.equal(host.configure(undefined, { mode: "bypassPermissions" }).mode, "bypassPermissions");
      await host.send("hi");
      await tick();
      assert.equal(queries.at(-1)?.options.allowDangerouslySkipPermissions, true);
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

  it("files go with a message: by path, or uploaded and kept; listed to Claude after the words, chips on the row", async () => {
    const { host, queries, done } = setup();
    const dir = mkdtempSync(join(tmpdir(), "claude-kit-files-"));
    try {
      const notes = join(dir, "notes.txt");
      writeFileSync(notes, "hello");
      await host.send("read this", undefined, undefined, [{ path: notes }, { data: Buffer.from("x,y\n1,2").toString("base64"), name: "sheet.csv" }, { path: dir }]);
      await tick();
      const content = queries[0].got[0].message.content;
      const text = typeof content === "string" ? content : String(content.find((b) => b.type === "text")?.text);
      assert.match(text, /^read this\n\nAttached files \(on this machine; read them with your tools as needed\):\n- .*notes\.txt \(5 bytes\)\n- .*[\\/][a-f0-9]{12}-sheet\.csv \(7 bytes\)\n- .* \(a folder\)$/);
      const row = host.state().chats[0].items.find((i) => i.kind === "you");
      assert.ok(row && row.kind === "you" && row.files?.length === 3);
      assert.equal(row.files[0].name, "notes.txt");
      assert.equal(row.files[1].name, "sheet.csv");
      assert.equal(row.files[2].size, undefined);
      await assert.rejects(host.send("", undefined, undefined, [{ path: join(dir, "missing.pdf") }]), /isn't there/);
    } finally {
      done();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
