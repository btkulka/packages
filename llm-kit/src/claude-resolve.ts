/**
 * Finding the claude CLI and spawning it without a shell.
 *
 * On Windows `claude` on PATH is usually an npm shim (claude.cmd) in front of the real program:
 * node_modules\@anthropic-ai\claude-code\bin\claude.exe (current versions) or cli.js run by node
 * (older ones). Node can't spawn a .cmd without a shell (EINVAL since the 2024 batch-file fix), and
 * going through cmd.exe mangles quotes, `%`, `&` and newlines in arguments. So we look through the
 * shim to the program behind it and spawn that directly. Only when a shim can't be read do we fall
 * back to cmd.exe, with cross-spawn's escaping, and refuse arguments that contain newlines.
 */
import { readFileSync, statSync } from "node:fs";
import { posix, win32 } from "node:path";
import { LlmError } from "./errors.js";
import { getEnv } from "./claude-env.js";

/** What to spawn for `claude`: the program, and any arguments that go before claude's own. */
export interface ClaudeCommand {
  command: string;
  /** For an older npm install, the cli.js path node runs. Usually empty. */
  args: string[];
}

export interface ResolveClaudeOptions {
  /** Explicit program (path or name). Used as given, except that a .cmd/.bat on Windows is looked through. */
  bin?: string;
  /** Name of an environment variable that may hold the path (ORSON_CLAUDE_BIN, JOBHUNT_CLAUDE_BIN). Checked after `bin`. */
  envVar?: string;
  /** Environment to read PATH, `envVar` and the home folder from. Default process.env. */
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
}

const NPM_EXE = ["node_modules", "@anthropic-ai", "claude-code", "bin", "claude.exe"];

function isFile(p: string): boolean {
  try {
    return statSync(p, { throwIfNoEntry: false })?.isFile() ?? false;
  } catch {
    return false;
  }
}

const isShim = (p: string) => /\.(cmd|bat)$/i.test(p);

/**
 * The program behind an npm/pnpm/yarn .cmd shim: the quoted .exe, .js or .cmd it runs, with
 * %dp0% / %~dp0 read as the shim's folder. A .js target runs under the node.exe beside the shim
 * (or `node`); a .cmd target is looked through in turn. Null when the shim can't be read or
 * nothing it names exists.
 */
export function resolveCmdShim(shim: string, depth = 0): ClaudeCommand | null {
  if (depth > 3) return null;
  let text: string;
  try {
    text = readFileSync(shim, "utf8");
  } catch {
    return null;
  }
  const dir = win32.dirname(shim);
  const targets = [...text.matchAll(/"([^"\r\n]+?\.(?:exe|cmd|bat|js|cjs|mjs))"/gi)]
    .map((m) => win32.normalize(m[1].replace(/%~?dp0%?/gi, `${dir}\\`)))
    .filter((p) => !/(^|[\\/=])node(\.exe)?$/i.test(p));
  for (const t of targets) {
    if (!isFile(t)) continue;
    if (/\.exe$/i.test(t)) return { command: t, args: [] };
    if (isShim(t)) {
      const inner = resolveCmdShim(t, depth + 1);
      if (inner) return inner;
      continue;
    }
    const node = win32.join(dir, "node.exe");
    return { command: isFile(node) ? node : "node", args: [t] };
  }
  return null;
}

/**
 * Where the claude CLI is. In order: `bin`; the `envVar` variable; then on Windows each PATH
 * folder's claude.exe or the claude.exe inside an npm install there, then a claude.cmd shim
 * (looked through), then %USERPROFILE%\.local\bin\claude.exe (the native installer); on POSIX
 * `claude` on PATH, then ~/.local/bin/claude and ~/.claude/local/claude. Throws a `not-found`
 * LlmError naming `envVar` when there is none.
 */
