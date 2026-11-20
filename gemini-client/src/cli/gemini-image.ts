#!/usr/bin/env node
// gemini-image: the image CLI's entry. Node-only; `gemini-image --help` for usage (src/cli/image-run.ts).
// Ctrl+C stops after the image being drawn (it's already paid for); a second Ctrl+C quits at once.

import { runImage } from "./image-run.js";

const controller = new AbortController();
let stops = 0;
process.on("SIGINT", () => {
  if (++stops > 1) process.exit(130);
  process.stderr.write("\nStopping after this image. Ctrl+C again to quit now.\n");
  controller.abort();
});

runImage(process.argv.slice(2), {
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
