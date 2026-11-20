import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { failure, fakeMeshy, GLB, PNG, task } from "../fake-fetch.test.js";
import type { MeshyFetch } from "../client.js";
import type { MeshyRunRecord } from "./record.js";
import { runMeshy, type MeshyCliIo } from "./run.js";

const dirs: string[] = [];
after(() => Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true }))));

/** A temp folder with concept images in it. */
async function scratch(...images: string[]): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), "meshy-3d-"));
  dirs.push(d);
  for (const i of images.length ? images : ["tower.png"]) {
    await mkdir(join(d, i, ".."), { recursive: true });
    await writeFile(join(d, i), PNG);
  }
  return d;
}

function io(cwd: string, fetch: MeshyFetch, extra: Partial<MeshyCliIo> = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const cli: MeshyCliIo = { out: (l) => out.push(l), err: (l) => err.push(l), fetch, cwd, loadKey: async () => "msy_test", baseDelayMs: 0, pollIntervalMs: 0, pollMaxIntervalMs: 0, ...extra };
  return { cli, out, err, text: () => out.join("\n"), errors: () => err.join("\n") };
}

const recordIn = async (dir: string): Promise<MeshyRunRecord> => {
  const name = (await readdir(dir)).find((f) => /^meshy-\d{8}T\d{6}Z(-\d+)?\.json$/.test(f));
  assert.ok(name, "a run record");
  return JSON.parse(await readFile(join(dir, name), "utf8")) as MeshyRunRecord;
};

test("without --yes it prints the plan (jobs, credits, balance), sends nothing and exits 2", async () => {
  const d = await scratch("tower.png", "vault.png");
  const m = fakeMeshy();
  const r = io(d, m.fetch);
  assert.equal(await runMeshy(["--image", "tower.png", "--image", "vault.png", "--name", "t", "--name", "v", "--out", "o", "--texture"], r.cli), 2);
  assert.equal(m.posts().length, 0);
  const t = r.text();
  assert.match(t, /2 models, 60 credits/);
  assert.match(t, /credits only/);
  assert.match(t, /t-textured: latest, textured 2k, 30 credits/);
  assert.match(t, /Balance: 1,000 credits \(600 monthly, renewing \d{4}-\d{2}-\d{2}; 400 permanent\)/);
  assert.match(t, /Run again with --yes/);
});

test("--dry-run prints each request with the image shortened", async () => {
  const d = await scratch();
  const m = fakeMeshy();
  const r = io(d, m.fetch);
  assert.equal(await runMeshy(["--image", "tower.png", "--out", "o", "--smart-topology", "--polycount", "8000", "--dry-run"], r.cli), 0);
  assert.equal(m.posts().length, 0);
  const t = r.text();
  assert.match(t, /"image_url": "data:image\/png;base64,<1 KB>"/);
  assert.match(t, /"model_type": "smart-topology"/);
  assert.match(t, /"target_polycount": 8000/);
  assert.match(t, /"target_formats": \[\s*"glb"\s*\]/);
});

