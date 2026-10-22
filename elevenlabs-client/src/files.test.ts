import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cachedAudio, requestHash, writeAudioFile } from "./index.js";

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "elevenlabs-client-"));
}

test("writeAudioFile creates folders, writes the bytes and leaves no temp file", async () => {
  const dir = tempDir();
  try {
    const target = join(dir, "a", "b", "take 1.mp3");
    await writeAudioFile(target, new Uint8Array([1, 2, 3]));
    assert.deepEqual([...readFileSync(target)], [1, 2, 3]);
    await writeAudioFile(target, new Uint8Array([9])); // replaces an existing file
    assert.deepEqual([...readFileSync(target)], [9]);
    assert.deepEqual(readdirSync(join(dir, "a", "b")), ["take 1.mp3"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("cachedAudio renders once, then serves the file", async () => {
  const dir = tempDir();
  try {
    const p = join(dir, "cache", "abc.mp3");
    let renders = 0;
    const render = async () => {
      renders++;
      return new Uint8Array([renders]);
    };
    assert.deepEqual(await cachedAudio(p, render), { path: p, cached: false });
    assert.deepEqual(await cachedAudio(p, render), { path: p, cached: true });
    assert.equal(renders, 1);
    assert.deepEqual(await cachedAudio(p, render, { force: true }), { path: p, cached: false });
    assert.equal(renders, 2);
    assert.deepEqual([...readFileSync(p)], [2]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an empty cache file counts as missing; a failed render writes nothing", async () => {
  const dir = tempDir();
  try {
    const p = join(dir, "x.mp3");
    writeFileSync(p, "");
    assert.equal((await cachedAudio(p, async () => new Uint8Array([7]))).cached, false);
    assert.deepEqual([...readFileSync(p)], [7]);

    const q = join(dir, "y.mp3");
    await assert.rejects(cachedAudio(q, async () => { throw new Error("402"); }), /402/);
    assert.deepEqual(readdirSync(dir).sort(), ["x.mp3"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("requestHash is sha1(JSON.stringify(value)) cut to length, so existing cache names keep matching", () => {
  const req = { text: "ひゃっ！", voice: "lhTvHflPVOqgSWyuWQry", modelId: "eleven_multilingual_v2", settings: { stability: 0.4 }, format: "mp3_44100_128" };
  const full = createHash("sha1").update(JSON.stringify(req)).digest("hex");
  assert.equal(requestHash(req), full.slice(0, 20));
  assert.equal(requestHash(req, 16), full.slice(0, 16));
  assert.notEqual(requestHash({ ...req, format: "pcm_24000" }), requestHash(req));
});
