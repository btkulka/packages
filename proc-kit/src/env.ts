// A clean environment for launching Electron.
//
// VS Code's extension host, Claude Code shells, Playwright and Electron apps
// spawning Electron-as-Node all leave ELECTRON_RUN_AS_NODE=1 in the environment.
// A child Electron then starts as plain Node: `require("electron")` returns a
// path instead of the API and main crashes at once ("Cannot read properties of
// undefined (reading 'setAppUserModelId' / 'registerSchemesAsPrivileged')"),
// with no window and nothing in the logs.

/**
 * The variables that make Electron behave like Node, or that only make sense
 * for Electron-as-Node, stripped by `electronEnv`:
 * - ELECTRON_RUN_AS_NODE, and ATOM_SHELL_INTERNAL_RUN_AS_NODE (its old name)
 * - ELECTRON_NO_ATTACH_CONSOLE: hides a dev Electron's console output on Windows
 * - ELECTRON_OVERRIDE_DIST_PATH: points the `electron` package at another binary
 */
export const ELECTRON_ENV_KEYS: readonly string[] = [
  "ELECTRON_RUN_AS_NODE",
  "ATOM_SHELL_INTERNAL_RUN_AS_NODE",
  "ELECTRON_NO_ATTACH_CONSOLE",
  "ELECTRON_OVERRIDE_DIST_PATH",
];

export interface ElectronEnvOptions {
  /** The environment to start from. Default `process.env`. Never modified. */
  env?: NodeJS.ProcessEnv;
  /** More variables to drop (an app's own leftovers, e.g. ELECTRON_RENDERER_URL). */
  remove?: string[];
  /** Variables to set afterwards; `undefined` removes one. */
  set?: Record<string, string | undefined>;
}

/**
 * A copy of the environment with `ELECTRON_ENV_KEYS` (and `remove`) taken out
 * and `set` applied: pass it as `env` when spawning Electron or electron-vite.
 * Names match case-insensitively on Windows, where the environment is.
 */
export function electronEnv(opts: ElectronEnvOptions = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...(opts.env ?? process.env) };
  removeKeys(env, [...ELECTRON_ENV_KEYS, ...(opts.remove ?? [])]);
  for (const [key, value] of Object.entries(opts.set ?? {})) {
    removeKeys(env, [key]); // so `Path` vs `PATH` can't leave two on Windows
    if (value !== undefined) env[key] = value;
  }
  return env;
}

/**
 * Strip `ELECTRON_ENV_KEYS` from `env` in place (default `process.env`), so
 * every later spawn inherits a clean environment. Returns the names it removed,
 * so a launcher can say it found the leak instead of hiding it.
 */
export function stripElectronEnv(env: NodeJS.ProcessEnv = process.env): string[] {
  return removeKeys(env, ELECTRON_ENV_KEYS);
}

function removeKeys(env: NodeJS.ProcessEnv, keys: readonly string[]): string[] {
  const removed: string[] = [];
  const insensitive = process.platform === "win32";
  const wanted = new Set(keys.map((k) => (insensitive ? k.toUpperCase() : k)));
  for (const key of Object.keys(env)) {
    if (!wanted.has(insensitive ? key.toUpperCase() : key)) continue;
    delete env[key];
    removed.push(key);
  }
  return removed;
}
