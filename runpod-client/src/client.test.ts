import assert from "node:assert/strict";
import { test } from "node:test";

import type { FetchLike } from "@btkulka/http-kit";
import { createRunPodClient, proxyUrl } from "./client.js";
import { isRunPodError, RunPodError } from "./errors.js";
import { planRental, rent, sweep } from "./rental.js";

interface Call {
  method: string;
  url: string;
  body?: unknown;
  auth?: string;
}

/** A fake RunPod: answers by route, records every call. */
function fakeRunPod(routes: Record<string, (c: Call) => { status?: number; body?: unknown }>) {
  const calls: Call[] = [];
  const fetchImpl = (async (url: string, init: { method?: string; headers?: Record<string, string>; body?: string } = {}) => {
    const u = new URL(url);
    const c: Call = { method: init.method ?? "GET", url, body: init.body ? JSON.parse(init.body) : undefined, auth: init.headers?.Authorization };
    calls.push(c);
    const key = `${c.method} ${u.pathname}`;
    const h = routes[key] ?? Object.entries(routes).find(([k]) => new RegExp(`^${k.replace(/\{id\}/g, "[^/]+")}$`).test(key))?.[1];
    const r = h ? h(c) : { status: 404, body: { message: "no route " + key } };
    const status = r.status ?? 200;
    const text = r.body === undefined ? "" : typeof r.body === "string" ? r.body : JSON.stringify(r.body);
    return { ok: status >= 200 && status < 300, status, headers: new Headers(), text: async () => text } as unknown as Response;
  }) as unknown as FetchLike;
  return { fetchImpl, calls };
}

const CATALOG = {
  gpus: [
    { id: "NVIDIA GeForce RTX 4090", name: "RTX 4090", memory: 24, community: true, secure: true, price: { community: 0.34, secure: 0.89 }, availability: "HIGH" },
    { id: "NVIDIA A40", name: "A40", memory: 48, community: true, secure: true, price: { community: 0.35, secure: 0.59 }, availability: "MEDIUM" },
    { id: "NVIDIA L40S", name: "L40S", memory: 48, community: true, secure: true, price: { community: 0.79, secure: 1.09 }, availability: "LOW" },
    { id: "NVIDIA H100 80GB HBM3", name: "H100", memory: 80, community: false, secure: true, price: { secure: 2.99 }, availability: "HIGH" },
    { id: "NVIDIA RTX A2000", name: "A2000", memory: 6, community: true, price: { community: 0.1 }, availability: "HIGH" },
  ],
};

test("the client sends the key, reads the catalog with its filters, and terminates (404 is fine)", async () => {
  const { fetchImpl, calls } = fakeRunPod({
    "GET /v2/catalog/gpus": () => ({ body: CATALOG }),
    "DELETE /v2/pods/{id}": (c) => (c.url.endsWith("gone") ? { status: 404, body: { message: "not found" } } : { status: 204 }),
  });
  const client = createRunPodClient({ apiKey: "rpa_test", fetch: fetchImpl });
  const gpus = await client.gpus({ cloud: "COMMUNITY", minCudaVersion: "13.0" });
  assert.equal(gpus.length, 5);
  const q = new URL(calls[0].url).searchParams;
  assert.equal(q.get("cloud"), "COMMUNITY");
  assert.equal(q.get("minCudaVersion"), "13.0");
  assert.deepEqual(q.getAll("product"), ["POD"]);
  assert.equal(calls[0].auth, "Bearer rpa_test");
  assert.equal(await client.terminate("abc"), true);
  assert.equal(await client.terminate("gone"), false);
});

test("an error carries RunPod's message and a category", async () => {
  const { fetchImpl } = fakeRunPod({
    "GET /v2/account": () => ({ status: 401, body: { message: "invalid api key" } }),
    "POST /v2/pods": () => ({ status: 400, body: { message: "There are no longer any instances available with the requested specifications." } }),
  });
  const client = createRunPodClient({ apiKey: "bad", fetch: fetchImpl });
  await assert.rejects(client.account(), (e: unknown) => isRunPodError(e, "auth") && /invalid api key/.test((e as Error).message));
  await assert.rejects(client.createPod({ name: "x" }), (e: unknown) => isRunPodError(e, "capacity"));
  assert.throws(() => createRunPodClient({ apiKey: "" }), (e: unknown) => e instanceof RunPodError && e.category === "auth");
});

test("planRental keeps what fits, cheapest first, and refuses what the budget can't cover", async () => {
  const { fetchImpl } = fakeRunPod({ "GET /v2/catalog/gpus": (c) => ({ body: new URL(c.url).searchParams.get("cloud") === "SECURE" ? { gpus: CATALOG.gpus.filter((g) => g.secure) } : CATALOG }) });
  const client = createRunPodClient({ apiKey: "k", fetch: fetchImpl });
  const plan = await planRental(client, { minMemoryGb: 40, maxMinutes: 60, budgetUsd: 1 });
  assert.equal(plan.ok, true);
  assert.deepEqual(plan.candidates.map((c) => `${c.name}/${c.cloud}`), ["A40/COMMUNITY", "L40S/COMMUNITY", "A40/SECURE"], "the H100 is over the $1 an hour the budget allows; the 24 GB card doesn't fit");
  assert.equal(plan.minCostUsd, 0.35);
  assert.equal(plan.maxCostUsd, 0.79);
  const tight = await planRental(client, { minMemoryGb: 40, maxMinutes: 60, budgetUsd: 0.2 });
  assert.equal(tight.ok, false);
  assert.match(tight.reason ?? "", /over the \$0\.20 budget/);
  const none = await planRental(client, { minMemoryGb: 200 });
  assert.equal(none.ok, false);
  assert.match(none.reason ?? "", /No GPU with 200 GB/);
});

