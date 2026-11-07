import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { completed, fakeFetch, inProgress, ok } from "../fake-fetch.test.js";
import { run, type CliIo } from "./run.js";

const MP4 = new Uint8Array([0, 0, 0, 24, 102, 116, 121, 112]);
const dirs: string[] = [];
after(() => Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true }))));

async function scratch(): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), "gemini-video-"));
  dirs.push(d);
  return d;
}

function io(cwd: string, fetch = fakeFetch([ok()]).fetch, key: string | null = "AIza-test") {
  const out: string[] = [];
  const err: string[] = [];
  const keys: string[] = [];
  const cli: CliIo = {
    out: (l) => out.push(l),
    err: (l) => err.push(l),
    fetch,
    cwd,
    pollMs: 1,
    loadKey: async (credential, app) => {
      keys.push(`${credential} ${app}`);
      return key ?? undefined;
    },
  };
  return { cli, out, err, keys, text: () => out.join("\n"), errText: () => err.join("\n") };
}

const JOBS = [
  { name: "bar-01", prompt: "Phone footage of a crowded neon bar, people laughing", seconds: 8 },
  { name: "club-02", prompt: "Phone footage of a packed club dance floor, strobe lights", seconds: 6, resolution: "1080p" },
];

test("without --yes it prints the estimate and sends nothing, not even for the key", async () => {
  const cwd = await scratch();
  await writeFile(join(cwd, "jobs.json"), JSON.stringify(JOBS));
  const f = fakeFetch([ok()]);
  const t = io(cwd, f.fetch);
  const code = await run(["--jobs", "jobs.json", "--out", "clips"], t.cli);
  assert.equal(code, 2);
  assert.equal(f.calls.length, 0);
  assert.equal(t.keys.length, 0);
  assert.match(t.text(), /bar-01: gemini-omni-1\.1-flash 9:16 720p 8s {2}~\$0\.81/);
  assert.match(t.text(), /club-02: .* 1080p 6s {2}~\$0\.61 \(assumes the 720p rate\)/);
  assert.match(t.text(), /Estimated cost: \$1\.42 for 2 new clips/);
  assert.match(t.text(), /Prices read 2026-11-02 from https:\/\/aistudio\.google\.com\/docs\/pricing/);
  assert.match(t.text(), /Run again with --yes/);
});

test("--dry-run prints each request with the key hidden and sends nothing", async () => {
  const cwd = await scratch();
  const f = fakeFetch([ok()]);
  const t = io(cwd, f.fetch);
  const code = await run(["A bartender pours a drink", "--out", "o", "--name", "pour", "--seconds", "5", "--negative", "text", "--dry-run"], t.cli);
  assert.equal(code, 0);
  assert.equal(f.calls.length, 0);
  assert.equal(t.keys.length, 0);
  const s = t.text();
  assert.match(s, /POST https:\/\/generativelanguage\.googleapis\.com\/v1beta\/interactions/);
  assert.match(s, /x-goog-api-key: <the gemini\/toejam key>/);
  assert.match(s, /"aspect_ratio": "9:16"/);
  assert.match(s, /"duration": "5s"/);
  assert.match(s, /Avoid: text\./);
  assert.doesNotMatch(s, /AIza/);
});

