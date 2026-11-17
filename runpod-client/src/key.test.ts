import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { readCliConfigKey } from "./key.js";

const write = (text: string) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "runpod-key-"));
  const file = path.join(dir, "config.toml");
  fs.writeFileSync(file, text);
  return { file, done: () => fs.rmSync(dir, { recursive: true, force: true }) };
};

test("readCliConfigKey reads a top-level key, as the guide's sed one-liner does", () => {
  const f = write('api_key = "rpa_top"\napi_url = "https://api.runpod.io"\n');
  try {
    assert.equal(readCliConfigKey(f.file), "rpa_top");
  } finally {
    f.done();
  }
});

test("readCliConfigKey prefers the profile's table, by name", () => {
  const f = write('# runpod\n[default]\napi_key = "rpa_default"\n\n[work]\napi_key = \'rpa_work\'  # a comment\n');
  try {
    assert.equal(readCliConfigKey(f.file), "rpa_default");
    assert.equal(readCliConfigKey(f.file, "work"), "rpa_work");
    assert.equal(readCliConfigKey(f.file, "nope"), undefined);
  } finally {
    f.done();
  }
});

test("readCliConfigKey takes [profiles.<name>] tables too, and is undefined for no file or no key", () => {
  const f = write('[profiles.default]\napi_key = "rpa_p"\n');
  try {
    assert.equal(readCliConfigKey(f.file), "rpa_p");
  } finally {
    f.done();
  }
  assert.equal(readCliConfigKey(path.join(os.tmpdir(), "no-such-dir-xyz", "config.toml")), undefined);
  const g = write('api_url = "x"\n[default]\napi_key = ""\n');
  try {
    assert.equal(readCliConfigKey(g.file), undefined);
  } finally {
    g.done();
  }
});
