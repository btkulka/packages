import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createBenhausClient } from "./client.js";
import { readDiscovery, type BenhausDiscovery } from "./discovery.js";
import { isBenhausError } from "./errors.js";

type Seen = { url: string; auth: string; body: { method: string; params: { name: string; arguments: Record<string, unknown> } } };

function fakeFetch(answer: (s: Seen) => { status?: number; body: unknown } | Error) {
  const seen: Seen[] = [];
  const f = (async (url: string | URL, init?: RequestInit) => {
    const s: Seen = {
      url: String(url),
      auth: String((init?.headers as Record<string, string> | undefined)?.authorization ?? ""),
      body: init?.body ? JSON.parse(String(init.body)) : { method: "GET", params: { name: "", arguments: {} } },
    };
    seen.push(s);
    const a = answer(s);
    if (a instanceof Error) throw a;
    return new Response(typeof a.body === "string" ? a.body : JSON.stringify(a.body), { status: a.status ?? 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return { f, seen };
}

const ok = (value: unknown, isError = false) => ({ body: { jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value) }], ...(isError ? { isError: true } : {}) } } });
const disc = (token = "t1", port = 4790): BenhausDiscovery => ({ url: `http://127.0.0.1:${port}/mcp`, port, token });

test("call parses a tool's JSON text and sends the token", async () => {
  const { f, seen } = fakeFetch(() => ok({ threads: [], errors: [] }));
  const c = createBenhausClient({ discover: () => disc(), fetch: f });
  const r = await c.mail.search({ query: "in:inbox", limit: 5 });
  assert.deepEqual(r, { threads: [], errors: [] });
  assert.equal(seen[0].auth, "Bearer t1");
  assert.equal(seen[0].body.method, "tools/call");
  assert.deepEqual(seen[0].body.params, { name: "search_mail", arguments: { query: "in:inbox", limit: 5 } });
});

test("send maps camelCase to Benhäus's argument names and drops unset ones", async () => {
  const { f, seen } = fakeFetch(() => ok({ sent: true, account: "a@x.com", thread_id: "t", to: "b@x.com", subject: "Re: hi", url: "u" }));
  const c = createBenhausClient({ discover: () => disc(), fetch: f });
  await c.mail.send({ account: "a@x.com", body: "Hello", replyToThreadId: "abc" });
  assert.deepEqual(seen[0].body.params.arguments, { account: "a@x.com", body: "Hello", reply_to_thread_id: "abc" });
});

test("calendar events take Dates and calendar ids", async () => {
  const { f, seen } = fakeFetch(() => ok({ from: "", to: "", events: [] }));
  const c = createBenhausClient({ discover: () => disc(), fetch: f });
  await c.calendar.events({ from: new Date("2027-06-12T05:00:00Z"), days: 1, calendarId: "dj@x.com", account: "a@x.com" });
  assert.deepEqual(seen[0].body.params.arguments, { from: "2027-06-12T05:00:00.000Z", days: 1, account: "a@x.com", calendar_id: "dj@x.com" });
});

test("a tool error throws kind tool and reads what Google needs", async () => {
  const { f } = fakeFetch(() => ok("Google signed x@y.com out of Benhäus. Sign in again in Settings › Accounts.", true));
  const c = createBenhausClient({ discover: () => disc(), fetch: f });
  await assert.rejects(c.mail.thread({ account: "x@y.com", threadId: "1" }), (e) => isBenhausError(e, "tool") && e.needs === "signin" && e.tool === "get_mail_thread");
});

test("callTool hands back a tool error without throwing", async () => {
  const { f } = fakeFetch(() => ok("Benhäus has no tool called nope.", true));
  const c = createBenhausClient({ discover: () => disc(), fetch: f });
  const r = await c.callTool("nope");
  assert.equal(r.isError, true);
  assert.match(r.text, /no tool called nope/);
});

test("a refused token re-reads the discovery file once", async () => {
  let reads = 0;
  const { f, seen } = fakeFetch((s) => (s.auth === "Bearer new" ? ok({ ok: 1 }) : { status: 401, body: { error: "unauthorized" } }));
  const c = createBenhausClient({ discover: () => disc(reads++ === 0 ? "old" : "new"), fetch: f });
  assert.deepEqual(await c.call("status"), { ok: 1 });
  assert.equal(seen.length, 2);
  assert.equal(c.discovery()?.token, "new");
});

test("no discovery file is offline", async () => {
  const c = createBenhausClient({ discover: () => undefined, fetch: fakeFetch(() => ok({})).f });
  await assert.rejects(c.call("status"), (e) => isBenhausError(e, "offline"));
  assert.equal(await c.health(), undefined);
});

test("a connection refused twice is offline", async () => {
  const { f, seen } = fakeFetch(() => Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } }));
  const c = createBenhausClient({ discover: () => disc(), fetch: f });
  await assert.rejects(c.call("status"), (e) => isBenhausError(e, "offline"));
  assert.equal(seen.length, 2);
});

test("non-JSON tool text comes back as text", async () => {
  const { f } = fakeFetch(() => ok("Done."));
  const c = createBenhausClient({ discover: () => disc(), fetch: f });
  assert.equal(await c.call<string>("post_notification", { title: "x" }), "Done.");
});

test("an SSE-framed answer is read from its last data line", async () => {
  const { f } = fakeFetch(() => ({ body: `event: message\ndata: ${JSON.stringify(ok({ a: 1 }).body)}\n\n` }));
  const c = createBenhausClient({ discover: () => disc(), fetch: f });
  assert.deepEqual(await c.call("status"), { a: 1 });
});

test("health goes to /health without a token", async () => {
  const { f, seen } = fakeFetch(() => ({ body: { ok: true, app: "Benhäus", version: "0.1.0" } }));
  const c = createBenhausClient({ discover: () => disc(), fetch: f });
  assert.deepEqual(await c.health(), { ok: true, app: "Benhäus", version: "0.1.0" });
  assert.equal(seen[0].url, "http://127.0.0.1:4790/health");
});

test("readDiscovery reads the file and rejects one without a token", () => {
  const dir = mkdtempSync(join(tmpdir(), "benhaus-client-"));
  const good = join(dir, "good.json");
  const bad = join(dir, "bad.json");
  writeFileSync(good, JSON.stringify({ url: "http://127.0.0.1:4791/mcp", token: "abc", pid: 7 }));
  writeFileSync(bad, JSON.stringify({ url: "http://127.0.0.1:4791/mcp" }));
  assert.deepEqual(readDiscovery(good), { url: "http://127.0.0.1:4791/mcp", token: "abc", pid: 7, port: 4791 });
  assert.equal(readDiscovery(bad), undefined);
  assert.equal(readDiscovery(join(dir, "missing.json")), undefined);
});