test("--yes makes each clip: start, poll, download, <name>.mp4, and the pending record goes", async () => {
  const cwd = await scratch();
  await writeFile(join(cwd, "jobs.json"), JSON.stringify(JOBS));
  const polls = new Map<string, number>();
  const f = fakeFetch((c) => {
    if (c.method === "POST") return ok(inProgress(c.body && (c.body as { input: string }).input.includes("bar") ? "int-bar" : "int-club"));
    const id = c.path.split("/").pop()!;
    const n = (polls.get(id) ?? 0) + 1;
    polls.set(id, n);
    return ok(n < 2 ? inProgress(id) : completed(id, MP4));
  });
  const t = io(cwd, f.fetch);
  const code = await run(["--jobs", "jobs.json", "--out", "clips", "--yes"], t.cli);
  assert.equal(code, 0, t.errText() + t.text());
  assert.deepEqual(t.keys, ["gemini/toejam toejam"]);
  assert.deepEqual([...(await readFile(join(cwd, "clips", "bar-01.mp4")))], [...MP4]);
  assert.deepEqual([...(await readFile(join(cwd, "clips", "club-02.mp4")))], [...MP4]);
  assert.deepEqual(await readdir(join(cwd, "clips", ".gemini-video")), []);
  assert.equal(f.calls.filter((c) => c.method === "POST").length, 2);
  assert.match(t.text(), /2 made, 0 not; \$\d+\.\d+ by Google's usage counts/);
});

test("a clip that's already there is skipped; a pending one is picked up without a new start", async () => {
  const cwd = await scratch();
  await writeFile(join(cwd, "jobs.json"), JSON.stringify(JOBS));
  await mkdir(join(cwd, "clips", ".gemini-video"), { recursive: true });
  await writeFile(join(cwd, "clips", "bar-01.mp4"), "old");
  await writeFile(join(cwd, "clips", ".gemini-video", "club-02.json"), JSON.stringify({ id: "int-old", name: "club-02", model: "gemini-omni-1.1-flash", startedAt: "2026-11-02T20:00:00Z" }));
  const f = fakeFetch([ok(completed("int-old", MP4))]);
  const t = io(cwd, f.fetch);
  const code = await run(["--jobs", "jobs.json", "--out", "clips", "--yes"], t.cli);
  assert.equal(code, 0, t.text());
  assert.match(t.text(), /bar-01: already there, skipped/);
  assert.match(t.text(), /club-02: picking up int-old .* \(no new charge\)/);
  assert.match(t.text(), /Estimated cost: \$0\.00 for 0 new clips/);
  assert.deepEqual(f.calls.map((c) => `${c.method} ${c.path}`), ["GET /interactions/int-old"]);
  assert.equal(await readFile(join(cwd, "clips", "bar-01.mp4"), "utf8"), "old");
});

test("no key: says where to put one and sends nothing", async () => {
  const cwd = await scratch();
  const f = fakeFetch([ok()]);
  const t = io(cwd, f.fetch, null);
  const code = await run(["A club", "--out", "o", "--yes"], t.cli);
  assert.equal(code, 1);
  assert.equal(f.calls.length, 0);
  assert.match(t.errText(), /Settings › Credentials › Add › "Gemini \(Google AI Studio\)" with the id gemini\/toejam, or set GEMINI_API_KEY/);
});

test("a Veo model, a bad flag or a bad jobs file stops the run before anything is sent", async () => {
  const cwd = await scratch();
  await writeFile(join(cwd, "bad.json"), "{ not json");
  for (const argv of [
    ["A club", "--out", "o", "--model", "veo-3.1-generate-preview", "--yes"],
    ["A club", "--out", "o", "--seconds", "30", "--yes"],
    ["A club", "--out", "o", "--wat"],
    ["--jobs", "bad.json", "--out", "o", "--yes"],
    ["A club", "--yes"],
  ]) {
    const f = fakeFetch([ok()]);
    const t = io(cwd, f.fetch);
    assert.equal(await run(argv, t.cli), 1, argv.join(" "));
    assert.equal(f.calls.length, 0);
    assert.equal(t.keys.length, 0);
  }
});

test("a refused generation is reported with a hint, and its pending record is dropped", async () => {
  const cwd = await scratch();
  const f = fakeFetch((c) => (c.method === "POST" ? ok(inProgress("int-x")) : ok({ id: "int-x", status: "failed", errors: [{ message: "Blocked by safety policy." }] })));
  const t = io(cwd, f.fetch);
  const code = await run(["A club", "--out", "o", "--name", "x", "--yes"], t.cli);
  assert.equal(code, 1);
  assert.match(t.text(), /\[x\] failed: .*Blocked by safety policy/);
  assert.match(t.text(), /\[x\] Google's filters refused it/);
  assert.deepEqual(await readdir(join(cwd, "o", ".gemini-video")), []);
});

test("Ctrl+C keeps the pending record so the next run picks the clip up", async () => {
  const cwd = await scratch();
  const ac = new AbortController();
  const f = fakeFetch((c) => {
    if (c.method === "POST") return ok(inProgress("int-y"));
    setTimeout(() => ac.abort(), 0);
    return ok(inProgress("int-y"));
  });
  const t = io(cwd, f.fetch);
  const code = await run(["A club", "--out", "o", "--name", "y", "--yes"], { ...t.cli, signal: ac.signal, pollMs: 50 });
  assert.equal(code, 1);
  assert.match(t.text(), /stopped waiting; int-y carries on at Google/);
  const rec = JSON.parse(await readFile(join(cwd, "o", ".gemini-video", "y.json"), "utf8"));
  assert.equal(rec.id, "int-y");
});

test("--help", async () => {
  const t = io(await scratch());
  assert.equal(await run(["--help"], t.cli), 0);
  assert.match(t.text(), /gemini-video "<prompt>" --out <folder>/);
});
