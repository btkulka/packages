#!/usr/bin/env node
// gemini-video: the CLI's entry. Node-only; `gemini-video --help` for usage (src/cli/run.ts).
// Ctrl+C stops waiting (clips in flight keep their ids for the next run); a second Ctrl+C quits at once.

import { run } from "./run.js";

const controller = new AbortController();
let stops = 0;
process.on("SIGINT", () => {
  if (++stops > 1) process.exit(130);
  process.stderr.write("\nStopping: clips already started carry on at Google; run the same command again to pick them up. Ctrl+C again to quit now.\n");
  controller.abort();
});

run(process.argv.slice(2), {
  out: (line) => process.stdout.write(`${line}\n`),
  err: (line) => process.stderr.write(`${line}\n`),
  signal: controller.signal,
}).then(
  (code) => {
    process.exitCode = stops ? 130 : code;
  },
  (err: unknown) => {
    process.stderr.write(`${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
    process.exitCode = 1;
  },
);