test("--yes makes each model: the GLB, its .meta.json and the run record; a second run skips it", async () => {
  const d = await scratch("concept/tower.png", "concept/vault.png");
  const m = fakeMeshy();
  const r = io(d, m.fetch);
  assert.equal(await runMeshy(["--image", "concept/tower.png", "--image", "concept/vault.png", "--out", "models", "--usd-per-credit", "pro", "--yes"], r.cli), 0, r.errors());
  assert.equal(m.posts().length, 2);
  const out = join(d, "models");
  const files = (await readdir(out)).sort();
  assert.deepEqual(files.filter((f) => !f.startsWith("meshy-")), ["tower.glb", "tower.meta.json", "vault.glb", "vault.meta.json"]);
  assert.deepEqual([...(await readFile(join(out, "tower.glb")))], [...GLB]);
  const meta = JSON.parse(await readFile(join(out, "tower.meta.json"), "utf8"));
  assert.equal(meta.tool, "@btkulka/meshy-client");
  assert.match(meta.task, /^task-\d$/);
  assert.equal(meta.credits, 20);
  assert.equal(meta.usd, 0.4);
  assert.match(meta.image, /concept\/tower\.png$/);
  assert.equal(meta.model, "latest");
  assert.equal(meta.options.should_texture, false);
  assert.equal(meta.options.image_url, undefined, "no data URI in the sidecar");
  assert.equal(typeof meta.secs, "number");
  const rec = await recordIn(out);
  assert.equal(rec.kind, "meshy-run");
  assert.equal(rec.tool, "@btkulka/meshy-client meshy-3d");
  assert.equal(rec.running, false);
  assert.equal(rec.ok, true);
  assert.equal(rec.credits, 40);
  assert.equal(rec.estimated, false);
  assert.equal(rec.usdPerCredit, 0.02);
  assert.equal(rec.usd, 0.8);
  assert.equal(rec.balanceBefore, 1000);
  assert.deepEqual(rec.models.sort(), ["tower", "vault"]);
  assert.deepEqual(rec.jobs.map((j) => j.status), ["SUCCEEDED", "SUCCEEDED"]);
  assert.deepEqual(rec.failures, []);
  assert.match(r.text(), /2 made, 40 credits \(\$0\.80\)/);
  assert.equal((await readdir(out)).includes(".meshy"), false, "nothing left pending");

  const again = io(d, m.fetch);
  assert.equal(await runMeshy(["--image", "concept/tower.png", "--image", "concept/vault.png", "--out", "models", "--yes"], again.cli), 0);
  assert.equal(m.posts().length, 2);
  assert.match(again.text(), /\[tower\] already there, skipped/);
});

test("textured: <name>-textured.glb, its texture maps and <name>-textured.meta.json; OBJ with its .mtl when asked", async () => {
  const d = await scratch();
  const m = fakeMeshy();
  const r = io(d, m.fetch);
  assert.equal(await runMeshy(["--image", "tower.png", "--out", "o", "--texture", "--pbr", "--formats", "obj", "--yes"], r.cli), 0, r.errors());
  const files = (await readdir(join(d, "o"))).filter((f) => !f.startsWith("meshy-")).sort();
  assert.deepEqual(files, ["tower-textured-base_color.png", "tower-textured-normal.png", "tower-textured.glb", "tower-textured.meta.json", "tower-textured.mtl", "tower-textured.obj"]);
  const body = m.posts()[0]!.body as Record<string, unknown>;
  assert.equal(body.should_texture, true);
  assert.equal(body.enable_pbr, true);
  assert.deepEqual(body.target_formats, ["glb", "obj"]);
  const rec = await recordIn(join(d, "o"));
  assert.equal(rec.credits, 30);
  assert.equal(rec.usd, null, "no rate: credits only");
});

test("a failed task: refunded (0 credits), listed in the record, not kept for a rerun; exit 1", async () => {
  const d = await scratch("tower.png", "vault.png");
  const m = fakeMeshy({ states: (id) => (id === "task-1" ? [task(id, "IN_PROGRESS"), task(id, "FAILED")] : [task(id, "SUCCEEDED")]) });
  const r = io(d, m.fetch, {});
  assert.equal(await runMeshy(["--image", "tower.png", "--image", "vault.png", "--out", "o", "--concurrency", "1", "--yes"], r.cli), 1);
  const rec = await recordIn(join(d, "o"));
  assert.equal(rec.ok, false);
  assert.equal(rec.credits, 20);
  assert.deepEqual(rec.jobs.map((j) => [j.name, j.status, j.credits]), [["tower", "FAILED", 0], ["vault", "SUCCEEDED", 20]]);
  assert.equal(rec.failures[0]!.name, "tower");
  assert.match(r.text(), /\[tower\] failed: .*server_error/);
  assert.match(r.text(), /run the same command again/);
  assert.equal((await readdir(join(d, "o"))).includes("tower.glb"), false);
});