export function resolveClaudeCommand(opts: ResolveClaudeOptions = {}): ClaudeCommand {
  const env = opts.env ?? process.env;
  const platform = opts.platform ?? process.platform;
  const windows = platform === "win32";
  const path = windows ? win32 : posix;

  const explicit = opts.bin ?? (opts.envVar ? getEnv(env, opts.envVar, platform) : undefined);
  if (explicit) {
    if (windows && isShim(explicit)) return resolveCmdShim(explicit) ?? { command: explicit, args: [] };
    return { command: explicit, args: [] };
  }

  const dirs = (getEnv(env, "PATH", platform) ?? "")
    .split(windows ? ";" : ":")
    .map((d) => d.trim().replace(/^"(.*)"$/, "$1"))
    .filter(Boolean);
  const home = getEnv(env, windows ? "USERPROFILE" : "HOME", platform);

  if (windows) {
    for (const dir of dirs) {
      for (const p of [path.join(dir, "claude.exe"), path.join(dir, ...NPM_EXE)]) if (isFile(p)) return { command: p, args: [] };
    }
    for (const dir of dirs) {
      const shim = path.join(dir, "claude.cmd");
      if (isFile(shim)) return resolveCmdShim(shim) ?? { command: shim, args: [] };
    }
    if (home && isFile(path.join(home, ".local", "bin", "claude.exe"))) return { command: path.join(home, ".local", "bin", "claude.exe"), args: [] };
  } else {
    for (const dir of dirs) if (isFile(path.join(dir, "claude"))) return { command: path.join(dir, "claude"), args: [] };
    for (const p of home ? [path.join(home, ".local", "bin", "claude"), path.join(home, ".claude", "local", "claude")] : []) {
      if (isFile(p)) return { command: p, args: [] };
    }
  }
  throw new LlmError(
    "not-found",
    `cannot find the \`claude\` CLI on PATH. Install Claude Code${opts.envVar ? ` or set ${opts.envVar} to its path` : ""}.`,
  );
}

// ---------- the cmd.exe fallback, escaped the way cross-spawn does it ----------

const CMD_META = /([()\][%!^"`<>&|;, *?])/g;

/** One argument for a cmd.exe command line that runs a .cmd shim (escaped twice: the shim's %* re-parses it). */
export function escapeCmdArg(arg: string): string {
  let a = arg.replace(/(?=(\\+?)?)\1"/g, '$1$1\\"').replace(/(?=(\\+?)?)\1$/, "$1$1");
  a = `"${a}"`;
  return a.replace(CMD_META, "^$1").replace(CMD_META, "^$1");
}

export interface SpawnSpec {
  file: string;
  args: string[];
  /** Pass to spawn as windowsVerbatimArguments (the cmd.exe fallback quotes for itself). */
  verbatim: boolean;
}

/**
 * What to actually spawn for a resolved command plus claude's arguments. Direct for a program;
 * through `cmd.exe /d /s /c` for a .cmd that couldn't be looked through, where an argument with a
 * newline can't survive, so that throws a `spawn` LlmError (send the prompt over stdin instead).
 */
export function spawnSpec(cmd: ClaudeCommand, args: string[], opts: { env?: NodeJS.ProcessEnv; platform?: NodeJS.Platform } = {}): SpawnSpec {
  const platform = opts.platform ?? process.platform;
  const all = [...cmd.args, ...args];
  if (platform !== "win32" || !isShim(cmd.command)) return { file: cmd.command, args: all, verbatim: false };
  if (all.some((a) => /[\r\n]/.test(a))) {
    throw new LlmError(
      "spawn",
      `${cmd.command} is a shim that has to run through cmd.exe, which can't pass an argument containing a newline. Point the claude path at claude.exe, or send the text over stdin.`,
    );
  }
  const line = [win32.normalize(cmd.command).replace(CMD_META, "^$1"), ...all.map(escapeCmdArg)].join(" ");
  const comspec = getEnv(opts.env ?? process.env, "ComSpec", platform) ?? "cmd.exe";
  return { file: comspec, args: ["/d", "/s", "/c", `"${line}"`], verbatim: true };
}
