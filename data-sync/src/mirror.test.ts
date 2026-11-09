import assert from "node:assert/strict";
import { mkdirSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { mirrorFolder } from "./index.js";
import { sandbox } from "./testing/drivers.js";

const put = (path: string, text: string, at: number) => {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, text);
  utimesSync(path, new Date(at), new Date(at));
};

test("copies what's missing or newer each way, keeps times, deletes nothing, skips temp and dot files", (t) => {
  const box = sandbox(t);
  const sync = box.file("sync");
  const pc = box.file("pc");
  const mac = box.file("mac");
  const t0 = Date.parse("2026-11-09T12:00:00Z");
  put(join(pc, "resume.pdf"), "v1", t0);
  put(join(pc, "covers", "acme.md"), "acme", t0);
  put(join(pc, ".DS_Store"), "junk", t0);
  put(join(pc, "x.sync-conflict-20261109-120000-ABC.pdf"), "conflict", t0);

  assert.deepEqual(mirrorFolder({ local: pc, app: "jobhunt", name: "resumes", dir: sync }).copiedOut.sort(), ["covers/acme.md", "resume.pdf"]);
  assert.deepEqual(mirrorFolder({ local: mac, app: "jobhunt", name: "resumes", dir: sync }).copiedIn.sort(), ["covers/acme.md", "resume.pdf"]);
  assert.equal(readFileSync(join(mac, "covers", "acme.md"), "utf8"), "acme");

  // The Mac edits the resume; the PC picks it up, and its older copy doesn't go back out.
  put(join(mac, "resume.pdf"), "v2", t0 + 60_000);
  assert.deepEqual(mirrorFolder({ local: mac, app: "jobhunt", name: "resumes", dir: sync }), { copiedIn: [], copiedOut: ["resume.pdf"] });
  assert.deepEqual(mirrorFolder({ local: pc, app: "jobhunt", name: "resumes", dir: sync }), { copiedIn: ["resume.pdf"], copiedOut: [] });
  assert.equal(readFileSync(join(pc, "resume.pdf"), "utf8"), "v2");
  assert.deepEqual(mirrorFolder({ local: pc, app: "jobhunt", name: "resumes", dir: sync }), { copiedIn: [], copiedOut: [] });
});
