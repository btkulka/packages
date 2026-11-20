// The fake fetch every test here runs against: canned replies in order (or a router), every request recorded,
// and a small fake Meshy (tasks that move PENDING → IN_PROGRESS → SUCCEEDED as they are polled, a balance, signed
// asset URLs). Nothing talks to Meshy. It's a .test file so neither build ships it.

import assert from "node:assert/strict";
import { test } from "node:test";
import { createMeshyClient, type FetchLikeInit, type MeshyClientOptions, type MeshyFetch, type Task } from "./index.js";

export type Reply = { status: number; body?: unknown; headers?: Record<string, string> } | Error;

export interface FakeCall {
  url: string;
  /** The path and query, without https://api.meshy.ai */
  path: string;
  method: string;
  headers: Record<string, string>;
  /** The body parsed from JSON; undefined when none was sent. */
  body: unknown;
  init: FetchLikeInit;
}

/** Replies in order (the last repeats), or a function of the request. A Uint8Array body is served as bytes. */
export function fakeFetch(replies: Reply[] | ((call: FakeCall, n: number) => Reply)) {
  const calls: FakeCall[] = [];
  let i = 0;
  const fetch: MeshyFetch = (url, init = {}) => {
    const call: FakeCall = {
      url,
      path: url.replace(/^https:\/\/api\.meshy\.ai/, ""),
      method: init.method ?? "GET",
      headers: init.headers ?? {},
      body: init.body === undefined ? undefined : JSON.parse(init.body),
      init,
    };
    calls.push(call);
    const n = i++;
    const r = typeof replies === "function" ? replies(call, n) : replies[Math.min(n, replies.length - 1)]!;
    if (r instanceof Error) return Promise.reject(r);
    const h = new Map(Object.entries(r.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
    const bytes = r.body instanceof Uint8Array ? r.body : undefined;
    const text = bytes ? String.fromCharCode(...bytes) : r.body === undefined ? "" : typeof r.body === "string" ? r.body : JSON.stringify(r.body);
    return Promise.resolve({
      ok: r.status >= 200 && r.status < 300,
      status: r.status,
      headers: { get: (k: string) => h.get(k.toLowerCase()) ?? null },
      text: async () => text,
      arrayBuffer: async () => (bytes ?? new TextEncoder().encode(text)).slice().buffer as ArrayBuffer,
    });
  };
  return { fetch, calls };
}

/** A 200 with this body. */
export const ok = (body: unknown = {}, headers?: Record<string, string>): Reply => ({ status: 200, body, headers });
/** Meshy's error body: `{ message }`. */
export const failure = (status: number, message: string, headers?: Record<string, string>): Reply => ({ status, body: { message }, headers });

export const GLB = new Uint8Array([0x67, 0x6c, 0x54, 0x46, 2, 0, 0, 0]);
export const PNG = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
export const ASSETS = "https://assets.meshy.ai/u1/tasks";

/** A task in a state, with signed URLs once SUCCEEDED (textures when `textured`). */
export function task(id: string, status: Task["status"], extra: Partial<Task> & { textured?: boolean } = {}): Task {
  const { textured, ...rest } = extra;
  const done = status === "SUCCEEDED";
  return {
    id,
    type: "image-to-3d",
    status,
    progress: done ? 100 : status === "IN_PROGRESS" ? 40 : 0,
    created_at: 1_763_500_000_000,
    started_at: status === "PENDING" ? 0 : 1_763_500_005_000,
    finished_at: done ? 1_763_500_065_000 : 0,
    preceding_tasks: status === "PENDING" ? 2 : 0,
    model_urls: done ? { glb: `${ASSETS}/${id}/output/model.glb?Expires=1&Signature=abc`, obj: `${ASSETS}/${id}/output/model.obj?Expires=1&Signature=abc`, mtl: `${ASSETS}/${id}/output/model.mtl?Expires=1` } : {},
    texture_urls: done && textured ? [{ base_color: `${ASSETS}/${id}/output/texture_0.png?Expires=1`, normal: `${ASSETS}/${id}/output/texture_0_normal.png?Expires=1` }] : [],
    task_error: status === "FAILED" ? { type: "server_error", message: "An internal error occurred. Please retry." } : null,
    consumed_credits: status === "FAILED" ? 0 : textured ? 30 : 20,
    ...rest,
  };
}

export interface FakeMeshyOptions {
  /** What each new task goes through as it is polled (the last repeats). Default PENDING, IN_PROGRESS, SUCCEEDED. */
  states?: (id: string, body: Record<string, unknown>) => Task[];
  balance?: number;
  /** Replies for POST /openapi/v1/image-to-3d before the task is made (a 429, a 402…), in order. */
  createFails?: Reply[];
}

/** A fake Meshy: creates task-1, task-2… and moves each along `states` as it is polled. */
export function fakeMeshy(o: FakeMeshyOptions = {}) {
  const tasks = new Map<string, { states: Task[]; polls: number; body: Record<string, unknown> }>();
  let made = 0;
  let creates = 0;
  const balance = { value: o.balance ?? 1000 };
  const states = o.states ?? ((id, body) => [task(id, "PENDING"), task(id, "IN_PROGRESS"), task(id, "SUCCEEDED", { textured: body.should_texture === true })]);
  const f = fakeFetch((call) => {
    if (call.url.startsWith(ASSETS)) return { status: 200, body: call.url.includes(".png") ? PNG : GLB };
    if (call.path === "/openapi/v1/balance") return ok({ balance: balance.value, monthly_credits: 600, permanent_credits: balance.value - 600, monthly_resets_at: 1_764_547_200_000 });
    if (call.method === "POST" && call.path === "/openapi/v1/image-to-3d") {
      const fail = o.createFails?.[creates++];
      if (fail) return fail;
      const id = `task-${++made}`;
      const body = call.body as Record<string, unknown>;
      tasks.set(id, { states: states(id, body), polls: 0, body });
      return { status: 202, body: { result: id } };
    }
    const m = /^\/openapi\/v1\/image-to-3d\/([^/?]+)$/.exec(call.path);
    if (m && call.method === "GET") {
      const t = tasks.get(decodeURIComponent(m[1]!));
      if (!t) return failure(404, "Task not found");
      const s = t.states[Math.min(t.polls++, t.states.length - 1)]!;
      return ok(s, s.status === "SUCCEEDED" || s.status === "FAILED" ? undefined : { "Retry-After": "0" });
    }
    return failure(404, `No route for ${call.method} ${call.path}`);
  });
  return { ...f, tasks, balance, posts: () => f.calls.filter((c) => c.method === "POST") };
}

/** A client on the fake: no backoff unless the test says otherwise. */
export const testClient = (fetch: MeshyFetch, extra: Partial<MeshyClientOptions> = {}) => createMeshyClient({ apiKey: "msy_test", fetch, baseDelayMs: 0, ...extra });

test("the fake fetch replays its replies in order, repeats the last, serves bytes and records each request", async () => {
  const { fetch, calls } = fakeFetch([ok({ n: 1 }), { status: 200, body: new Uint8Array([1, 2, 255]) }]);
  const a = await fetch("https://api.meshy.ai/x?y=1", { method: "POST", body: '{"a":1}' });
  const b = await fetch("https://api.meshy.ai/x");
  const c = await fetch("https://api.meshy.ai/x");
  assert.deepEqual(JSON.parse(await a.text()), { n: 1 });
  assert.deepEqual([...new Uint8Array(await b.arrayBuffer!())], [1, 2, 255]);
  assert.equal(c.status, 200);
  assert.equal(calls[0]!.path, "/x?y=1");
  assert.equal(calls[0]!.method, "POST");
  assert.deepEqual(calls[0]!.body, { a: 1 });
  assert.equal(calls[1]!.body, undefined);
});
