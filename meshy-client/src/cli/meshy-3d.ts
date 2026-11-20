#!/usr/bin/env node
// meshy-3d: the CLI's entry. Node-only; `meshy-3d --help` for usage (src/cli/run.ts).
// Ctrl+C starts no new tasks and waits for the running ones (they're already paid for) to finish and be saved; a
// second Ctrl+C quits at once, and the next run picks those tasks up from <out>/.meshy/ without paying again.

import { runMeshy } from "./run.js";

const controller = new AbortController();
let stops = 0;
process.on("SIGINT", () => {
  if (++stops > 1) process.exit(130);
  process.stderr.write("\nNo new tasks; waiting for the running ones (already paid for). Ctrl+C again to quit now (the next run picks them up).\n");
  controller.abort();
});

runMeshy(process.argv.slice(2), {
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