test("rent skips a GPU with no machine free, names the pod, and terminate ends it", async () => {
  let creates = 0;
  const { fetchImpl, calls } = fakeRunPod({
    "GET /v2/catalog/gpus": () => ({ body: CATALOG }),
    "POST /v2/pods": (c) => {
      creates++;
      const gpu = (c.body as { gpu: { id: string } }).gpu.id;
      if (gpu === "NVIDIA A40") return { status: 400, body: { message: "There are no longer any instances available with the requested specifications." } };
      return { status: 201, body: { id: "pod123", name: (c.body as { name: string }).name, status: "PROVISIONING" } };
    },
    "DELETE /v2/pods/{id}": () => ({ status: 204 }),
  });
  const client = createRunPodClient({ apiKey: "k", fetch: fetchImpl });
  const plan = await planRental(client, { minMemoryGb: 40, maxMinutes: 30, budgetUsd: 5, clouds: ["COMMUNITY"] });
  const r = await rent(client, { name: "trellis", plan, image: "img", apiKey: "k", ports: ["8188/http"], logDir: process.env.TEMP ?? "/tmp" });
  assert.equal(creates, 2);
  assert.equal(r.candidate.name, "L40S");
  assert.match(r.pod.name, /^btkulka-trellis-\d{8}-\d{6}$/);
  assert.equal(r.url(8188), "https://pod123-8188.proxy.runpod.net");
  assert.ok(r.deadline - r.startedAt === 30 * 60_000);
  await r.terminate();
  await r.terminate();
  assert.equal(calls.filter((c) => c.method === "DELETE").length, 1, "terminate is idempotent");
  await assert.rejects(rent(client, { name: "x", plan: { ...plan, ok: false, reason: "nope" }, image: "i", apiKey: "k" }), (e: unknown) => isRunPodError(e, "budget"));
});

test("planRental keeps NVIDIA cards only and skips MIG slices unless asked", async () => {
  const live = {
    gpus: [
      { id: "AMD Instinct MI300X OAM", name: "MI300X", manufacturer: "AMD", memory: 192, community: true, price: { community: 0.5 }, availability: "LOW" },
      { id: "NVIDIA RTX PRO 6000 Blackwell Server Edition MIG 2g.48gb", name: "RTX PRO 6000 MIG 2g.48gb", manufacturer: "NVIDIA", memory: 48, community: true, price: { community: 0.6 }, availability: "LOW" },
      { id: "NVIDIA RTX A6000", name: "RTX A6000", manufacturer: "NVIDIA", memory: 48, community: true, price: { community: 0.69 }, availability: "LOW" },
      { id: "NVIDIA A40", name: "A40", memory: 48, community: true, price: { community: 0.35 }, availability: "NONE" },
    ],
  };
  const { fetchImpl } = fakeRunPod({ "GET /v2/catalog/gpus": () => ({ body: live }) });
  const client = createRunPodClient({ apiKey: "k", fetch: fetchImpl });
  const plan = await planRental(client, { minMemoryGb: 40, clouds: ["COMMUNITY"], budgetUsd: 5 });
  assert.deepEqual(plan.candidates.map((c) => c.name), ["RTX A6000"], "AMD is out, the MIG slice is out, the A40 has no stock");
  const withMig = await planRental(client, { minMemoryGb: 40, clouds: ["COMMUNITY"], budgetUsd: 5, includeMig: true });
  assert.deepEqual(withMig.candidates.map((c) => c.name), ["RTX PRO 6000 MIG 2g.48gb", "RTX A6000"]);
  const any = await planRental(client, { minMemoryGb: 40, clouds: ["COMMUNITY"], budgetUsd: 5, manufacturer: null });
  assert.equal(any.candidates[0].name, "MI300X");
});

test("sweep ends only this package's pods", async () => {
  const deleted: string[] = [];
  const { fetchImpl } = fakeRunPod({
    "GET /v2/pods": () => ({ body: { pods: [{ id: "a", name: "btkulka-trellis-1", status: "RUNNING" }, { id: "b", name: "someone-else", status: "RUNNING" }, { id: "c", name: "btkulka-x", status: "TERMINATED" }] } }),
    "DELETE /v2/pods/{id}": (c) => (deleted.push(c.url.split("/").pop() as string), { status: 204 }),
  });
  const client = createRunPodClient({ apiKey: "k", fetch: fetchImpl });
  assert.deepEqual(await sweep(client), ["a"]);
  assert.deepEqual(deleted, ["a"]);
});

test("proxyUrl is RunPod's HTTPS proxy form", () => {
  assert.equal(proxyUrl("abc123xyz", 8000), "https://abc123xyz-8000.proxy.runpod.net");
});
