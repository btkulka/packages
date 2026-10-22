/**
 * Environment for a claude child process. An app started from a Claude Code shell (or as
 * Electron-run-as-Node) carries variables that belong to that session, not to the child:
 * CLAUDECODE makes a nested claude think it's inside another session, CLAUDE_CODE_SSE_PORT points
 * it at the parent's IDE bridge. benhaus's Claude panel strips the same list.
 */

/** Dropped from the inherited environment unless a call keeps them. */
export const INHERITED_SESSION_ENV_KEYS: readonly string[] = ["CLAUDECODE", "CLAUDE_CODE_ENTRYPOINT", "CLAUDE_CODE_SSE_PORT", "ELECTRON_RUN_AS_NODE"];

const isWin = (platform: NodeJS.Platform) => platform === "win32";

/** Reads `name` from an env object, ignoring case on Windows (where "Path" and "PATH" are one variable). */
export function getEnv(env: NodeJS.ProcessEnv, name: string, platform: NodeJS.Platform = process.platform): string | undefined {
  if (!isWin(platform)) return env[name];
  if (env[name] !== undefined) return env[name];
  const key = Object.keys(env).find((k) => k.toUpperCase() === name.toUpperCase());
  return key === undefined ? undefined : env[key];
}

function setEnv(env: NodeJS.ProcessEnv, name: string, value: string | undefined, platform: NodeJS.Platform) {
  if (isWin(platform)) {
    for (const k of Object.keys(env)) if (k.toUpperCase() === name.toUpperCase()) delete env[k];
  } else {
    delete env[name];
  }
  if (value !== undefined) env[name] = value;
}

export interface ClaudeEnvOptions {
  /** Inherited environment. Default process.env. */
  base?: NodeJS.ProcessEnv;
  /** Keep CLAUDECODE and the rest of INHERITED_SESSION_ENV_KEYS. Default false. */
  keepSessionEnv?: boolean;
  platform?: NodeJS.Platform;
}

/**
 * A copy of the inherited environment for a claude child: the session variables removed (unless
 * kept), then `extra` laid over it. An `undefined` value in `extra` removes that variable. Case is
 * ignored on Windows, so `extra.PATH` replaces an inherited `Path` instead of duplicating it.
 */
export function claudeEnv(extra: Record<string, string | undefined> = {}, opts: ClaudeEnvOptions = {}): NodeJS.ProcessEnv {
  const platform = opts.platform ?? process.platform;
  const env: NodeJS.ProcessEnv = { ...(opts.base ?? process.env) };
  if (!opts.keepSessionEnv) for (const k of INHERITED_SESSION_ENV_KEYS) setEnv(env, k, undefined, platform);
  for (const [k, v] of Object.entries(extra)) setEnv(env, k, v, platform);
  return env;
}
