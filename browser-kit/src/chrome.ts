// Finding the installed Google Chrome and starting it with a DevTools port and a profile of its own.
import { spawn as nodeSpawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { findExecutable } from "@btkulka/proc-kit";
import { devToolsEndpoint, discoverDevTools, waitForDevTools, type DevToolsInfo, type FetchLike } from "./devtools.js";

type Env = Record<string, string | undefined>;

/**
 * Where Chrome is installed, per platform: the union of the paths Ben's apps looked in. Paths under the user's
 * folders are filled from the environment (LOCALAPPDATA, HOME) by `chromeCandidates`.
 */
export function chromeCandidates(opts: { platform?: NodeJS.Platform; env?: Env; edge?: boolean; chromium?: boolean } = {}): string[] {
  const platform = opts.platform ?? process.platform;
  const env = opts.env ?? process.env;
  const out: string[] = [];
  if (platform === "win32") {
    const pf = env.ProgramFiles || env.PROGRAMFILES || "C:\\Program Files";
    const pf86 = env["ProgramFiles(x86)"] || env["PROGRAMFILES(X86)"] || "C:\\Program Files (x86)";
    out.push(join(pf, "Google", "Chrome", "Application", "chrome.exe"), join(pf86, "Google", "Chrome", "Application", "chrome.exe"));
    if (env.LOCALAPPDATA) out.push(join(env.LOCALAPPDATA, "Google", "Chrome", "Application", "chrome.exe"));
    if (opts.chromium !== false && env.LOCALAPPDATA) out.push(join(env.LOCALAPPDATA, "Chromium", "Application", "chrome.exe"));
    if (opts.edge) out.push(join(pf86, "Microsoft", "Edge", "Application", "msedge.exe"), join(pf, "Microsoft", "Edge", "Application", "msedge.exe"));
  } else if (platform === "darwin") {
    out.push("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome");
    if (env.HOME) out.push(join(env.HOME, "Applications", "Google Chrome.app", "Contents", "MacOS", "Google Chrome"));
    if (opts.chromium !== false) out.push("/Applications/Chromium.app/Contents/MacOS/Chromium");
    if (opts.edge) out.push("/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge");
  } else {
    out.push("/usr/bin/google-chrome", "/usr/bin/google-chrome-stable", "/opt/google/chrome/chrome");
    if (opts.chromium !== false) out.push("/usr/bin/chromium", "/usr/bin/chromium-browser", "/snap/bin/chromium");
    if (opts.edge) out.push("/usr/bin/microsoft-edge", "/usr/bin/microsoft-edge-stable");
  }
  return out;
}

export interface FindChromeOptions {
  /** A path the app already has (its own setting or env var). Used when it exists. */
  override?: string | null;
  /** Environment variables naming the binary, checked in order. Default CHROME_PATH, then CHROME. */
  envVars?: string[];
  env?: Env;
  platform?: NodeJS.Platform;
  /** Look on PATH too (chrome, google-chrome, chromium…). Default true. */
  path?: boolean;
  /** Accept Microsoft Edge when no Chrome is found. Default false. */
  edge?: boolean;
  /** Accept Chromium. Default true. */
  chromium?: boolean;
  /** Replaces the file-exists check, for tests. */
  exists?: (path: string) => boolean;
}

/** The Chrome binary to run: the override, an env var, the usual install paths, then PATH. Null when none. */
export function findChrome(opts: FindChromeOptions = {}): string | null {
  const env = opts.env ?? process.env;
  const exists = opts.exists ?? existsSync;
  if (opts.override && exists(opts.override)) return opts.override;
  for (const name of opts.envVars ?? ["CHROME_PATH", "CHROME"]) {
    const v = env[name];
    if (v && exists(v)) return v;
  }
  const platform = opts.platform ?? process.platform;
  const hit = chromeCandidates({ platform, env, edge: opts.edge, chromium: opts.chromium }).find((p) => exists(p));
  if (hit) return hit;
  if (opts.path !== false && !opts.exists) {
    const names = platform === "win32" ? ["chrome"] : ["google-chrome", "google-chrome-stable", "chrome"];
    if (opts.chromium !== false) names.push("chromium", "chromium-browser");
    if (opts.edge) names.push(platform === "win32" ? "msedge" : "microsoft-edge");
    for (const n of names) {
      const p = findExecutable(n);
      if (p) return p;
    }
  }
  return null;
}

export interface LaunchChromeOptions {
  /** The profile folder. Created when missing. Chrome locks it: one running Chrome per profile. */
  userDataDir: string;
  /** DevTools port. Default 9222. */
  port?: number;
  /** The binary. Default `findChrome()`. */
  executablePath?: string;
  /** Pages to open. Default about:blank. */
  urls?: string[];
  /** More flags. */
  args?: string[];
  /** `--headless=new`. */
  headless?: boolean;
  /** `--new-window`. Default true. */
  newWindow?: boolean;
  /** Outlive this process (detached, stdio ignored, unref'd). Default true. */
  detached?: boolean;
  /** Wait this long for DevTools to answer. Default 15000; 0 returns at once. */
  waitMs?: number;
  host?: string;
  fetch?: FetchLike;
  /** Replaces child_process.spawn, for tests. */
  spawn?: (command: string, args: string[], options: SpawnOptions) => ChildProcess;
}

export interface LaunchedChrome {
  pid: number | undefined;
  port: number;
  /** http://127.0.0.1:<port> */
  endpoint: string;
  /** What /json/version said, or null when it didn't answer in `waitMs` (or `waitMs` was 0). */
  devtools: DevToolsInfo | null;
  executablePath: string;
  args: string[];
  child: ChildProcess;
}

/** The flags `launchChrome` passes, in order. */
export function chromeArgs(opts: Pick<LaunchChromeOptions, "port" | "userDataDir" | "urls" | "args" | "headless" | "newWindow">): string[] {
  const args = [
    `--remote-debugging-port=${opts.port ?? 9222}`,
    `--user-data-dir=${opts.userDataDir}`,
    "--no-first-run",
    "--no-default-browser-check",
  ];
  if (opts.headless) args.push("--headless=new", "--disable-gpu");
  if (opts.newWindow !== false && !opts.headless) args.push("--new-window");
  args.push(...(opts.args ?? []));
  args.push(...(opts.urls?.length ? opts.urls : ["about:blank"]));
  return args;
}

/** Start Chrome on a profile with a DevTools port, and (by default) wait until DevTools answers. */
export async function launchChrome(opts: LaunchChromeOptions): Promise<LaunchedChrome> {
  const executablePath = opts.executablePath ?? findChrome();
  if (!executablePath) throw new Error("Chrome was not found in the usual places. Set CHROME_PATH to the Chrome binary, or pass executablePath.");
  const port = opts.port ?? 9222;
  mkdirSync(opts.userDataDir, { recursive: true });
  const args = chromeArgs({ ...opts, port });
  const detached = opts.detached !== false;
  const child = (opts.spawn ?? nodeSpawn)(executablePath, args, detached ? { detached: true, stdio: "ignore", windowsHide: false } : { stdio: "ignore" });
  if (detached) child.unref();
  const endpoint = devToolsEndpoint(port, opts.host);
  const waitMs = opts.waitMs ?? 15_000;
  const devtools = waitMs > 0 ? await waitForDevTools(endpoint, { waitMs, fetch: opts.fetch }) : null;
  return { pid: child.pid, port, endpoint, devtools, executablePath, args, child };
}

export interface EnsureChromeOptions extends LaunchChromeOptions {}

/** The Chrome already answering on the port, or a new one started with `launchChrome`. */
export async function ensureChrome(opts: EnsureChromeOptions): Promise<{ started: boolean; endpoint: string; devtools: DevToolsInfo | null; launched?: LaunchedChrome }> {
  const endpoint = devToolsEndpoint(opts.port ?? 9222, opts.host);
  const found = await discoverDevTools(endpoint, { fetch: opts.fetch });
  if (found) return { started: false, endpoint, devtools: found };
  const launched = await launchChrome(opts);
  return { started: true, endpoint, devtools: launched.devtools, launched };
}