test("a task an earlier run left is picked up without paying again, and its credits stay with that run", async () => {
  const d = await scratch();
  const m = fakeMeshy();
  // The earlier run: created task-1, then the terminal closed.
  const { tasks } = m;
  await m.fetch("https://api.meshy.ai/openapi/v1/image-to-3d", { method: "POST", body: JSON.stringify({ image_url: "x", should_texture: false }) });
  assert.ok(tasks.has("task-1"));
  await mkdir(join(d, "o", ".meshy"), { recursive: true });
  await writeFile(join(d, "o", ".meshy", "tower.json"), JSON.stringify({ task: "task-1", name: "tower" }));
  const r = io(d, m.fetch);
  assert.equal(await runMeshy(["--image", "tower.png", "--out", "o", "--yes"], r.cli), 0, r.errors());
  assert.equal(m.posts().length, 1, "no new task");
  assert.match(r.text(), /picking up task task-1 \(already paid for\)/);
  assert.match(r.text(), /1 model, 0 credits/);
  const rec = await recordIn(join(d, "o"));
  assert.equal(rec.jobs[0]!.resumed, true);
  assert.equal(rec.jobs[0]!.credits, 20);
  assert.equal(rec.credits, 0, "counted with the run that created it");
  assert.equal((await readdir(join(d, "o"))).includes("tower.glb"), true);
});

test("not enough credits, no key, or a refused key: nothing is sent", async () => {
  const d = await scratch();
  const poor = fakeMeshy({ balance: 10 });
  const r = io(d, poor.fetch);
  assert.equal(await runMeshy(["--image", "tower.png", "--out", "o", "--yes"], r.cli), 1);
  assert.match(r.errors(), /needs 20 credits and the balance is 10 credits/);
  assert.equal(poor.posts().length, 0);
  const m = fakeMeshy();
  const nokey = io(d, m.fetch, { loadKey: async () => undefined });
  assert.equal(await runMeshy(["--image", "tower.png", "--out", "o"], nokey.cli), 2);
  assert.match(nokey.text(), /Balance: no Meshy key yet/);
  assert.equal(await runMeshy(["--image", "tower.png", "--out", "o", "--yes"], nokey.cli), 1);
  assert.match(nokey.errors(), /No Meshy key/);
  assert.doesNotMatch(nokey.errors(), /msy_test/);
  const refused: MeshyFetch = async () => ({ ok: false, status: 401, text: async () => '{"message":"Invalid API key"}', headers: { get: () => null } });
  const bad = io(d, refused);
  assert.equal(await runMeshy(["--image", "tower.png", "--out", "o", "--yes"], bad.cli), 1);
  assert.match(bad.errors(), /refused the balance check/);
});

test("a 402 while creating stops the run: the rest aren't started", async () => {
  const d = await scratch("a.png", "b.png", "c.png");
  const m = fakeMeshy({ createFails: [failure(402, "Insufficient credits")] });
  const r = io(d, m.fetch);
  assert.equal(await runMeshy(["--image", "a.png", "--image", "b.png", "--image", "c.png", "--out", "o", "--concurrency", "1", "--yes"], r.cli), 1);
  assert.equal(m.posts().length, 1);
  assert.match(r.text(), /Not enough credits/);
  assert.match(r.text(), /0 made, 1 failed, 2 not started/);
  assert.equal((await readdir(join(d, "o"))).some((f) => f.startsWith("meshy-")), false, "nothing spent, no record");
});

test("a jobs file runs several at once and the usage is checked", async () => {
  const d = await scratch("a.png", "b.png", "c.png");
  await writeFile(join(d, "jobs.json"), JSON.stringify([{ image: "a.png" }, { image: "b.png", model: "meshy-6-lite" }, { image: "c.png", texture: true }]));
  const m = fakeMeshy();
  const r = io(d, m.fetch);
  assert.equal(await runMeshy(["--jobs", "jobs.json", "--out", "o", "--concurrency", "3", "--yes"], r.cli), 0, r.errors());
  assert.match(r.text(), /3 models, 55 credits/);
  assert.equal(m.posts().length, 3);
  const e = io(d, m.fetch);
  assert.equal(await runMeshy(["--out", "o"], e.cli), 1);
  assert.equal(await runMeshy(["--image", "a.png"], e.cli), 1);
  assert.equal(await runMeshy(["--image", "a.png", "--image", "b.png", "--name", "x", "--out", "o"], e.cli), 1);
  assert.equal(await runMeshy(["--image", "nope.png", "--out", "o"], e.cli), 1);
  assert.equal(await runMeshy(["--image", "a.png", "--out", "o", "--usd-per-credit", "lots"], e.cli), 1);
  assert.equal(await runMeshy(["--image", "a.png", "--out", "o", "--pbr"], e.cli), 1);
  assert.match(e.errors(), /enable_pbr needs should_texture/);
  assert.equal(await runMeshy(["--help"], e.cli), 0);
});
