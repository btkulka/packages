// packageBin: the JavaScript file behind an npm package's command, to run with
// `process.execPath` instead of through its node_modules/.bin shim.
//
// On Windows the shim is a .cmd, which Node won't spawn without a shell (EINVAL
// since the 2024 batch-file fix), and a shell means quoting trouble and an
// extra cmd.exe in the process tree. Running the JS file with this Node (or
// this Electron as Node) needs neither, and needs no PATH.

import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

export interface PackageBinOptions {
  /** Where to start looking for node_modules, walking up. Default `process.cwd()`. */
  from?: string;
  /** Which command, for a package that has several. Default the one named after the package. */
  bin?: string;
}

/**
 * Absolute path of the file `pkg`'s `bin` points at, found the way Node finds
 * packages: node_modules/<pkg> in `from`, then each parent folder. Throws when
 * the package or the command isn't there.
 *
 * Pass the app's own folder as `from` when the cwd may be elsewhere. (This
 * package can't resolve it from its own location: linked, it sits in
 * D:\source\packages, whose node_modules isn't the app's.)
 *
 * @example runAndExit(process.execPath, [packageBin("electron-vite", { from: root }), "dev"], { env: electronEnv() })
 */
export function packageBin(pkg: string, opts: PackageBinOptions = {}): string {
  const start = resolve(opts.from ?? process.cwd());
  for (let dir = start; ; dir = dirname(dir)) {
    const manifest = join(dir, "node_modules", ...pkg.split("/"), "package.json");
    if (existsSync(manifest)) return binOf(manifest, pkg, opts.bin);
    if (dirname(dir) === dir) break;
  }
  throw new Error(`${pkg} isn't installed in ${start} or any folder above it (run npm install there)`);
}

function binOf(manifest: string, pkg: string, which?: string): string {
  const json = JSON.parse(readFileSync(manifest, "utf8")) as { bin?: string | Record<string, string> };
  const unscoped = pkg.replace(/^@[^/]+\//, "");
  let rel: string | undefined;
  if (typeof json.bin === "string") {
    if (!which || which === unscoped) rel = json.bin;
  } else if (json.bin && typeof json.bin === "object") {
    const names = Object.keys(json.bin);
    rel = json.bin[which ?? unscoped] ?? (which ? undefined : names.length === 1 ? json.bin[names[0]] : undefined);
  }
  if (!rel) throw new Error(`${pkg} has no command${which ? ` named ${which}` : ""} in its package.json bin`);
  return join(dirname(manifest), rel);
}
