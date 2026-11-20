import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { bytesToBase64 } from "../bytes.js";
import { fakeFetch, ok } from "../fake-fetch.test.js";
import { DEFAULT_IMAGE_MODEL } from "../pricing.js";
import { modelFlag, nameFrom, parseImageJobs, runImage, type ImageCliIo } from "./image-run.js";

const PNG = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
const drawn = { id: "int-1", status: "completed", steps: [{ type: "model_output", content: [{ type: "text", text: "done" }, { type: "image", mime_type: "image/png", data: bytesToBase64(PNG) }] }], usage: { total_input_tokens: 100, total_output_tokens: 1120 } };
const dirs: string[] = [];
after(() => Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true }))));

async function scratch(): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), "gemini-image-"));
  dirs.push(d);
  return d;
}

function io(cwd: string, fetch = fakeFetch([ok(drawn)]).fetch) {
  const out: string[] = [];
  const err: string[] = [];
  const cli: ImageCliIo = { out: (l) => out.push(l), err: (l) => err.push(l), fetch, cwd, loadKey: async () => "AIza-test", baseDelayMs: 0 };
  return { cli, out, err };
}

test("names, model flags and jobs", () => {
  assert.equal(nameFrom("A brass safe-deposit drawer, toon!"), "a-brass-safe-deposit-drawer");
  assert.equal(modelFlag(undefined), DEFAULT_IMAGE_MODEL);
  assert.equal(modelFlag("nano-banana-2"), modelFlag("flash"));
  const jobs = parseImageJobs(JSON.stringify([{ name: "drawer", prompt: "x", refs: ["style.png"], count: 3 }]), "/base", { refs: [], aspect: "1:1", size: "2K", model: DEFAULT_IMAGE_MODEL, count: 1 });
  assert.equal(jobs[0]!.count, 3);
  assert.match(jobs[0]!.refs[0]!, /style\.png$/);
  assert.throws(() => parseImageJobs("[{\"prompt\":\"x\",\"size\":\"8K\"}]", "/", { refs: [], aspect: "1:1", size: "2K", model: DEFAULT_IMAGE_MODEL, count: 1 }), /size/);
});

test("without --yes it prints the estimate, sends nothing and exits 2", async () => {
  const d = await scratch();
  const f = fakeFetch([ok(drawn)]);
  const { cli, out } = io(d, f.fetch);
  assert.equal(await runImage(["a drawer", "--out", "o"], cli), 2);
  assert.equal(f.calls.length, 0);
  assert.match(out.join("\n"), /1 image, about \$0\.1\d/);
});

test("--dry-run prints the request with the reference shortened", async () => {
  const d = await scratch();
  await writeFile(join(d, "style.png"), PNG);
  const f = fakeFetch([ok(drawn)]);
  const { cli, out } = io(d, f.fetch);
  assert.equal(await runImage(["a drawer", "--out", "o", "--ref", "style.png", "--dry-run"], cli), 0);
  assert.equal(f.calls.length, 0);
  assert.match(out.join("\n"), /"data": "<base64>"/);
});

test("--yes writes each variation and a JSON note beside it, then skips them next time", async () => {
  const d = await scratch();
  const f = fakeFetch([ok(drawn)]);
  const { cli, out } = io(d, f.fetch);
  assert.equal(await runImage(["a drawer", "--out", "o", "--name", "drawer", "--count", "2", "--yes"], cli), 0);
  assert.equal(f.calls.length, 2);
  const files = (await readdir(join(d, "o"))).sort();
  assert.deepEqual(files, ["drawer-1.json", "drawer-1.png", "drawer-2.json", "drawer-2.png"]);
  assert.deepEqual([...(await readFile(join(d, "o", "drawer-1.png")))], [...PNG]);
  const meta = JSON.parse(await readFile(join(d, "o", "drawer-2.json"), "utf8"));
  assert.equal(meta.prompt, "a drawer");
  assert.equal(meta.text, "done");
  assert.match(out.join("\n"), /2 made/);
  const again = io(d, f.fetch);
  assert.equal(await runImage(["a drawer", "--out", "o", "--name", "drawer", "--count", "2", "--yes"], again.cli), 0);
  assert.equal(f.calls.length, 2);
});
