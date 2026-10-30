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
