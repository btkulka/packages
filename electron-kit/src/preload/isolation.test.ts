// The preload and the root entry end up inside sandboxed preloads and
// renderers. Walk their compiled import graphs (ESM and CommonJS) and make
// sure they reach nothing from main, no Node built-ins and no other package.
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { describe, test } from "node:test";

// npm test runs from the package folder.
const dist = resolve(process.cwd(), "dist");

function graph(entry: string): { files: string[]; bad: string[] } {
  const files: string[] = [];
  const bad: string[] = [];
  const queue = [entry];
  while (queue.length) {
    const file = queue.pop()!;
    if (files.includes(file)) continue;
    files.push(file);
    const code = readFileSync(file, "utf8");
    const specs = [...code.matchAll(/(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*|^\s*import\s+)["']([^"']+)["']/gm)].map((m) => m[1]!);
    for (const spec of specs) {
      if (!spec.startsWith(".")) {
        bad.push(`${relative(dist, file)} imports "${spec}"`);
        continue;
      }
      const target = resolve(dirname(file), spec);
      if (target.includes(`${sep}main${sep}`)) bad.push(`${relative(dist, file)} reaches main code: ${spec}`);
      queue.push(target);
    }
  }
  return { files, bad };
}

describe("process isolation", () => {
  for (const build of ["esm", "cjs"]) {
    for (const entry of ["preload/index.js", "index.js"]) {
      test(`${build}/${entry} reaches only its own browser-safe files`, (t) => {
        const file = join(dist, build, entry);
        if (!existsSync(file)) return t.skip(`${file} not built`);
        const { files, bad } = graph(file);
        assert.deepEqual(bad, []);
        assert.ok(files.length >= 1);
      });
    }
  }
});
