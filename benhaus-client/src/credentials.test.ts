import assert from "node:assert/strict";
import { test } from "node:test";
import { createBenhausClient } from "./client.js";
import { applyBenhausEnv, loadCredential } from "./credentials.js";
import type { BenhausDiscovery } from "./discovery.js";

const disc = (): BenhausDiscovery => ({ url: "http://127.0.0.1:4790/mcp", port: 4790, token: "t1" });

function routes(answer: (path: string, body: Record<string, unknown>) => { status?: number; body: unknown } | Error) {
  const seen: { path: string; auth: string; body: Record<string, unknown> }[] = [];
  const f = (async (url: string | URL, init?: RequestInit) => {
    const path = new URL(String(url)).pathname;
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    seen.push({ path, auth: String((init?.headers as Record<string, string>)?.authorization ?? ""), body });
    const a = answer(path, body);
    if (a instanceof Error) throw a;
    return new Response(JSON.stringify(a.body), { status: a.status ?? 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return { f, seen };
}

test("credentials.get posts to /credentials/read with the token and the app", async () => {
  const { f, seen } = routes(() => ({ body: { id: "elevenlabs", fields: { apiKey: "k" }, updatedAt: "2026-10-29T00:00:00Z" } }));
  const c = createBenhausClient({ discover: disc, fetch: f });
  const r = await c.credentials.get("elevenlabs", { app: "orson" });
  assert.deepEqual(r?.fields, { apiKey: "k" });
  assert.equal(seen[0].path, "/credentials/read");
  assert.equal(seen[0].auth, "Bearer t1");
  assert.deepEqual(seen[0].body, { id: "elevenlabs", app: "orson" });
});

test("a missing credential is undefined; an old Benhäus without the route throws http", async () => {
  const missing = createBenhausClient({ discover: disc, fetch: routes(() => ({ status: 404, body: { error: "missing", id: "x" } })).f });
  assert.equal(await missing.credentials.get("x"), undefined);
  const old = createBenhausClient({ discover: disc, fetch: routes(() => ({ status: 404, body: { error: "not found" } })).f });
  await assert.rejects(old.credentials.get("x"), (e: Error & { kind?: string }) => e.kind === "http");
});

test("loadCredential prefers Benhäus and fills the rest from the environment", async () => {
  const client = createBenhausClient({ discover: disc, fetch: routes(() => ({ body: { id: "twilio/h", fields: { authToken: "from-benhaus" }, updatedAt: "u" } })).f });
  const r = await loadCredential("twilio/h", {
    client,
    env: { accountSid: "SID", authToken: "TOKEN" },
    source: { SID: "AC1", TOKEN: "from-env" },
    required: ["accountSid", "authToken"],
  });
  assert.deepEqual(r?.fields, { accountSid: "AC1", authToken: "from-benhaus" });
  assert.equal(r?.source, "both");
});

test("loadCredential falls back to the environment when Benhäus is closed", async () => {
  const closed = createBenhausClient({ discover: () => undefined });
  const r = await loadCredential("elevenlabs", { client: closed, env: { apiKey: "ELEVENLABS_API_KEY" }, source: { ELEVENLABS_API_KEY: "env-key" } });
  assert.deepEqual(r, { id: "elevenlabs", fields: { apiKey: "env-key" }, source: "env", updatedAt: undefined });
  assert.equal(await loadCredential("elevenlabs", { client: closed, env: { apiKey: "NOPE" }, source: {} }), undefined);
  assert.equal(await loadCredential("x", { client: closed, env: { a: "A" }, source: { A: "1" }, required: ["b"] }), undefined);
});

test("loadCredential rethrows a real Benhäus failure", async () => {
  const broken = createBenhausClient({ discover: disc, fetch: routes(() => ({ status: 500, body: { error: "boom" } })).f });
  await assert.rejects(loadCredential("x", { client: broken }), (e: Error & { kind?: string }) => e.kind === "http");
});

/** A Benhäus that takes these tokens on its /credentials routes, says 403 to `wrongTool` (another tool's) and 401 to the rest. `seen`: each call's authorization. */
function takes(tokens: string[], answer: { body: unknown }, wrongTool?: string) {
  const seen: string[] = [];
  const f = (async (_url: string | URL, init?: RequestInit) => {
    const auth = String((init?.headers as Record<string, string>)?.authorization ?? "");
    seen.push(auth);
    const token = auth.slice(7);
    if (token === wrongTool) return new Response(JSON.stringify({ error: "another tool's" }), { status: 403 });
    if (!tokens.includes(token)) return new Response(JSON.stringify({ error: "unauthorized" }), { status: 401 });
    return new Response(JSON.stringify(answer.body), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return { f, seen };
}

const withCred = (): BenhausDiscovery => ({ ...disc(), credentialsToken: "c1" });
const VALUES = { body: { id: "x", fields: { apiKey: "k" }, updatedAt: "u" } };

test("the /credentials routes take the credentials token first", async () => {
  const { f, seen } = takes(["c1"], VALUES);
  const c = createBenhausClient({ discover: withCred, fetch: f, toolToken: false });
  assert.deepEqual((await c.credentials.get("x"))?.fields, { apiKey: "k" });
  assert.deepEqual(seen, ["Bearer c1"]);
});

test("an older Benhäus, which takes the MCP token there, still answers", async () => {
  const { f, seen } = takes(["t1"], VALUES);
  const c = createBenhausClient({ discover: withCred, fetch: f, toolToken: false });
  assert.deepEqual((await c.credentials.get("x"))?.fields, { apiKey: "k" });
  assert.deepEqual(seen, ["Bearer c1", "Bearer t1"]);
});

test("without a credentials token (no file yet) a newer Benhäus refuses, and loadCredential falls back to the environment", async () => {
  const { f } = takes(["c1"], VALUES);
  const c = createBenhausClient({ discover: disc, fetch: f, toolToken: false });
  await assert.rejects(c.credentials.get("x"), (e: Error & { kind?: string }) => e.kind === "unauthorized");
  const r = await loadCredential("x", { client: c, env: { apiKey: "KEY" }, source: { KEY: "from-env" } });
  assert.deepEqual(r?.fields, { apiKey: "from-env" });
});

test("credentials.env tries the token Benhäus started this process with first, and goes on when it's refused", async () => {
  const env = { body: { env: { A: "1" }, missing: [] } };
  const own = takes(["tool1", "c1"], env);
  await createBenhausClient({ discover: withCred, fetch: own.f, toolToken: "tool1" }).credentials.env({ app: "orson" });
  assert.deepEqual(own.seen, ["Bearer tool1"]);

  const other = takes(["c1"], env, "tool1");
  const r = await createBenhausClient({ discover: withCred, fetch: other.f, toolToken: "tool1" }).credentials.env({ app: "orson" });
  assert.deepEqual(r, { env: { A: "1" }, missing: [] });
  assert.deepEqual(other.seen, ["Bearer tool1", "Bearer c1"]);
});

test("credentials.get never sends the tool token; toolToken false never uses BENHAUS_TOOL_TOKEN", async () => {
  const read = takes(["c1"], VALUES);
  await createBenhausClient({ discover: withCred, fetch: read.f, toolToken: "tool1" }).credentials.get("x");
  assert.deepEqual(read.seen, ["Bearer c1"]);

  const before = process.env.BENHAUS_TOOL_TOKEN;
  process.env.BENHAUS_TOOL_TOKEN = "from-env";
  try {
    const fromEnv = takes(["c1", "from-env"], { body: { env: {}, missing: [] } });
    await createBenhausClient({ discover: withCred, fetch: fromEnv.f }).credentials.env({ app: "orson" });
    assert.deepEqual(fromEnv.seen, ["Bearer from-env"]);
    const off = takes(["c1", "from-env"], { body: { env: {}, missing: [] } });
    await createBenhausClient({ discover: withCred, fetch: off.f, toolToken: false }).credentials.env({ app: "orson" });
    assert.deepEqual(off.seen, ["Bearer c1"]);
  } finally {
    if (before === undefined) delete process.env.BENHAUS_TOOL_TOKEN;
    else process.env.BENHAUS_TOOL_TOKEN = before;
  }
});

test("applyBenhausEnv sets injected variables, keeps ones already set, and is quiet when closed", async () => {
  const { f, seen } = routes(() => ({ body: { env: { A: "1", B: "2" }, missing: ["C (credential x#y)"] } }));
  const target: Record<string, string | undefined> = { B: "mine" };
  const r = await applyBenhausEnv({ app: "orson", client: createBenhausClient({ discover: disc, fetch: f }), target });
  assert.deepEqual(target, { A: "1", B: "mine" });
  assert.deepEqual(r, { applied: ["A"], kept: ["B"], missing: ["C (credential x#y)"], offline: false });
  assert.deepEqual(seen[0].body, { app: "orson" });
  const closed = await applyBenhausEnv({ app: "orson", client: createBenhausClient({ discover: () => undefined }), target: {} });
  assert.equal(closed.offline, true);
});
